use std::collections::HashMap;

use aws_sdk_dynamodb::{
    Client,
    types::{AttributeValue, ConditionCheck, Put, TransactWriteItem},
};
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::{
    lifecycle::{Failure, timestamp},
    store::{attribute, document},
};

use super::{RegionalCommand, RegionalOperation, required};

type Item = HashMap<String, AttributeValue>;
const HOLD: &str = "moderationHolds";
const AUDIT: &str = "auditEvents";
const CREATOR_FENCE: &str = "__ubeeq_repository_snapshot#creators";
const GLOBAL: &str = "__ubeeq_repository_snapshot#global-v2";

fn key(pk: String, sk: &str) -> Item {
    HashMap::from([
        ("pk".into(), AttributeValue::S(pk)),
        ("sk".into(), AttributeValue::S(sk.into())),
    ])
}

fn record_key(repository: &str, id: &str) -> Item {
    key(format!("{repository}#{id}"), "record")
}

fn record_item(repository: &str, value: &Value) -> Result<Item, Failure> {
    let id = required(value, "id")?;
    let revision = value["revision"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("Missing regional record revision.")?;
    let mut item = record_key(repository, id);
    item.extend([
        ("repository".into(), AttributeValue::S(repository.into())),
        ("id".into(), AttributeValue::S(id.into())),
        ("revision".into(), AttributeValue::N(revision.to_string())),
        ("value".into(), attribute(value)),
    ]);
    Ok(item)
}

fn stamp(record: &mut Value) -> Result<(), Failure> {
    let now = timestamp(OffsetDateTime::now_utc())?;
    record["revision"] = json!(1);
    record["createdAt"] = json!(now);
    record["updatedAt"] = json!(now);
    Ok(())
}

pub struct RegionalStore {
    client: Client,
    table: String,
    pub(super) instance: String,
    pub(super) cell: String,
    pub(super) region: String,
}

impl RegionalStore {
    pub fn new(
        client: Client,
        table: String,
        instance: String,
        cell: String,
        region: String,
    ) -> Self {
        Self {
            client,
            table,
            instance,
            cell,
            region,
        }
    }

    async fn get(&self, key: Item) -> Result<Option<Item>, Failure> {
        Ok(self
            .client
            .get_item()
            .table_name(&self.table)
            .set_key(Some(key))
            .consistent_read(true)
            .send()
            .await?
            .item)
    }

    async fn marker(&self, name: &str) -> Result<Option<String>, Failure> {
        self.get(key(name.into(), "fence"))
            .await?
            .map(|item| {
                item.get("version")
                    .and_then(|v| v.as_s().ok())
                    .filter(|v| !v.is_empty())
                    .cloned()
                    .ok_or_else(|| "Repository snapshot marker requires reconciliation.".into())
            })
            .transpose()
    }

    pub(super) async fn record(
        &self,
        repository: &str,
        id: &str,
    ) -> Result<Option<Value>, Failure> {
        let Some(mut item) = self.get(record_key(repository, id)).await? else {
            return Ok(None);
        };
        let value = document(
            item.remove("value")
                .ok_or("Missing regional repository document.")?,
        )?;
        let revision = value["revision"]
            .as_u64()
            .filter(|value| *value > 0)
            .ok_or("Missing regional record revision.")?;
        let matches = |name: &str, expected: &str| {
            item.get(name)
                .and_then(|v| v.as_s().ok())
                .is_some_and(|value| value == expected)
        };
        if !matches("repository", repository)
            || !matches("id", id)
            || value["id"] != id
            || item
                .get("revision")
                .and_then(|v| v.as_n().ok())
                .and_then(|n| n.parse::<u64>().ok())
                != Some(revision)
            || !self.owns(&value)
        {
            return Err("Regional repository record conflicts with the cell or revision.".into());
        }
        Ok(Some(value))
    }

    pub(super) async fn records(&self, repository: &str) -> Result<Vec<Value>, Failure> {
        let mut cursor = None;
        let mut records = Vec::new();
        loop {
            let output = self
                .client
                .query()
                .table_name(&self.table)
                .index_name("repository-id-index")
                .key_condition_expression("#repository = :repository")
                .expression_attribute_names("#repository", "repository")
                .expression_attribute_values(":repository", AttributeValue::S(repository.into()))
                .set_exclusive_start_key(cursor)
                .limit(100)
                .send()
                .await?;
            for mut item in output.items.unwrap_or_default() {
                let value = document(
                    item.remove("value")
                        .ok_or("Missing regional repository document.")?,
                )?;
                if self.owns(&value) {
                    let expected = record_item(repository, &value)?;
                    if ["id", "pk", "sk", "repository", "revision"]
                        .iter()
                        .any(|field| item.get(*field) != expected.get(*field))
                    {
                        return Err("Regional repository record envelope conflicts.".into());
                    }
                    records.push(value);
                }
            }
            cursor = output.last_evaluated_key.filter(|key| !key.is_empty());
            if cursor.is_none() {
                break;
            }
        }
        Ok(records)
    }

    pub(super) fn owns(&self, value: &Value) -> bool {
        value["instanceId"] == self.instance
            && value["homeCellId"] == self.cell
            && value["dataHomeRegion"] == self.region
    }

    pub async fn apply_metadata(&self, command: &RegionalCommand) -> Result<(), Failure> {
        let source = &command.checkpoint["source"];
        let destination = &command.checkpoint["destination"];
        let (cell, region) = match command.operation {
            RegionalOperation::SourceHold | RegionalOperation::SourceRelease => {
                (&source["homeCellId"], &source["homeRegion"])
            }
            RegionalOperation::Enable | RegionalOperation::Rollback => {
                (&destination["cellId"], &destination["region"])
            }
            _ => return Err("Regional command requires the asset or retirement port.".into()),
        };
        if cell != &self.cell || region != &self.region {
            return Err("Regional metadata store does not own this command.".into());
        }
        match command.operation {
            RegionalOperation::SourceHold => self.hold(command).await,
            RegionalOperation::SourceRelease => self.release(command).await,
            RegionalOperation::Enable | RegionalOperation::Rollback => self.audit(command).await,
            _ => unreachable!("operation checked above"),
        }
    }

    async fn hold(&self, command: &RegionalCommand) -> Result<(), Failure> {
        let id = command.hold_id();
        let prior = self.record(HOLD, &id).await?;
        if let Some(value) = prior {
            self.require_hold(command, &value)?;
            return if value["state"] == "active" {
                Ok(())
            } else {
                Err("A released migration hold cannot be reacquired.".into())
            };
        }
        let creator_fence = self.marker(CREATOR_FENCE).await?;
        let creator = self
            .record("creators", command.creator())
            .await?
            .ok_or("Migration creator is not owned by the source cell.")?;
        if creator["routingRevision"] != command.checkpoint["source"]["routingRevision"] {
            return Err("Migration source creator revision changed.".into());
        }
        let creator_revision = creator["revision"]
            .as_u64()
            .ok_or("Missing creator revision.")?;
        let mut record = json!({
            "id":id,"instanceId":self.instance,"homeCellId":self.cell,"dataHomeRegion":self.region,
            "dataHomeAssignedAt":required(&creator,"dataHomeAssignedAt")?,
            "routingRevision":creator["routingRevision"],
            "subjectType":"creator","subjectId":command.creator(),
            "state":"active","reason":command.hold_reason(),
        });
        stamp(&mut record)?;
        self.write_guarded(
            HOLD,
            &record,
            None,
            Some((command.creator(), creator_revision, creator_fence)),
        )
        .await
    }

    pub(super) fn require_hold(
        &self,
        command: &RegionalCommand,
        value: &Value,
    ) -> Result<(), Failure> {
        if value["subjectType"] != "creator"
            || value["subjectId"] != command.creator()
            || value["reason"] != command.hold_reason()
            || !self.owns(value)
            || value["routingRevision"] != command.checkpoint["source"]["routingRevision"]
        {
            return Err("Retained migration hold does not match this command.".into());
        }
        Ok(())
    }

    async fn release(&self, command: &RegionalCommand) -> Result<(), Failure> {
        let Some(mut hold) = self.record(HOLD, &command.hold_id()).await? else {
            return Ok(());
        };
        self.require_hold(command, &hold)?;
        match hold["state"].as_str() {
            Some("released") => return Ok(()),
            Some("active") => {}
            _ => return Err("Migration hold state requires reconciliation.".into()),
        }
        let previous = hold["revision"].as_u64().ok_or("Missing hold revision.")?;
        hold["revision"] = json!(previous.checked_add(1).ok_or("Hold revision exhausted.")?);
        hold["state"] = json!("released");
        hold["updatedAt"] = json!(timestamp(OffsetDateTime::now_utc())?);
        self.write_guarded(HOLD, &hold, Some(previous), None).await
    }

    async fn write_guarded(
        &self,
        repository: &str,
        record: &Value,
        previous: Option<u64>,
        creator: Option<(&str, u64, Option<String>)>,
    ) -> Result<(), Failure> {
        let marker_key = format!("__ubeeq_repository_snapshot#{repository}");
        let mut fence = key(marker_key.clone(), "fence");
        let old_marker = self.marker(&marker_key).await?;
        fence.insert(
            "version".into(),
            AttributeValue::S(Uuid::new_v4().to_string()),
        );
        let marker = Put::builder().table_name(&self.table).set_item(Some(fence));
        let marker = if let Some(old) = old_marker {
            marker
                .condition_expression("#version = :old")
                .expression_attribute_names("#version", "version")
                .expression_attribute_values(":old", AttributeValue::S(old))
        } else {
            marker.condition_expression("attribute_not_exists(pk)")
        };

        let hold = Put::builder()
            .table_name(&self.table)
            .set_item(Some(record_item(repository, record)?));
        let hold = if let Some(revision) = previous {
            hold.condition_expression("#revision = :old")
                .expression_attribute_names("#revision", "revision")
                .expression_attribute_values(":old", AttributeValue::N(revision.to_string()))
        } else {
            hold.condition_expression("attribute_not_exists(pk)")
        };

        // The legacy regional writer must never mutate a global-v2 table.
        let protocol = ConditionCheck::builder()
            .table_name(&self.table)
            .set_key(Some(key(GLOBAL.into(), "fence")))
            .condition_expression("attribute_not_exists(pk)")
            .build()?;
        let mut transaction = self
            .client
            .transact_write_items()
            .transact_items(
                TransactWriteItem::builder()
                    .condition_check(protocol)
                    .build(),
            )
            .transact_items(TransactWriteItem::builder().put(marker.build()?).build())
            .transact_items(TransactWriteItem::builder().put(hold.build()?).build());
        if let Some((creator, revision, marker)) = creator {
            let check_marker = ConditionCheck::builder()
                .table_name(&self.table)
                .set_key(Some(key(CREATOR_FENCE.into(), "fence")));
            let check_marker = if let Some(marker) = marker {
                check_marker
                    .condition_expression("#version = :old")
                    .expression_attribute_names("#version", "version")
                    .expression_attribute_values(":old", AttributeValue::S(marker))
            } else {
                check_marker.condition_expression("attribute_not_exists(pk)")
            };
            transaction = transaction.transact_items(
                TransactWriteItem::builder()
                    .condition_check(check_marker.build()?)
                    .build(),
            );
            let check = ConditionCheck::builder()
                .table_name(&self.table)
                .set_key(Some(record_key("creators", creator)))
                .condition_expression("#revision = :old")
                .expression_attribute_names("#revision", "revision")
                .expression_attribute_values(":old", AttributeValue::N(revision.to_string()))
                .build()?;
            transaction = transaction
                .transact_items(TransactWriteItem::builder().condition_check(check).build());
        }
        transaction.send().await?;
        Ok(())
    }

    pub(super) async fn create_imported(
        &self,
        repository: &str,
        mut record: Value,
    ) -> Result<(), Failure> {
        if !self.owns(&record) {
            return Err("Imported record is outside the destination cell.".into());
        }
        let id = required(&record, "id")?.to_owned();
        if let Some(existing) = self.record(repository, &id).await? {
            let equal = record
                .as_object()
                .ok_or("Invalid imported record.")?
                .iter()
                .all(|(key, value)| existing[key] == *value);
            return if equal {
                Ok(())
            } else {
                Err("Existing destination record conflicts with migration import.".into())
            };
        }
        stamp(&mut record)?;
        if ["creators", "assets", "publications", HOLD].contains(&repository) {
            self.write_guarded(repository, &record, None, None).await
        } else {
            self.client
                .put_item()
                .table_name(&self.table)
                .set_item(Some(record_item(repository, &record)?))
                .condition_expression("attribute_not_exists(pk)")
                .send()
                .await?;
            Ok(())
        }
    }

    async fn audit(&self, command: &RegionalCommand) -> Result<(), Failure> {
        let mut record = command.destination_audit(&self.instance)?;
        let id = required(&record, "id")?.to_owned();
        if let Some(existing) = self.record(AUDIT, &id).await? {
            let same = record
                .as_object()
                .ok_or("Invalid migration audit record.")?
                .iter()
                .all(|(key, value)| existing[key] == *value);
            return if same {
                Ok(())
            } else {
                Err("Existing migration audit evidence conflicts.".into())
            };
        }
        stamp(&mut record)?;
        self.client
            .put_item()
            .table_name(&self.table)
            .set_item(Some(record_item(AUDIT, &record)?))
            .condition_expression("attribute_not_exists(pk)")
            .send()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_existing_revisioned_repository_envelope() {
        let value = json!({"id":"migration-hold:test","revision":2,"state":"released"});
        let item = record_item(HOLD, &value).unwrap();
        assert_eq!(
            item["pk"],
            AttributeValue::S("moderationHolds#migration-hold:test".into())
        );
        assert_eq!(item["sk"], AttributeValue::S("record".into()));
        assert_eq!(item["revision"], AttributeValue::N("2".into()));
        assert_eq!(document(item["value"].clone()).unwrap(), value);
    }
}
