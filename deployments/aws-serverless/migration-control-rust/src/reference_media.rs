use aws_sdk_s3::{
    Client,
    types::{ChecksumAlgorithm, ChecksumMode, MetadataDirective},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::lifecycle::Failure;

pub struct VerifiedSource {
    pub object: Value,
    pub metadata: Value,
    pub lineage: Value,
}

fn string<'a>(record: &'a Value, key: &str) -> Result<&'a str, Failure> {
    record[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing source field {key}").into())
}

fn in_custody(key: &str, cell: &str, creator: &str) -> bool {
    !cell.contains('/')
        && !creator.contains('/')
        && key.starts_with(&format!("cells/{cell}/creators/{creator}/"))
        && key.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part
                    .bytes()
                    .any(|byte| byte <= 31 || byte == 127 || matches!(byte, b'%' | b'\\'))
        })
}

fn image_metadata(mime: &str, byte_length: u64, header: &[u8]) -> Value {
    let mut metadata = json!({"contentType":mime,"byteLength":byte_length});
    if mime == "image/png" && header.len() >= 24 && &header[1..4] == b"PNG" {
        let width = u32::from_be_bytes(header[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(header[20..24].try_into().unwrap());
        if width != 0 && height != 0 {
            metadata["width"] = json!(width);
            metadata["height"] = json!(height);
        }
    }
    metadata
}

async fn verify_stream(
    mut source: impl AsyncRead + Unpin,
    length: u64,
    checksum: &str,
) -> Result<Vec<u8>, Failure> {
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut header = Vec::with_capacity(24);
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let count = source.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or("Source size overflow")?;
        if bytes > length {
            return Err("Processing source exceeds its recorded length".into());
        }
        let needed = 24 - header.len();
        header.extend_from_slice(&buffer[..count.min(needed)]);
        digest.update(&buffer[..count]);
    }
    let hash: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if bytes == 0 || bytes != length || hash != checksum {
        return Err("Processing source failed length or checksum verification".into());
    }
    Ok(header)
}

pub async fn verify_source(
    s3: &Client,
    bucket: &str,
    cell: &str,
    asset: &Value,
) -> Result<VerifiedSource, Failure> {
    let object = &asset["storage"];
    let creator = string(asset, "creatorId")?;
    let key = string(object, "key")?;
    let version = string(object, "versionId")?;
    let checksum = string(asset, "checksum")?;
    let mime = string(asset, "mimeType")?;
    if asset["homeCellId"] != cell
        || !in_custody(key, cell, creator)
        || object["bucket"] != bucket
        || object["scope"] != "private"
        || version == "null"
        || asset["objectVersion"] != version
        || object["checksum"] != checksum
        || object["contentType"] != mime
    {
        return Err("Processing source is outside its recorded custody".into());
    }
    let length = object["byteLength"]
        .as_u64()
        .filter(|length| (1..=9_007_199_254_740_991).contains(length))
        .ok_or("Invalid processing source length")?;
    let source = s3
        .get_object()
        .bucket(bucket)
        .key(key)
        .version_id(version)
        .checksum_mode(ChecksumMode::Enabled)
        .send()
        .await?;
    if source.version_id() != Some(version)
        || source.content_length() != Some(length as i64)
        || source.content_type() != Some(mime)
        || source
            .metadata()
            .and_then(|metadata| metadata.get("checksum"))
            .map(String::as_str)
            != Some(checksum)
    {
        return Err("Processing source failed version or metadata verification".into());
    }
    let header = verify_stream(source.body.into_async_read(), length, checksum).await?;
    let metadata = image_metadata(mime, length, &header);
    let lineage = json!({"id":format!("source:{version}"),"sourceVersionId":version,"contentType":mime,
        "byteLength":length,"role":"source"});
    Ok(VerifiedSource {
        object: object.clone(),
        metadata,
        lineage,
    })
}

fn evidence_hash(value: &Value) -> String {
    fn ordered(value: &Value) -> Value {
        match value {
            Value::Object(fields) => {
                let mut keys: Vec<_> = fields.keys().collect();
                keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
                Value::Object(
                    keys.into_iter()
                        .map(|key| (key.clone(), ordered(&fields[key])))
                        .collect(),
                )
            }
            Value::Array(items) => Value::Array(items.iter().map(ordered).collect()),
            _ => value.clone(),
        }
    }
    Sha256::digest(ordered(value).to_string())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub struct RenditionPlan {
    pub journal_id: String,
    pub usage_key: String,
    pub journal: Value,
    pub key: String,
}

pub fn plan_rendition(asset: &Value, source: &VerifiedSource) -> Result<RenditionPlan, Failure> {
    let instance = string(asset, "instanceId")?;
    let cell = string(asset, "homeCellId")?;
    let creator = string(asset, "creatorId")?;
    let asset_id = string(asset, "id")?;
    let version = string(asset, "objectVersion")?;
    let mime = string(asset, "mimeType")?;
    let hash = string(asset, "checksum")?;
    let usage_key = asset["processingUsageKey"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("asset-processing:{asset_id}:{version}"));
    let journal_id = format!(
        "processed-outputs-{}",
        evidence_hash(&json!([instance, cell, creator, usage_key]))
    );
    let length = source.object["byteLength"]
        .as_u64()
        .ok_or("Missing source length")?;
    // Node's S3 read uses these object fields and omits the upload timestamp.
    let source_binding = json!({"bucket":source.object["bucket"],"key":source.object["key"],
        "versionId":version,"contentType":mime,"byteLength":length,"checksum":hash,"scope":"private"});
    let binding = evidence_hash(&json!([
        instance,
        cell,
        asset["dataHomeRegion"],
        asset["dataHomeAssignedAt"],
        asset["routingRevision"],
        creator,
        asset_id,
        version,
        hash,
        mime,
        source_binding,
        usage_key
    ]));
    let primary = evidence_hash(&json!([mime, length, hash, "public"]));
    let plan = json!({"binding":binding,"result":{"metadata":source.metadata,"renditions":[source.lineage],"measuredUnits":1},
        "primary":primary,"outputs":[{"id":primary,"contentType":mime,"byteLength":length,"checksum":hash,"scope":"public"}],"aliases":{}});
    let object_id = evidence_hash(&json!([journal_id, primary]));
    let key = format!("cells/{cell}/creators/{creator}/renditions/processed-{object_id}");
    if !in_custody(&key, cell, creator) {
        return Err("Invalid rendition custody".into());
    }
    let journal = json!({"fingerprint":evidence_hash(&plan),"plan":plan,"objects":{}});
    Ok(RenditionPlan {
        journal_id,
        usage_key,
        journal,
        key,
    })
}

fn encode_copy_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            output.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(output, "%{byte:02X}").unwrap();
        }
    }
    output
}

async fn rendition_at(
    s3: &Client,
    bucket: &str,
    key: &str,
    version: Option<&str>,
    source: &VerifiedSource,
) -> Result<Option<Value>, Failure> {
    let head = match s3
        .head_object()
        .bucket(bucket)
        .key(key)
        .set_version_id(version.map(str::to_owned))
        .checksum_mode(ChecksumMode::Enabled)
        .send()
        .await
    {
        Ok(head) => head,
        Err(failure)
            if failure
                .raw_response()
                .is_some_and(|response| response.status().as_u16() == 404) =>
        {
            return Ok(None);
        }
        Err(failure) => return Err(failure.into()),
    };
    let found = head
        .version_id()
        .filter(|version| !version.is_empty() && *version != "null")
        .ok_or("Missing rendition version")?;
    let mime = string(&source.object, "contentType")?;
    let hash = string(&source.object, "checksum")?;
    let length = source.object["byteLength"]
        .as_u64()
        .ok_or("Missing source length")?;
    let metadata = head.metadata().ok_or("Missing rendition metadata")?;
    if version.is_some_and(|version| version != found)
        || head.content_type() != Some(mime)
        || head.content_length() != Some(length as i64)
        || metadata.get("checksum").map(String::as_str) != Some(hash)
        || metadata.get("scope").map(String::as_str) != Some("public")
    {
        return Err("Existing rendition conflicts with the recorded output".into());
    }
    let digest = hash
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| Ok::<_, Failure>(u8::from_str_radix(std::str::from_utf8(pair)?, 16)?))
        .collect::<Result<Vec<_>, _>>()?;
    if head.checksum_sha256() != Some(STANDARD.encode(digest).as_str()) {
        // Earlier Node outputs can lack a provider SHA-256 header. Verify their exact version.
        let object = s3
            .get_object()
            .bucket(bucket)
            .key(key)
            .version_id(found)
            .send()
            .await?;
        if object.version_id() != Some(found) {
            return Err("Rendition version changed during verification".into());
        }
        verify_stream(object.body.into_async_read(), length, hash).await?;
    }
    Ok(Some(
        json!({"bucket":bucket,"key":key,"versionId":found,"contentType":mime,"byteLength":length,
        "checksum":hash,"scope":"public"}),
    ))
}

/// Call only after the caller has persisted and verified this exact journal plan.
pub async fn copy_rendition(
    s3: &Client,
    source: &VerifiedSource,
    plan: &RenditionPlan,
) -> Result<Value, Failure> {
    let bucket = string(&source.object, "bucket")?;
    if let Some(retained) = rendition_at(s3, bucket, &plan.key, None, source).await? {
        return Ok(retained);
    }
    let key = string(&source.object, "key")?
        .split('/')
        .map(encode_copy_component)
        .collect::<Vec<_>>()
        .join("/");
    let version = encode_copy_component(string(&source.object, "versionId")?);
    let copy = s3
        .copy_object()
        .bucket(bucket)
        .key(&plan.key)
        .copy_source(format!("{bucket}/{key}?versionId={version}"))
        .if_none_match("*")
        .metadata_directive(MetadataDirective::Replace)
        .checksum_algorithm(ChecksumAlgorithm::Sha256)
        .content_type(string(&source.object, "contentType")?)
        .metadata("scope", "public")
        .metadata("checksum", string(&source.object, "checksum")?)
        .metadata("bytelength", source.object["byteLength"].to_string())
        .send()
        .await;
    let version = copy
        .as_ref()
        .ok()
        .and_then(|response| response.version_id());
    if let Some(receipt) = rendition_at(s3, bucket, &plan.key, version, source).await? {
        return Ok(receipt);
    }
    match copy {
        Ok(_) => Err("Rendition copy has no verifiable immutable receipt".into()),
        Err(failure) => Err(failure.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendition_plan_binds_version_and_ignores_upload_timestamps() {
        let asset = json!({"id":"a","instanceId":"i","homeCellId":"c","creatorId":"owner",
            "objectVersion":"source","mimeType":"image/png","checksum":"digest","routingRevision":1});
        let mut source = VerifiedSource {
            object: json!({"bucket":"bucket","key":"cells/c/creators/owner/uploads/a","byteLength":24,"writtenAt":"first"}),
            metadata: json!({"contentType":"image/png","byteLength":24}),
            lineage: json!({"role":"source"}),
        };
        let plan = plan_rendition(&asset, &source).unwrap();
        assert!(
            plan.key
                .starts_with("cells/c/creators/owner/renditions/processed-")
        );
        source.object["writtenAt"] = json!("later");
        assert_eq!(
            plan_rendition(&asset, &source).unwrap().journal,
            plan.journal
        );
        assert_eq!(encode_copy_component("a+b/c="), "a%2Bb%2Fc%3D");
    }

    #[tokio::test]
    async fn verifies_stream_and_reads_png_dimensions() {
        let mut image = [0; 24];
        image[1..4].copy_from_slice(b"PNG");
        image[16..20].copy_from_slice(&3u32.to_be_bytes());
        image[20..24].copy_from_slice(&5u32.to_be_bytes());
        let hash: String = Sha256::digest(image)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let header = verify_stream(&image[..], 24, &hash).await.unwrap();
        assert_eq!(
            image_metadata("image/png", 24, &header),
            json!({"contentType":"image/png","byteLength":24,"width":3,"height":5})
        );
        assert!(verify_stream(&image[..], 23, &hash).await.is_err());
        assert!(verify_stream(&image[..], 24, "wrong").await.is_err());
        assert!(!in_custody(
            "cells/c/creators/other/uploads/a",
            "c",
            "owner"
        ));
        assert!(!in_custody("cells/c/creators/owner/../other", "c", "owner"));
    }
}
