use std::collections::HashMap;

use aws_sdk_s3::{Client, primitives::ByteStream};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;

use crate::lifecycle::Failure;

use super::{RegionalCommand, RegionalOperation, RegionalStore, portability, required};

async fn verify_bytes(body: ByteStream, entry: &Value, keep: bool) -> Result<Vec<u8>, Failure> {
    let expected = entry["byteLength"]
        .as_u64()
        .ok_or("Missing migrated object length.")?;
    let mut reader = body.into_async_read();
    let mut buffer = vec![0; 128 * 1024];
    let mut output = Vec::new();
    let mut size = 0u64;
    let mut sha = Sha256::new();
    loop {
        let n = reader.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        size = size
            .checked_add(n as u64)
            .ok_or("Migrated object length exhausted.")?;
        if size > expected {
            return Err("Migrated object exceeds its exported length.".into());
        }
        sha.update(&buffer[..n]);
        if keep {
            output.try_reserve(n)?;
            output.extend_from_slice(&buffer[..n]);
        }
    }
    let digest: [u8; 32] = sha.finalize().into();
    let hash: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    if size != expected || !hash.eq_ignore_ascii_case(required(entry, "checksum")?) {
        return Err("Migrated object failed length or checksum verification.".into());
    }
    Ok(output)
}

fn bind_inventory<'a>(
    checkpoint: &'a Value,
    manifest: &Value,
    bucket: &str,
    cell: &str,
) -> Result<HashMap<&'a str, &'a Value>, Failure> {
    let inventory = checkpoint["objectInventory"]
        .as_array()
        .ok_or("Missing migration inventory.")?;
    let source_cell = required(&checkpoint["source"], "homeCellId")?;
    let creator = required(checkpoint, "creatorId")?;
    let id = required(checkpoint, "id")?;
    let mut entries = HashMap::new();
    let mut keys = std::collections::HashSet::new();
    for item in inventory {
        let id = required(item, "id")?;
        let destination = &item["destination"];
        if destination["bucket"] != bucket
            || !keys.insert(required(destination, "key")?)
            || entries.insert(id, item).is_some()
        {
            return Err("Migration inventory has a foreign or duplicate destination.".into());
        }
    }
    let entry = entries
        .get("migration-manifest")
        .ok_or("Missing migration manifest inventory.")?;
    if entry["source"]["key"] != format!("cells/{source_cell}/migrations/{id}/creator-export.json")
        || entry["destination"]["key"]
            != format!("cells/{cell}/migrations/{id}/creator-export.json")
    {
        return Err("Migration manifest inventory is outside its scoped key.".into());
    }
    let source_bucket = required(&entry["source"], "bucket")?;
    let mut count = 1usize;
    for asset in manifest["assets"]
        .as_array()
        .ok_or("Missing export assets.")?
    {
        for expected in
            portability::asset_transfers(asset, source_cell, creator, cell, source_bucket, bucket)?
        {
            let id = required(&expected, "id")?;
            if entries.get(id) != Some(&&expected) {
                return Err("Migration inventory does not match the signed export asset.".into());
            }
            count += 1;
        }
    }
    if count != entries.len() {
        return Err("Migration inventory contains objects outside the signed export.".into());
    }
    Ok(entries)
}

fn remap_record(
    record: &Value,
    instance: &str,
    cell: &str,
    region: &str,
    assigned: &str,
    revision: u64,
) -> Result<Value, Failure> {
    let mut value = record.clone();
    let fields = value.as_object_mut().ok_or("Invalid migration record.")?;
    for key in ["revision", "createdAt", "updatedAt"] {
        fields.remove(key);
    }
    value["instanceId"] = json!(instance);
    value["homeCellId"] = json!(cell);
    value["dataHomeRegion"] = json!(region);
    value["dataHomeAssignedAt"] = json!(assigned);
    value["routingRevision"] = json!(revision);
    Ok(value)
}

fn object_entry<'a>(
    entries: &HashMap<&str, &'a Value>,
    id: &str,
    location: &Value,
) -> Result<&'a Value, Failure> {
    let entry = entries
        .get(id)
        .copied()
        .ok_or("Missing asset transfer entry.")?;
    let source = &entry["source"];
    if source["key"] != location["key"]
        || source["versionId"] != location["versionId"]
        || location
            .get("bucket")
            .is_some_and(|bucket| bucket != &source["bucket"])
    {
        return Err("Asset transfer entry differs from the source location.".into());
    }
    Ok(entry)
}

async fn receive(
    s3: &Client,
    entry: &Value,
    location: &Value,
    migration: &str,
    encoded: bool,
) -> Result<Value, Failure> {
    let target = &entry["destination"];
    let bucket = required(target, "bucket")?;
    let key = required(target, "key")?;
    let result = s3.get_object().bucket(bucket).key(key).send().await?;
    let metadata = result
        .metadata()
        .ok_or("Missing migration destination metadata.")?;
    if metadata.get("migrationid").map(String::as_str) != Some(migration)
        || metadata.get("checksum").map(String::as_str) != entry["checksum"].as_str()
    {
        return Err("Migration destination evidence does not match the checkpoint.".into());
    }
    let version = result
        .version_id()
        .filter(|version| !version.is_empty() && *version != "null")
        .map(str::to_owned);
    let media_type = result
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_owned();
    let scope = metadata
        .get("scope")
        .map(String::as_str)
        .unwrap_or("private")
        .to_owned();
    verify_bytes(result.body, entry, false).await?;
    if encoded {
        if location["contentType"] != media_type || location["scope"] != scope {
            return Err("Migrated rendition content type or scope conflicts.".into());
        }
        return Ok(
            json!({"bucket":bucket,"key":key,"versionId":version.ok_or("Migrated rendition requires an immutable version.")?,
            "contentType":media_type,"byteLength":entry["byteLength"],"checksum":entry["checksum"],"scope":scope}),
        );
    }
    let mut remapped = location.clone();
    remapped
        .as_object_mut()
        .ok_or("Invalid legacy location.")?
        .remove("versionId");
    remapped["bucket"] = json!(bucket);
    remapped["key"] = json!(key);
    Ok(remapped)
}

async fn remap_asset(
    s3: &Client,
    mut asset: Value,
    entries: &HashMap<&str, &Value>,
    migration: &str,
) -> Result<Value, Failure> {
    let id = required(&asset, "id")?.to_owned();
    let encoded = asset["processedRenditions"]
        .as_array()
        .is_some_and(|outputs| !outputs.is_empty());
    let active = object_entry(entries, &id, &asset["storage"])?;
    let original = asset
        .get("originalStorage")
        .filter(|value| !value.is_null())
        .cloned();
    let mut outputs = asset["processedRenditions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let active_location = asset["storage"].clone();
    asset["storage"] = receive(s3, active, &active_location, migration, encoded).await?;
    if let Some(original) = original {
        let entry = if original["key"] == active_location["key"]
            && original["versionId"] == active_location["versionId"]
        {
            active
        } else {
            object_entry(entries, &format!("{id}:original"), &original)?
        };
        asset["originalStorage"] = receive(s3, entry, &original, migration, encoded).await?;
    }
    if encoded {
        for output in &mut outputs {
            let location = &output["storage"];
            let entry = entries
                .values()
                .copied()
                .find(|entry| {
                    let source = &entry["source"];
                    source["bucket"] == location["bucket"]
                        && source["key"] == location["key"]
                        && source["versionId"] == location["versionId"]
                })
                .ok_or("Missing migrated rendition reference.")?;
            output["storage"] = receive(s3, entry, location, migration, true).await?;
        }
        asset["processedRenditions"] = json!(outputs);
    }
    Ok(asset)
}

impl RegionalStore {
    pub async fn import(
        &self,
        command: &RegionalCommand,
        s3: &Client,
        bucket: &str,
    ) -> Result<Value, Failure> {
        let checkpoint = &command.checkpoint;
        if command.operation != RegionalOperation::Import
            || checkpoint["destination"]["cellId"] != self.cell
            || checkpoint["destination"]["region"] != self.region
            || checkpoint["state"] != "transferred"
        {
            return Err(
                "Regional import requires a transferred checkpoint for this destination.".into(),
            );
        }
        let entry = checkpoint["objectInventory"]
            .as_array()
            .and_then(|objects| {
                objects
                    .iter()
                    .find(|object| object["id"] == "migration-manifest")
            })
            .ok_or("Missing migration manifest inventory.")?;
        let key = format!(
            "cells/{}/migrations/{}/creator-export.json",
            self.cell,
            command.id()
        );
        if entry["destination"]["bucket"] != bucket || entry["destination"]["key"] != key {
            return Err("Migration manifest destination does not match this cell.".into());
        }
        let result = s3.get_object().bucket(bucket).key(key).send().await?;
        let manifest: Value =
            serde_json::from_slice(&verify_bytes(result.body, entry, true).await?)?;
        if manifest["checksum"] != checkpoint["manifestChecksum"] {
            return Err("Migration manifest checksum differs from the checkpoint.".into());
        }
        let manifest = portability::verified_unsigned(&manifest)?;
        portability::verify_record_graph(&manifest)?;
        let creator = &manifest["creator"];
        let source = &checkpoint["source"];
        if creator["id"] != command.creator()
            || creator["homeCellId"] != source["homeCellId"]
            || creator["dataHomeRegion"] != source["homeRegion"]
            || creator["routingRevision"] != source["routingRevision"]
        {
            return Err(
                "Migration manifest creator or source revision differs from checkpoint.".into(),
            );
        }
        let entries = bind_inventory(checkpoint, &manifest, bucket, &self.cell)?;
        let assigned = required(checkpoint, "createdAt")?;
        let revision = source["routingRevision"]
            .as_u64()
            .and_then(|value| value.checked_add(1))
            .ok_or("Invalid migration route revision.")?;
        let rehome = |value: &Value| {
            remap_record(
                value,
                &self.instance,
                &self.cell,
                &self.region,
                assigned,
                revision,
            )
        };
        let mut assets = Vec::new();
        for value in manifest["assets"]
            .as_array()
            .ok_or("Missing export assets.")?
        {
            let remapped = remap_asset(s3, value.clone(), &entries, command.id()).await?;
            assets.push(rehome(&remapped)?);
        }
        self.create_imported("creators", rehome(creator)?).await?;
        for (field, repository) in [
            ("works", "works"),
            ("collections", "collections"),
            ("assets", "assets"),
            ("publications", "publications"),
            ("publicationIntents", "publicationIntents"),
            ("moderationEvidence", "moderationEvidence"),
            ("moderationHolds", "moderationHolds"),
            ("reviewCases", "reviewCases"),
            ("auditEvents", "auditEvents"),
            ("usageEvents", "usageEvents"),
            ("integrationAccounts", "integrationAccounts"),
        ] {
            if field == "assets" {
                for value in assets.drain(..) {
                    self.create_imported(repository, value).await?;
                }
                continue;
            }
            for value in manifest[field]
                .as_array()
                .ok_or("Missing export records.")?
            {
                let mut value = rehome(value)?;
                if field == "integrationAccounts" {
                    let fields = value
                        .as_object_mut()
                        .ok_or("Invalid integration account.")?;
                    fields.remove("credentialReference");
                    value["health"] = json!("blocked");
                }
                self.create_imported(repository, value).await?;
            }
        }
        Ok(json!({}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaps_records_without_carrying_source_revision_or_clock_fields() {
        let input = json!({"id":"work","revision":12,"createdAt":"old","updatedAt":"old","instanceId":"source"});
        let output =
            remap_record(&input, "destination", "b", "eu-central-1", "assigned", 2).unwrap();
        assert_eq!(output["homeCellId"], "b");
        assert_eq!(output["routingRevision"], 2);
        for field in ["revision", "createdAt", "updatedAt"] {
            assert!(output.get(field).is_none());
        }
    }

    #[tokio::test]
    async fn rejects_transferred_manifest_with_changed_bytes() {
        let hash: [u8; 32] = Sha256::digest(b"manifest").into();
        let entry = json!({"byteLength":8,"checksum":hash.iter().map(|b|format!("{b:02x}")).collect::<String>()});
        assert_eq!(
            verify_bytes(ByteStream::from_static(b"manifest"), &entry, true)
                .await
                .unwrap(),
            b"manifest"
        );
        assert!(
            verify_bytes(ByteStream::from_static(b"mAnifest"), &entry, true)
                .await
                .is_err()
        );
    }
}
