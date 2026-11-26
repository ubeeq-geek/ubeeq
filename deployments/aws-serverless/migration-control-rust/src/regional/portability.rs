use std::{cmp::Ordering, collections::HashSet};

use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale::locale;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::lifecycle::Failure;

use super::required;

// Node's JSON.stringify gives array-index keys precedence even after locale sorting.
fn array_index(key: &str) -> Option<u32> {
    let index = key.parse::<u32>().ok()?;
    (index < u32::MAX && index.to_string() == key).then_some(index)
}

fn key_order(collator: &CollatorBorrowed<'_>, left: &str, right: &str) -> Ordering {
    match (array_index(left), array_index(right)) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => collator.compare(left, right),
    }
}

fn append(
    value: &Value,
    output: &mut String,
    collator: &CollatorBorrowed<'_>,
) -> Result<(), Failure> {
    match value {
        Value::Object(fields) => {
            let mut fields: Vec<_> = fields.iter().collect();
            fields.sort_by(|left, right| key_order(collator, left.0, right.0));
            output.push('{');
            for (index, (key, value)) in fields.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                append(value, output, collator)?;
            }
            output.push('}');
        }
        Value::Array(items) => {
            output.push('[');
            for (index, item) in items.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                append(item, output, collator)?;
            }
            output.push(']');
        }
        Value::Number(value) => {
            let number = value.as_f64().ok_or("Unsupported manifest number.")?;
            output.push_str(ryu_js::Buffer::new().format(number));
        }
        value => output.push_str(&serde_json::to_string(value)?),
    }
    Ok(())
}

fn canonical(value: &Value) -> Result<String, Failure> {
    let collator = Collator::try_new(locale!("en-US").into(), CollatorOptions::default())?;
    let mut output = String::new();
    append(value, &mut output, &collator)?;
    Ok(output)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn checksum(unsigned: &Value) -> Result<String, Failure> {
    Ok(sha256_hex(canonical(unsigned)?.as_bytes()))
}

fn scoped_key(key: &str, prefix: &str) -> bool {
    key.strip_prefix(prefix).is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .split('/')
                .all(|part| part != "." && part != ".." && !part.is_empty())
    })
}

fn safe_size(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|number| *number <= 9_007_199_254_740_991)
}

fn digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn reference(id: String, role: &str, location: &Value, prefix: &str) -> Result<Value, Failure> {
    let key = required(location, "key")?;
    let version = required(location, "versionId")?;
    let checksum = required(location, "checksum")?;
    let size = safe_size(&location["byteLength"])
        .filter(|size| *size > 0)
        .ok_or("Missing rendition size.")?;
    if !scoped_key(key, prefix)
        || !digest(checksum)
        || checksum.bytes().any(|b| b.is_ascii_uppercase())
    {
        return Err("Invalid immutable rendition inventory.".into());
    }
    Ok(
        json!({"id":id,"role":role,"key":key,"versionId":version,"checksum":checksum,"byteLength":size}),
    )
}

/// Reproduces the portable inventory's active object, original and rendition aliases.
pub fn asset_inventory(asset: &Value, cell: &str, creator: &str) -> Result<Value, Failure> {
    if asset["creatorId"].as_str() != Some(creator) || asset["homeCellId"].as_str() != Some(cell) {
        return Err("Asset belongs to another creator or regional cell.".into());
    }
    let prefix = format!("cells/{cell}/creators/{creator}/");
    let asset_id = required(asset, "id")?;
    let storage = &asset["storage"];
    let version = storage["versionId"]
        .as_str()
        .or_else(|| asset["objectVersion"].as_str())
        .filter(|text| !text.is_empty())
        .ok_or("Missing asset version.")?;
    let checksum = storage["checksum"]
        .as_str()
        .or_else(|| asset["checksum"].as_str())
        .filter(|hash| digest(hash))
        .ok_or("Missing or invalid asset checksum.")?;
    let mut result = json!({"assetId":asset_id,"versionId":version,"checksum":checksum,"transferState":"manifest_only"});
    if let Some(key) = storage.get("key") {
        let key = key
            .as_str()
            .filter(|key| scoped_key(key, &prefix))
            .ok_or("Asset object key is outside the creator prefix.")?;
        result["key"] = json!(key);
    }
    if let Some(size) = storage.get("byteLength") {
        result["byteLength"] = json!(safe_size(size).ok_or("Invalid asset byte length.")?);
    }
    if let Some(renditions) = asset.get("processedRenditions") {
        let renditions = renditions
            .as_array()
            .ok_or("Invalid processed rendition inventory.")?;
        if !renditions.is_empty() {
            let mut objects = Vec::new();
            if let Some(original) = asset
                .get("originalStorage")
                .filter(|original| !original.is_null())
            {
                objects.push(reference("original".into(), "original", original, &prefix)?);
            }
            let mut ids = HashSet::new();
            for output in renditions {
                let id = required(output, "id")?;
                if !ids.insert(id) {
                    return Err("Duplicate processed rendition inventory ID.".into());
                }
                objects.push(reference(
                    format!("rendition:{id}"),
                    "rendition",
                    &output["storage"],
                    &prefix,
                )?);
            }
            if objects.len() > 65 {
                return Err("Processed rendition inventory exceeds the portable cap.".into());
            }
            result["objects"] = json!(objects);
        }
    }
    Ok(result)
}

/// Match the original portable manifest's denylist without serializing secret values.
pub fn contains_secret(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(contains_secret),
        Value::Object(fields) => fields.iter().any(|(key, value)| {
            ["token", "password", "secret", "credential", "authorization"]
                .iter()
                .any(|word| key.eq_ignore_ascii_case(word))
                || contains_secret(value)
        }),
        _ => false,
    }
}

const MANIFEST_FIELDS: &[&str] = &[
    "schemaVersion",
    "exportedAt",
    "creator",
    "works",
    "assets",
    "collections",
    "publications",
    "publicationIntents",
    "processing",
    "moderationEvidence",
    "moderationHolds",
    "reviewCases",
    "auditEvents",
    "usageEvents",
    "integrationAccounts",
    "exportCheckpoints",
    "importCheckpoints",
    "objectInventory",
    "exclusions",
    "secretsExcluded",
];

pub fn verified_unsigned(manifest: &Value) -> Result<Value, Failure> {
    let fields = manifest
        .as_object()
        .ok_or("Export manifest must be an object.")?;
    let mut unsigned = Map::new();
    for field in MANIFEST_FIELDS {
        unsigned.insert(
            (*field).into(),
            fields
                .get(*field)
                .cloned()
                .ok_or("Export manifest is incomplete.")?,
        );
    }
    let unsigned = Value::Object(unsigned);
    if unsigned["schemaVersion"] != "2"
        || unsigned["secretsExcluded"] != true
        || contains_secret(&unsigned)
        || manifest["checksum"].as_str() != Some(checksum(&unsigned)?.as_str())
    {
        return Err("Export manifest version, redaction, or checksum is invalid.".into());
    }
    Ok(unsigned)
}

/// Validate the record graph before the regional restore begins writing records.
pub fn verify_record_graph(unsigned: &Value) -> Result<(), Failure> {
    let creator = &unsigned["creator"];
    let creator_id = required(creator, "id")?;
    let cell = required(creator, "homeCellId")?;
    required(creator, "dataHomeRegion")?;
    let assigned = required(creator, "dataHomeAssignedAt")?;
    time::OffsetDateTime::parse(assigned, &time::format_description::well_known::Rfc3339)?;
    safe_size(&creator["routingRevision"]).ok_or("Missing creator routing revision.")?;

    if unsigned["exclusions"]
        != json!([
            "credentials",
            "secrets",
            "transient_worker_leases",
            "live_queue_state",
            "provider_runtime_state",
            "original_object_bytes"
        ])
    {
        return Err("Export manifest exclusions are incomplete or reordered.".into());
    }
    let records = |field: &str| {
        unsigned[field]
            .as_array()
            .ok_or("Export manifest is missing required content arrays.")
    };
    let owned = [
        "works",
        "assets",
        "collections",
        "publications",
        "publicationIntents",
        "processing",
        "moderationEvidence",
        "moderationHolds",
        "reviewCases",
        "auditEvents",
        "usageEvents",
        "integrationAccounts",
        "exportCheckpoints",
        "importCheckpoints",
    ];
    for field in owned {
        let mut ids = HashSet::new();
        for record in records(field)? {
            let id = required(record, "id")?;
            if !ids.insert(id)
                || [
                    "homeCellId",
                    "dataHomeRegion",
                    "dataHomeAssignedAt",
                    "routingRevision",
                ]
                .iter()
                .any(|key| record[key] != creator[key])
            {
                return Err("Export contains duplicate or foreign regional records.".into());
            }
            if [
                "works",
                "assets",
                "collections",
                "integrationAccounts",
                "exportCheckpoints",
                "importCheckpoints",
            ]
            .contains(&field)
                && record["creatorId"].as_str() != Some(creator_id)
            {
                return Err("Export contains records owned by another creator.".into());
            }
            if field == "integrationAccounts"
                && (record.get("credentialReference").is_some()
                    || record["credentialExcluded"] != true)
            {
                return Err("Export contains an unredacted integration account.".into());
            }
        }
    }
    let work_ids: HashSet<_> = records("works")?
        .iter()
        .filter_map(|record| record["id"].as_str())
        .collect();
    let asset_ids: HashSet<_> = records("assets")?
        .iter()
        .filter_map(|record| record["id"].as_str())
        .collect();
    for (collection, field, allowed) in [
        ("publications", "workId", &work_ids),
        ("publicationIntents", "workId", &work_ids),
        ("processing", "assetId", &asset_ids),
    ] {
        if records(collection)?.iter().any(|record| {
            !record[field]
                .as_str()
                .is_some_and(|id| allowed.contains(id))
        }) {
            return Err("Export contains a dangling creator relationship.".into());
        }
    }
    for collection in ["moderationEvidence", "moderationHolds", "reviewCases"] {
        if records(collection)?.iter().any(|record| {
            !record["subjectId"].as_str().is_some_and(|id| {
                id == creator_id || work_ids.contains(id) || asset_ids.contains(id)
            })
        }) {
            return Err("Export contains a foreign moderation subject.".into());
        }
    }
    let inventory = records("objectInventory")?;
    if inventory.len() != asset_ids.len() {
        return Err("Export object inventory is incomplete.".into());
    }
    let mut inventoried = HashSet::new();
    for entry in inventory {
        let id = required(entry, "assetId")?;
        if !asset_ids.contains(id) || !inventoried.insert(id) {
            return Err("Export inventory has duplicate or foreign assets.".into());
        }
    }
    for asset in records("assets")? {
        let expected = asset_inventory(asset, cell, creator_id)?;
        let actual = inventory
            .iter()
            .find(|entry| entry["assetId"] == asset["id"])
            .ok_or("Export inventory is missing an asset.")?;
        if actual != &expected {
            return Err("Export inventory does not match the retained asset references.".into());
        }
    }
    Ok(())
}

fn transfer_entry(
    id: String,
    location: &Value,
    asset: &Value,
    cell: &str,
    destination_cell: &str,
    source_bucket: &str,
    destination_bucket: &str,
) -> Result<Value, Failure> {
    let key = required(location, "key")?;
    let prefix = format!("cells/{cell}/creators/{}/", required(asset, "creatorId")?);
    if !scoped_key(key, &prefix)
        || location["bucket"]
            .as_str()
            .is_some_and(|bucket| bucket != source_bucket)
    {
        return Err(
            "Migration object is outside its registered source bucket or creator prefix.".into(),
        );
    }
    let checksum = location["checksum"]
        .as_str()
        .or_else(|| asset["checksum"].as_str())
        .filter(|value| digest(value))
        .ok_or("Invalid migration object checksum.")?;
    let size = safe_size(&location["byteLength"]).ok_or("Missing migration object byte length.")?;
    let suffix = key
        .strip_prefix(&format!("cells/{cell}/"))
        .ok_or("Missing migration source prefix.")?;
    let mut source = json!({"bucket":source_bucket,"key":key});
    if let Some(version) = location["versionId"].as_str() {
        if version.is_empty() || version == "null" {
            return Err("Invalid migration object version.".into());
        }
        source["versionId"] = json!(version);
    }
    Ok(json!({"id":id,"source":source,"destination":{
        "bucket":destination_bucket,"key":format!("cells/{destination_cell}/{suffix}")
    },"checksum":checksum,"byteLength":size}))
}

pub fn asset_transfers(
    asset: &Value,
    cell: &str,
    creator: &str,
    destination_cell: &str,
    source_bucket: &str,
    destination_bucket: &str,
) -> Result<Vec<Value>, Failure> {
    if cell == destination_cell
        || ![cell, creator, destination_cell]
            .into_iter()
            .all(super::identifier)
        || source_bucket.is_empty()
        || destination_bucket.is_empty()
    {
        return Err("Invalid asset transfer scope.".into());
    }
    asset_inventory(asset, cell, creator)?;
    let id = required(asset, "id")?;
    let active = &asset["storage"];
    let make = |id, location| {
        transfer_entry(
            id,
            location,
            asset,
            cell,
            destination_cell,
            source_bucket,
            destination_bucket,
        )
    };
    let mut entries = vec![make(id.to_owned(), active)?];
    if let Some(original) = asset
        .get("originalStorage")
        .filter(|value| !value.is_null())
    {
        if original["key"] != active["key"] {
            entries.push(make(format!("{id}:original"), original)?);
        }
    }
    if let Some(outputs) = asset["processedRenditions"].as_array() {
        for output in outputs {
            let rendition_id = required(output, "id")?;
            let entry = make(
                format!("{id}:rendition:{}", sha256_hex(rendition_id.as_bytes())),
                &output["storage"],
            )?;
            if !entries
                .iter()
                .any(|prior| prior["source"] == entry["source"])
            {
                if entries
                    .iter()
                    .any(|prior| prior["destination"] == entry["destination"])
                {
                    return Err("Several source versions target the same destination key.".into());
                }
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_canonical_numbers_and_key_order() {
        let input = serde_json::from_str(r#"{"Z":100000000000000000000,"a":1e-7,"2":2,"10":10,"01":-0,"é":[1.23,1e+21],"é":true,"__":{ "z":2,"A":1 }}"#).unwrap();
        assert_eq!(
            checksum(&input).unwrap(),
            "a1226c903b29a4926e2e2cf3027409c8f45318353fb352c7646650ac0fba6f47"
        );
    }

    #[test]
    fn rejects_modified_manifest_and_nested_secrets() {
        let mut manifest = json!({});
        for field in MANIFEST_FIELDS {
            manifest[*field] = json!([]);
        }
        manifest["schemaVersion"] = json!("2");
        manifest["secretsExcluded"] = json!(true);
        manifest["checksum"] = json!(checksum(&manifest).unwrap());
        assert!(verified_unsigned(&manifest).is_ok());
        manifest["works"] = json!([{"payload":{"Authorization":"fixture"}}]);
        assert!(contains_secret(&manifest));
        assert!(verified_unsigned(&manifest).is_err());
    }

    #[test]
    fn validates_related_records_against_the_export_creator_and_data_home() {
        let mut manifest = json!({});
        for field in MANIFEST_FIELDS {
            manifest[*field] = json!([]);
        }
        manifest["exclusions"] = json!([
            "credentials",
            "secrets",
            "transient_worker_leases",
            "live_queue_state",
            "provider_runtime_state",
            "original_object_bytes"
        ]);
        manifest["creator"] = json!({"id":"creator","homeCellId":"a","dataHomeRegion":"us-east-2",
            "dataHomeAssignedAt":"2026-11-26T00:00:00.000Z","routingRevision":1});
        let mut work = manifest["creator"].clone();
        work["id"] = json!("work");
        work["creatorId"] = json!("creator");
        manifest["works"] = json!([work]);
        let mut publication = manifest["works"][0].clone();
        publication["id"] = json!("publication");
        publication["workId"] = json!("work");
        manifest["publications"] = json!([publication]);
        assert!(verify_record_graph(&manifest).is_ok());
        manifest["publications"][0]["workId"] = json!("foreign");
        assert!(verify_record_graph(&manifest).is_err());
        manifest["publications"][0]["workId"] = json!("work");
        manifest["works"][0]["routingRevision"] = json!(2);
        assert!(verify_record_graph(&manifest).is_err());
    }

    fn location(suffix: &str, version: &str) -> Value {
        json!({"bucket":"source","key":format!("cells/a/creators/c/{suffix}"),"versionId":version,
            "checksum":"a".repeat(64),"byteLength":2})
    }

    #[test]
    fn preserves_portable_aliases_while_copying_each_physical_version_once() {
        let active = location("active", "version");
        let mut asset = json!({"id":"asset","creatorId":"c","homeCellId":"a",
            "storage":active,"originalStorage":location("original","source-version"),
            "processedRenditions":[{"id":"alias","storage":active},{"id":"distinct","storage":location("distinct","next")}]
        });
        let portable = asset_inventory(&asset, "a", "c").unwrap();
        assert_eq!(portable["objects"].as_array().unwrap().len(), 3);
        let copied = asset_transfers(&asset, "a", "c", "b", "source", "destination").unwrap();
        assert_eq!(copied.len(), 3);
        assert_eq!(copied[0]["destination"]["key"], "cells/b/creators/c/active");
        assert_eq!(copied[1]["id"], "asset:original");
        assert!(
            copied[2]["id"]
                .as_str()
                .unwrap()
                .starts_with("asset:rendition:")
        );
        asset["processedRenditions"][1]["storage"]["bucket"] = json!("foreign");
        assert!(asset_transfers(&asset, "a", "c", "b", "source", "destination").is_err());
    }
}
