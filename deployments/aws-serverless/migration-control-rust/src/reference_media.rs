use aws_sdk_s3::{Client, types::ChecksumMode};
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

#[cfg(test)]
mod tests {
    use super::*;

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
