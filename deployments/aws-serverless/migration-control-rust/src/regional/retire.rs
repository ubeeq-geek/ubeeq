use std::collections::HashSet;

use aws_sdk_s3::Client;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::{RegionalCommand, RegionalOperation, RegionalStore, required};
use crate::lifecycle::Failure;

fn check_window(checkpoint: &Value, now: OffsetDateTime) -> Result<(), Failure> {
    if checkpoint["state"] != "cutover" {
        return Err("Only a cut-over migration can retire the source.".into());
    }
    let deadline = OffsetDateTime::parse(required(checkpoint, "rollbackUntil")?, &Rfc3339)?;
    if deadline > now {
        return Err("The rollback retention window has not expired.".into());
    }
    Ok(())
}

fn locations<'a>(
    asset: &'a Value,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<(&'a str, &'a str)>, Failure> {
    let mut result = Vec::new();
    let renditions = asset["processedRenditions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|value| &value["storage"]);
    for location in [&asset["storage"], &asset["originalStorage"]]
        .into_iter()
        .chain(renditions)
    {
        if location.is_null() {
            continue;
        }
        let key = required(location, "key")?;
        if location["bucket"] != bucket
            || !key.strip_prefix(prefix).is_some_and(|part| {
                !part.is_empty() && part.split('/').all(|part| !matches!(part, "" | "." | ".."))
            })
        {
            return Err(
                "Retirement object is outside the source creator's bucket and prefix.".into(),
            );
        }
        let version = required(location, "versionId")?;
        if version == "null" {
            return Err("Retirement requires a retained immutable object version.".into());
        }
        result.push((key, version));
    }
    Ok(result)
}

async fn selected(
    store: &RegionalStore,
    repository: &str,
    matches: impl Fn(&Value) -> bool,
) -> Result<Vec<Value>, Failure> {
    Ok(store
        .retirement_records(repository)
        .await?
        .into_iter()
        .filter(matches)
        .collect())
}

async fn remove(store: &RegionalStore, repository: &str, records: &[Value]) -> Result<(), Failure> {
    for record in records {
        store.remove_owned(repository, record).await?;
    }
    Ok(())
}

fn ids(records: &[Value]) -> HashSet<&str> {
    records
        .iter()
        .filter_map(|record| record["id"].as_str())
        .collect()
}

impl RegionalStore {
    pub async fn retire(
        &self,
        command: &RegionalCommand,
        s3: &Client,
        bucket: &str,
    ) -> Result<Value, Failure> {
        let checkpoint = &command.checkpoint;
        let source = &checkpoint["source"];
        if command.operation != RegionalOperation::Retire
            || source["homeCellId"] != self.cell
            || source["homeRegion"] != self.region
            || bucket.is_empty()
        {
            return Err("Regional retirement requires a checkpoint for this source.".into());
        }
        check_window(checkpoint, OffsetDateTime::now_utc())?;
        let hold = self
            .record("moderationHolds", &command.hold_id())
            .await?
            .ok_or("Retirement requires the source migration hold.")?;
        self.require_hold(command, &hold)?;
        if hold["state"] != "active" {
            return Err("Retirement source is no longer held.".into());
        }
        let creator_id = command.creator();
        let creator = self.record("creators", creator_id).await?;
        if creator
            .as_ref()
            .is_some_and(|record| record["routingRevision"] != source["routingRevision"])
        {
            return Err("Retirement source creator revision changed.".into());
        }
        let by_creator = |record: &Value| record["creatorId"] == creator_id;
        let works = selected(self, "works", by_creator).await?;
        let assets = selected(self, "assets", by_creator).await?;
        let collections = selected(self, "collections", by_creator).await?;
        let integrations = selected(self, "integrationAccounts", by_creator).await?;
        let work_ids = ids(&works);
        let collection_ids = ids(&collections);
        let integration_ids = ids(&integrations);
        let by_work = |record: &Value| {
            record["workId"]
                .as_str()
                .is_some_and(|id| work_ids.contains(id))
        };
        let publications = selected(self, "publications", by_work).await?;
        let publication_ids = ids(&publications);
        let subjects: HashSet<_> = ids(&assets)
            .into_iter()
            .chain(work_ids.iter().copied())
            .chain(collection_ids.iter().copied())
            .chain(std::iter::once(creator_id))
            .collect();
        let by_subject = |record: &Value| {
            record["subjectId"]
                .as_str()
                .is_some_and(|id| subjects.contains(id))
        };
        let prefix = format!("cells/{}/creators/{creator_id}/", self.cell);
        let mut objects = HashSet::new();
        for asset in &assets {
            if asset["routingRevision"] != source["routingRevision"] {
                return Err("Retirement asset routing revision changed.".into());
            }
            objects.extend(locations(asset, bucket, &prefix)?);
        }
        // Preserve record pointers on a partial or ambiguous delete. An exact
        // version delete is repeatable and cannot tombstone a newer version.
        for (key, version) in objects {
            s3.delete_object()
                .bucket(bucket)
                .key(key)
                .version_id(version)
                .send()
                .await?;
        }

        remove(
            self,
            "workMemberships",
            &selected(self, "workMemberships", |record| {
                by_work(record)
                    || record["collectionId"]
                        .as_str()
                        .is_some_and(|id| collection_ids.contains(id))
            })
            .await?,
        )
        .await?;
        remove(
            self,
            "reconciliationSnapshots",
            &selected(self, "reconciliationSnapshots", |record| {
                record["publicationId"]
                    .as_str()
                    .is_some_and(|id| publication_ids.contains(id))
            })
            .await?,
        )
        .await?;
        let by_integration = |record: &Value| {
            record["integrationAccountId"]
                .as_str()
                .is_some_and(|id| integration_ids.contains(id))
        };
        for repository in ["syncCursors", "integrationJobs"] {
            remove(
                self,
                repository,
                &selected(self, repository, by_integration).await?,
            )
            .await?;
        }
        remove(
            self,
            "publicationIntents",
            &selected(self, "publicationIntents", by_work).await?,
        )
        .await?;
        remove(self, "publications", &publications).await?;
        for repository in ["moderationEvidence", "reviewCases"] {
            remove(
                self,
                repository,
                &selected(self, repository, by_subject).await?,
            )
            .await?;
        }
        remove(
            self,
            "moderationHolds",
            &selected(self, "moderationHolds", |record| {
                by_subject(record) && record["id"] != command.hold_id()
            })
            .await?,
        )
        .await?;
        for repository in ["exportManifests", "importCheckpoints"] {
            remove(
                self,
                repository,
                &selected(self, repository, by_creator).await?,
            )
            .await?;
        }
        for (name, records) in [
            ("integrationAccounts", &integrations),
            ("assets", &assets),
            ("collections", &collections),
            ("works", &works),
        ] {
            remove(self, name, records).await?;
        }
        if let Some(creator) = creator {
            self.remove_owned("creators", &creator).await?;
        }

        // Retain the original audit, financial and usage evidence and the
        // source hold. A retry can resume through to the same audit receipt.
        let event_id = format!("regional_migration.source_retired:{}", command.id());
        self.create_imported("auditEvents", json!({
            "id":event_id,"instanceId":self.instance,"homeCellId":self.cell,"dataHomeRegion":self.region,
            "dataHomeAssignedAt":checkpoint["createdAt"],"routingRevision":source["routingRevision"],
            "action":"regional_migration.source_retired","subjectId":creator_id,
            "payload":{"migrationId":command.id(),"auditRetention":"deployment_policy"},
        })).await?;
        Ok(json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retirement_requires_an_expired_window_on_a_cutover_checkpoint() {
        let now = OffsetDateTime::parse("2026-11-26T12:00:00Z", &Rfc3339).unwrap();
        assert!(
            check_window(
                &json!({"state":"cutover","rollbackUntil":"2026-11-26T11:00:00Z"}),
                now
            )
            .is_ok()
        );
        assert!(
            check_window(
                &json!({"state":"cutover","rollbackUntil":"2026-11-26T13:00:00Z"}),
                now
            )
            .is_err()
        );
        assert!(check_window(&json!({"state":"cutover"}), now).is_err());
        assert!(
            check_window(
                &json!({"state":"rolled_back","rollbackUntil":"2026-11-26T11:00:00Z"}),
                now
            )
            .is_err()
        );
    }

    #[test]
    fn retirement_requires_exact_owned_object_versions() {
        let mut asset = json!({"storage":{"bucket":"source","key":"cells/a/creators/c/photo","versionId":"v1"}});
        assert_eq!(
            locations(&asset, "source", "cells/a/creators/c/").unwrap(),
            [("cells/a/creators/c/photo", "v1")]
        );
        assert!(locations(&asset, "foreign", "cells/a/creators/c/").is_err());
        assert!(locations(&asset, "source", "cells/a/creators/d/").is_err());
        asset["storage"]["versionId"] = Value::Null;
        assert!(locations(&asset, "source", "cells/a/creators/c/").is_err());
    }
}
