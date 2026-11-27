use std::collections::HashMap;

use aws_sdk_dynamodb::{Client, types::AttributeValue};
use serde_json::Value;

use crate::lifecycle::Failure;

pub fn document(value: AttributeValue) -> Result<Value, Failure> {
    Ok(match value {
        AttributeValue::S(value) => Value::String(value),
        AttributeValue::N(value) => Value::Number(value.parse()?),
        AttributeValue::Bool(value) => Value::Bool(value),
        AttributeValue::Null(true) => Value::Null,
        AttributeValue::L(values) => {
            Value::Array(values.into_iter().map(document).collect::<Result<_, _>>()?)
        }
        AttributeValue::M(values) => Value::Object(
            values
                .into_iter()
                .map(|(k, v)| Ok((k, document(v)?)))
                .collect::<Result<_, Failure>>()?,
        ),
        _ => return Err("Unsupported control-plane attribute.".into()),
    })
}

pub(crate) fn attribute(value: &Value) -> AttributeValue {
    match value {
        Value::Null => AttributeValue::Null(true),
        Value::Bool(value) => AttributeValue::Bool(*value),
        Value::Number(value) => AttributeValue::N(value.to_string()),
        Value::String(value) => AttributeValue::S(value.clone()),
        Value::Array(values) => AttributeValue::L(values.iter().map(attribute).collect()),
        Value::Object(fields) => AttributeValue::M(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), attribute(value)))
                .collect(),
        ),
    }
}

fn key(pk: &str, sk: &str) -> HashMap<String, AttributeValue> {
    HashMap::from([
        ("pk".into(), AttributeValue::S(pk.into())),
        ("sk".into(), AttributeValue::S(sk.into())),
    ])
}

fn required<'a>(document: &'a Value, key: &str) -> Result<&'a str, Failure> {
    document[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Missing control-plane field {key}.").into())
}

pub fn migration_cursor(input: &str) -> Result<HashMap<String, AttributeValue>, Failure> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let value: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(input)?)?;
    let sk = value["sk"].as_str().filter(|sk| !sk.is_empty());
    match sk {
        Some(sk)
            if value["pk"] == "migration"
                && value.as_object().is_some_and(|object| object.len() == 2) =>
        {
            Ok(key("migration", sk))
        }
        _ => Err("Invalid control-plane cursor.".into()),
    }
}

fn migration_matches(value: &Value, creator: &str) -> Result<bool, Failure> {
    if value["creatorId"].as_str() != Some(creator) {
        return Ok(false);
    }
    let source = &value["source"];
    let destination = &value["destination"];
    let nonempty = |value: &Value| value.as_str().is_some_and(|text| !text.trim().is_empty());
    let valid_endpoint = |value: &Value| {
        value
            .as_str()
            .and_then(|endpoint| url::Url::parse(endpoint).ok())
            .is_some_and(|url| {
                url.scheme() == "https"
                    && url.path() == "/"
                    && url.username().is_empty()
                    && url.password().is_none()
            })
    };
    let valid = [
        &value["id"],
        &source["homeCellId"],
        &source["homeRegion"],
        &destination["cellId"],
        &destination["region"],
    ]
    .into_iter()
    .all(nonempty)
        && source["homeCellId"] != destination["cellId"]
        && source["routingRevision"]
            .as_u64()
            .is_some_and(|revision| (1..=9_007_199_254_740_991).contains(&revision))
        && valid_endpoint(&source["endpoint"])
        && valid_endpoint(&destination["endpoint"])
        && matches!(
            value["state"].as_str(),
            Some(
                "requested"
                    | "source_hold"
                    | "exported"
                    | "transferred"
                    | "verified"
                    | "cutover"
                    | "rolled_back"
                    | "retired"
                    | "failed"
            )
        )
        && value["updatedAt"].as_str().is_some_and(|date| {
            time::OffsetDateTime::parse(date, &time::format_description::well_known::Rfc3339)
                .is_ok()
        });
    if !valid {
        return Err("Migration checkpoint is invalid".into());
    }
    Ok(true)
}

pub struct MigrationStore {
    client: Client,
    table: String,
}

impl MigrationStore {
    pub fn new(client: Client, table: String) -> Self {
        Self { client, table }
    }

    async fn read_optional(
        &self,
        partition: &str,
        id: &str,
        field: &str,
    ) -> Result<Option<Value>, Failure> {
        let output = self
            .client
            .get_item()
            .table_name(&self.table)
            .set_key(Some(key(partition, id)))
            .consistent_read(true)
            .send()
            .await?;
        output
            .item
            .and_then(|mut item| item.remove(field))
            .map(document)
            .transpose()
    }

    async fn read(&self, partition: &str, id: &str, field: &str) -> Result<Value, Failure> {
        self.read_optional(partition, id, field)
            .await?
            .ok_or_else(|| "Control-plane metadata was not found.".into())
    }

    pub async fn route_optional(&self, creator: &str) -> Result<Option<Value>, Failure> {
        self.read_optional("route", creator, "route").await
    }

    pub async fn checkpoint(&self, id: &str) -> Result<Value, Failure> {
        self.read("migration", id, "checkpoint").await
    }

    pub async fn route(&self, creator: &str) -> Result<Value, Failure> {
        self.read("route", creator, "route").await
    }

    pub async fn creator_migrations(
        &self,
        creator: &str,
        limit: i32,
        cursor: Option<&str>,
    ) -> Result<(Vec<Value>, Option<String>), Failure> {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let page = self
            .client
            .query()
            .table_name(&self.table)
            .key_condition_expression("pk = :pk")
            .expression_attribute_values(":pk", AttributeValue::S("migration".into()))
            .limit(limit)
            .set_exclusive_start_key(cursor.map(migration_cursor).transpose()?)
            .send()
            .await?;
        let mut items = Vec::new();
        for mut item in page.items.unwrap_or_default() {
            let checkpoint = document(
                item.remove("checkpoint")
                    .ok_or("Missing migration checkpoint")?,
            )?;
            if migration_matches(&checkpoint, creator)? {
                items.push(checkpoint);
            }
        }
        let cursor = page
            .last_evaluated_key
            .filter(|key| !key.is_empty())
            .map(|key| -> Result<String, Failure> {
                let sk = key
                    .get("sk")
                    .and_then(|key| key.as_s().ok())
                    .ok_or("Missing migration cursor key")?;
                Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(
                    &serde_json::json!({"pk":"migration","sk":sk}),
                )?))
            })
            .transpose()?;
        Ok((items, cursor))
    }

    pub async fn registered_cell(&self, cell: &str) -> Result<Value, Failure> {
        self.read("cell", cell, "cell").await
    }

    pub async fn save_checkpoint(&self, previous: &str, next: &Value) -> Result<(), Failure> {
        let mut item = key("migration", required(next, "id")?);
        let updated = required(next, "updatedAt")?;
        if updated <= previous {
            return Err("A migration update must advance updatedAt.".into());
        }
        item.insert("checkpoint".into(), attribute(next));
        item.insert(
            "creatorId".into(),
            AttributeValue::S(required(next, "creatorId")?.into()),
        );
        item.insert("updatedAt".into(), AttributeValue::S(updated.into()));
        self.replace(item, "updatedAt", AttributeValue::S(previous.into()))
            .await
    }

    pub async fn save_route(&self, previous: u64, route: &Value) -> Result<(), Failure> {
        let mut item = key("route", required(route, "creatorId")?);
        let revision = route["routingRevision"]
            .as_u64()
            .ok_or("A route revision is required.")?;
        if previous.checked_add(1) != Some(revision) {
            return Err("A replacement route must advance routingRevision by exactly one.".into());
        }
        item.insert("route".into(), attribute(route));
        item.insert(
            "routingRevision".into(),
            AttributeValue::N(revision.to_string()),
        );
        self.replace(
            item,
            "routingRevision",
            AttributeValue::N(previous.to_string()),
        )
        .await
    }

    async fn replace(
        &self,
        item: HashMap<String, AttributeValue>,
        field: &str,
        previous: AttributeValue,
    ) -> Result<(), Failure> {
        self.client
            .put_item()
            .table_name(&self.table)
            .set_item(Some(item))
            .condition_expression("attribute_exists(pk) AND #current = :expected")
            .expression_attribute_names("#current", field)
            .expression_attribute_values(":expected", previous)
            .send()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_the_json_attributes_in_existing_checkpoints() {
        let checkpoint = json!({
            "id":"migration", "state":"exported", "revision":2,
            "objectInventory":[{"versionId":null,"byteLength":9,"immutable":true}]
        });
        assert_eq!(document(attribute(&checkpoint)).unwrap(), checkpoint);
    }
}

#[cfg(test)]
mod migration_history_tests {
    use super::*;

    #[test]
    fn history_cursor_matches_node_and_cannot_change_partition() {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        let encode =
            |pk: &str| URL_SAFE_NO_PAD.encode(format!(r#"{{"pk":"{pk}","sk":"checkpoint"}}"#));
        assert_eq!(
            migration_cursor(&encode("migration")).unwrap(),
            key("migration", "checkpoint")
        );
        assert!(migration_cursor(&encode("route")).is_err());
        assert!(!migration_matches(&serde_json::json!({"creatorId":"other"}), "creator").unwrap());
        assert!(migration_matches(&serde_json::json!({"creatorId":"creator"}), "creator").is_err());
    }
}
