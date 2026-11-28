use serde_json::{Map, Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use crate::lifecycle::Failure;

use super::safe_size;

const FIELDS: &[&str] = &[
    "id",
    "revision",
    "createdAt",
    "updatedAt",
    "homeCellId",
    "dataHomeRegion",
    "dataHomeAssignedAt",
    "routingRevision",
    "instanceId",
    "workId",
    "destination",
    "status",
    "remoteId",
    "imageSelection",
    "configurationRevision",
];
const EVIDENCE: &[&str] = &[
    "operationId",
    "confirmedAt",
    "imageFingerprint",
    "sourceAssetId",
    "sourceChecksum",
    "fileChecksum",
    "sizeBytes",
    "mimeType",
    "width",
    "height",
    "variant",
    "recipeFingerprint",
    "watermarkFingerprint",
];

fn pick(value: &Value, fields: &[&str]) -> Map<String, Value> {
    fields
        .iter()
        .filter_map(|key| value.get(*key).map(|value| ((*key).into(), value.clone())))
        .collect()
}

fn only(value: &Value, fields: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|value| value.keys().all(|key| fields.contains(&key.as_str())))
}

fn identifier(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        !text.is_empty()
            && text.trim() == text
            && text.encode_utf16().count() <= 200
            && !text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    })
}

fn variant(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "original"
                | "thumbnail"
                | "reduced"
                | "share"
                | "share-alternate"
                | "watermarked-original"
        )
    )
}

fn hash(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn evidence(value: &Value) -> bool {
    ["operationId", "sourceAssetId"]
        .iter()
        .all(|key| identifier(&value[key]))
        && value["confirmedAt"]
            .as_str()
            .is_some_and(|date| OffsetDateTime::parse(date, &Rfc3339).is_ok())
        && [
            "imageFingerprint",
            "sourceChecksum",
            "fileChecksum",
            "recipeFingerprint",
        ]
        .iter()
        .all(|key| hash(&value[key]))
        && value.get("watermarkFingerprint").is_none_or(hash)
        && ["sizeBytes", "width", "height"]
            .iter()
            .all(|key| safe_size(&value[key]).is_some_and(|size| size > 0))
        && variant(&value["variant"])
        && value["mimeType"]
            .as_str()
            .and_then(|mime| mime.strip_prefix("image/"))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b".+-".contains(&b)
                    })
            })
}

fn selection(value: &Value) -> bool {
    let inherit = |value: &Value| value["mode"] == "inherit" && only(value, &["mode"]);
    let image = &value["variant"];
    let watermark = &value["watermark"];
    let context = &value["context"];
    only(value, &["schemaVersion", "variant", "watermark", "context"])
        && value["schemaVersion"] == 1
        && (inherit(image)
            || image["mode"] == "override"
                && only(image, &["mode", "value"])
                && variant(&image["value"]))
        && (inherit(watermark)
            || watermark["mode"] == "override"
                && only(watermark, &["mode", "value"])
                && watermark["value"].is_object())
        && (inherit(context)
            || context["mode"] == "collection"
                && only(context, &["mode", "collectionId"])
                && identifier(&context["collectionId"]))
}

fn copy_identity(value: &Value) -> bool {
    let context = &value["context"];
    identifier(&value["slotId"])
        && identifier(&value["creationRequestId"])
        && identifier(&value["account"]["providerNamespace"])
        && identifier(&value["account"]["remoteAccountId"])
        && matches!(
            value["purpose"].as_str(),
            Some(
                "UNCLASSIFIED"
                    | "PUBLIC_PREVIEW"
                    | "WORK_SALE"
                    | "COLLECTION_FULL"
                    | "VOLUME_FULL"
                    | "CUSTOM"
            )
        )
        && value.get("context").is_none_or(|context| {
            only(context, &["collectionId", "volumeId"])
                && context
                    .as_object()
                    .is_some_and(|fields| fields.values().all(identifier))
        })
        && (value["purpose"] != "COLLECTION_FULL" || identifier(&context["collectionId"]))
        && (value["purpose"] != "VOLUME_FULL" || identifier(&context["volumeId"]))
}

pub(super) fn validate(record: &Value) -> Result<(), Failure> {
    let history = &record["restoredPublicationHistory"];
    if !record.is_object()
        || record
            .get("configurationRevision")
            .is_some_and(|value| safe_size(value).is_none())
        || record
            .get("imageSelection")
            .is_some_and(|value| !selection(value))
        || record
            .get("unresolvedImageContext")
            .is_some_and(|value| !identifier(&value["sourceCollectionId"]))
        || record
            .get("lastConfirmedImage")
            .is_some_and(|value| !evidence(value))
        || history.get("image").is_some_and(|value| !evidence(value))
        || history
            .get("copy")
            .is_some_and(|value| !copy_identity(value))
    {
        return Err("Invalid portable publication image or copy evidence.".into());
    }
    Ok(())
}

/// Project the allowlisted portable shape before the export is checksummed.
pub fn project(record: &Value) -> Result<Value, Failure> {
    let mut projected = pick(record, FIELDS);
    if let Some(value) = record
        .get("unresolvedImageContext")
        .filter(|value| !value.is_null())
    {
        projected.insert(
            "unresolvedImageContext".into(),
            Value::Object(pick(value, &["sourceCollectionId"])),
        );
    }
    if let Some(value) = record
        .get("lastConfirmedImage")
        .filter(|value| !value.is_null())
    {
        projected.insert(
            "lastConfirmedImage".into(),
            Value::Object(pick(value, EVIDENCE)),
        );
    }
    let history = &record["restoredPublicationHistory"];
    let copy = record
        .get("copy")
        .filter(|copy| !copy.is_null())
        .or_else(|| history.get("copy").filter(|copy| !copy.is_null()));
    if !history.is_null() || copy.is_some() {
        let mut restored = json!({"sourcePublicationId":history.get("sourcePublicationId")
            .filter(|value| !value.is_null()).unwrap_or(&record["id"])});
        if let Some(remote) = history
            .get("remoteId")
            .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
        {
            restored["remoteId"] = remote.clone();
        }
        if let Some(image) = history.get("image").filter(|value| !value.is_null()) {
            restored["image"] = Value::Object(pick(image, EVIDENCE));
        }
        if let Some(copy) = copy {
            restored["copy"] = copy.clone();
        }
        projected.insert("restoredPublicationHistory".into(), restored);
    }
    let projected = Value::Object(projected);
    validate(&projected)?;
    Ok(projected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_only_portable_publish_fields_and_image_evidence() {
        let input = json!({"id":"pub","workId":"work","executionAuthority":{"private":true},
            "copy":{"slotId":"slot","creationRequestId":"request","account":{
                "providerNamespace":"provider","remoteAccountId":"account"},"purpose":"WORK_SALE"},
            "lastConfirmedImage":{"operationId":"op","sourceAssetId":"asset","confirmedAt":"2026-11-26T00:00:00.000Z",
                "imageFingerprint":"a".repeat(64),"sourceChecksum":"b".repeat(64),"fileChecksum":"c".repeat(64),
                "recipeFingerprint":"d".repeat(64),"sizeBytes":2,"width":1,"height":1,
                "mimeType":"image/jpeg","variant":"original","privateObjectKey":"hidden"},
            "imageSelection":{"schemaVersion":1,"variant":{"mode":"inherit"},"watermark":{"mode":"inherit"},
                "context":{"mode":"collection","collectionId":"collection"}}
        });
        let output = project(&input).unwrap();
        assert!(output.get("executionAuthority").is_none());
        assert!(
            output["lastConfirmedImage"]
                .get("privateObjectKey")
                .is_none()
        );
        assert_eq!(
            output["restoredPublicationHistory"]["sourcePublicationId"],
            "pub"
        );
        assert_eq!(output["restoredPublicationHistory"]["copy"], input["copy"]);
        let mut invalid = input;
        invalid["lastConfirmedImage"]["width"] = json!(0);
        assert!(project(&invalid).is_err());
    }

    #[test]
    fn rejects_invalid_watermark_and_copy_context() {
        let mut record = json!({"imageSelection":{"schemaVersion":1,"variant":{"mode":"inherit"},
            "watermark":{"mode":"override","value":[]},"context":{"mode":"inherit"}}});
        assert!(validate(&record).is_err());
        record["imageSelection"]["watermark"]["value"] = json!({});
        assert!(validate(&record).is_ok());
        let invalid = json!({"restoredPublicationHistory":{"copy":{"slotId":"slot","creationRequestId":"req",
            "account":{"providerNamespace":"provider","remoteAccountId":"account"},"purpose":"COLLECTION_FULL"}}});
        assert!(validate(&invalid).is_err());
    }
}
