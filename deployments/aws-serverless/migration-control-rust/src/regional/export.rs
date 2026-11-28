use std::collections::HashSet;

use aws_sdk_s3::{Client, primitives::ByteStream};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::{RegionalCommand, RegionalOperation, RegionalStore, portability, required};
use crate::lifecycle::Failure;

async fn select(
    store: &RegionalStore,
    repository: &str,
    predicate: impl Fn(&Value) -> bool,
) -> Result<Vec<Value>, Failure> {
    Ok(store
        .records(repository)
        .await?
        .into_iter()
        .filter(predicate)
        .collect())
}

impl RegionalStore {
    pub async fn export(
        &self,
        command: &RegionalCommand,
        s3: &Client,
        bucket: &str,
    ) -> Result<Value, Failure> {
        if command.operation != RegionalOperation::Export || bucket.is_empty() {
            return Err("Regional export requires the source deployment bucket.".into());
        }
        let source = &command.checkpoint["source"];
        let creator = self
            .record("creators", command.creator())
            .await?
            .ok_or("Migration source creator is missing.")?;
        if creator["homeCellId"] != source["homeCellId"]
            || creator["routingRevision"] != source["routingRevision"]
        {
            return Err("Regional export source revision changed.".into());
        }
        let hold = self
            .record("moderationHolds", &command.hold_id())
            .await?
            .ok_or("Migration source hold is missing.")?;
        self.require_hold(command, &hold)?;
        if hold["state"] != "active" {
            return Err("Migration source is no longer held.".into());
        }

        let cell = required(source, "homeCellId")?;
        let destination = required(&command.checkpoint["destination"], "cellId")?;
        let target_bucket = command
            .destination_bucket
            .as_deref()
            .ok_or("Missing migration destination bucket.")?;
        let by_creator = |record: &Value| record["creatorId"] == command.creator();
        let works = select(self, "works", by_creator).await?;
        let assets = select(self, "assets", by_creator).await?;
        let work_ids: HashSet<_> = works
            .iter()
            .filter_map(|work| work["id"].as_str())
            .collect();
        let subjects: HashSet<_> = work_ids
            .iter()
            .copied()
            .chain(assets.iter().filter_map(|asset| asset["id"].as_str()))
            .chain(std::iter::once(command.creator()))
            .collect();
        let by_work = |record: &Value| {
            record["workId"]
                .as_str()
                .is_some_and(|id| work_ids.contains(id))
        };
        let by_subject = |record: &Value| {
            record["subjectId"]
                .as_str()
                .is_some_and(|id| subjects.contains(id))
        };
        let mut inventory = Vec::new();
        let mut transfers = Vec::new();
        let mut processing = Vec::new();
        for asset in &assets {
            inventory.push(portability::asset_inventory(
                asset,
                cell,
                command.creator(),
            )?);
            transfers.extend(portability::asset_transfers(
                asset,
                cell,
                command.creator(),
                destination,
                bucket,
                target_bucket,
            )?);
            processing.push(json!({"id":format!("asset-processing:{}", required(asset,"id")?),
                "assetId":asset["id"], "homeCellId":asset["homeCellId"],"dataHomeRegion":asset["dataHomeRegion"],
                "dataHomeAssignedAt":asset["dataHomeAssignedAt"],"routingRevision":asset["routingRevision"],"state":asset["status"]}));
        }
        let mut integration_accounts = select(self, "integrationAccounts", by_creator).await?;
        for account in &mut integration_accounts {
            let record = account
                .as_object_mut()
                .ok_or("Invalid integration account.")?;
            record.remove("credentialReference");
            record.insert("credentialExcluded".into(), json!(true));
        }
        let mut input = Map::from_iter([
            (
                "exportedAt".into(),
                json!(required(&command.checkpoint, "createdAt")?),
            ),
            ("creator".into(), creator),
            ("works".into(), json!(works)),
            ("assets".into(), json!(assets)),
            ("processing".into(), json!(processing)),
            ("objectInventory".into(), json!(inventory)),
            ("integrationAccounts".into(), json!(integration_accounts)),
        ]);
        for repository in ["collections", "importCheckpoints"] {
            let records = select(self, repository, by_creator).await?;
            input.insert(repository.into(), json!(records));
        }
        input.insert(
            "exportCheckpoints".into(),
            json!(select(self, "exportManifests", by_creator).await?),
        );
        for repository in ["publications", "publicationIntents"] {
            input.insert(
                repository.into(),
                json!(select(self, repository, by_work).await?),
            );
        }
        for repository in [
            "moderationEvidence",
            "moderationHolds",
            "reviewCases",
            "auditEvents",
        ] {
            input.insert(
                repository.into(),
                json!(select(self, repository, by_subject).await?),
            );
        }
        input.insert(
            "usageEvents".into(),
            json!(
                select(self, "usageEvents", |record| record["accountId"]
                    == command.creator())
                .await?
            ),
        );
        let manifest = portability::create_export(Value::Object(input))?;
        let bytes = serde_json::to_vec(&manifest)?;
        let digest = Sha256::digest(&bytes);
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        let size = bytes.len();
        let key = format!(
            "cells/{cell}/migrations/{}/creator-export.json",
            command.id()
        );
        let write = s3
            .put_object()
            .bucket(bucket)
            .key(&key)
            .content_type("application/json")
            .if_none_match("*")
            .checksum_sha256(STANDARD.encode(digest))
            .metadata("scope", "private")
            .metadata("checksum", &hex)
            .metadata("byteLength", size.to_string())
            .body(ByteStream::from(bytes.clone()))
            .send()
            .await;
        let version = match write {
            Ok(result) => result.version_id().map(str::to_owned),
            Err(error) => {
                let retained = s3.get_object().bucket(bucket).key(&key).send().await;
                match retained {
                    Ok(value)
                        if value.content_length() == Some(size as i64)
                            && value
                                .metadata()
                                .and_then(|metadata| metadata.get("checksum"))
                                == Some(&hex) =>
                    {
                        let version = value.version_id().map(str::to_owned);
                        if value.body.collect().await?.to_vec() != bytes {
                            return Err(error.into());
                        }
                        version
                    }
                    _ => return Err(error.into()),
                }
            }
        }
        .filter(|version| !version.is_empty() && version != "null")
        .ok_or("Regional export requires versioned S3 storage.")?;
        transfers.insert(0, json!({"id":"migration-manifest", "source":{"bucket":bucket,"key":key,"versionId":version},
            "destination":{"bucket":target_bucket,"key":format!("cells/{destination}/migrations/{}/creator-export.json", command.id())},
            "checksum":hex,"byteLength":size}));
        Ok(json!({"manifestChecksum":manifest["checksum"],"objectInventory":transfers}))
    }
}
