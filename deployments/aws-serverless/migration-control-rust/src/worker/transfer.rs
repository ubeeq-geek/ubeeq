use aws_sdk_s3::{Client, operation::head_object::HeadObjectError, primitives::ByteStream};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use ubeeq_migration_control_api::lifecycle::Failure;

use super::RegisteredCell;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Location {
    bucket: String,
    key: String,
    version_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Object {
    source: Location,
    destination: Location,
    checksum: String,
    byte_length: i64,
}

fn validate(
    object: &Object,
    source_id: &str,
    source_bucket: &str,
    destination_id: &str,
    destination_bucket: &str,
) -> Result<(), Failure> {
    if object.source.bucket != source_bucket
        || object.destination.bucket != destination_bucket
        || !object
            .source
            .key
            .starts_with(&format!("cells/{source_id}/"))
        || !object
            .destination
            .key
            .starts_with(&format!("cells/{destination_id}/"))
        || object.byte_length < 0
        || object.checksum.len() != 64
        || !object.checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(
            "Migration inventory crosses an undeclared cell boundary or lacks integrity evidence."
                .into(),
        );
    }
    Ok(())
}

pub(super) fn objects(
    checkpoint: &Value,
    source: &RegisteredCell,
    destination: &RegisteredCell,
) -> Result<Vec<Object>, Failure> {
    let value = checkpoint
        .get("objectInventory")
        .ok_or("Missing migration object inventory.")?;
    let objects: Vec<Object> = serde_json::from_value(value.clone())?;
    for object in &objects {
        validate(
            object,
            &source.id,
            &source.bucket,
            &destination.id,
            &destination.bucket,
        )?;
    }
    Ok(objects)
}

async fn measured(
    body: ByteStream,
    expected: i64,
    mut output: Option<&mut tokio::fs::File>,
) -> Result<[u8; 32], Failure> {
    let mut reader = body.into_async_read();
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 128 * 1024];
    let mut total = 0i64;
    loop {
        let size = reader.read(&mut buffer).await?;
        if size == 0 {
            break;
        }
        total += size as i64;
        if total > expected {
            return Err("Migration object exceeds the declared size.".into());
        }
        digest.update(&buffer[..size]);
        if let Some(file) = output.as_deref_mut() {
            file.write_all(&buffer[..size]).await?;
        }
    }
    if total != expected {
        return Err("Migration object does not match the declared size.".into());
    }
    Ok(digest.finalize().into())
}

fn check_hash(digest: &[u8], expected: &str) -> Result<(), Failure> {
    let actual: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    if !actual.eq_ignore_ascii_case(expected) {
        return Err("Migration object checksum differs from the exported inventory.".into());
    }
    Ok(())
}

pub(super) async fn verify(
    destination: &Client,
    object: Object,
    migration: &str,
) -> Result<(), Failure> {
    verify_object(destination, &object, migration).await
}

async fn verify_object(
    destination: &Client,
    object: &Object,
    migration: &str,
) -> Result<(), Failure> {
    let value = destination
        .get_object()
        .bucket(&object.destination.bucket)
        .key(&object.destination.key)
        .send()
        .await?;
    let metadata = value
        .metadata()
        .ok_or("Migration destination has no integrity metadata.")?;
    if metadata.get("migrationid").map(String::as_str) != Some(migration)
        || metadata.get("checksum") != Some(&object.checksum)
    {
        return Err("Migration destination belongs to a different retained operation.".into());
    }
    let digest = measured(value.body, object.byte_length, None).await?;
    check_hash(&digest, &object.checksum)
}

pub(super) async fn copy(
    source: &Client,
    destination: &Client,
    object: Object,
    migration: &str,
) -> Result<(), Failure> {
    match destination
        .head_object()
        .bucket(&object.destination.bucket)
        .key(&object.destination.key)
        .send()
        .await
    {
        Ok(_) => return verify_object(destination, &object, migration).await,
        Err(error)
            if error
                .as_service_error()
                .is_some_and(HeadObjectError::is_not_found) => {}
        Err(error)
            if error
                .raw_response()
                .is_some_and(|response| response.status().as_u16() == 404) => {}
        Err(error) => return Err(error.into()),
    }

    let value = source
        .get_object()
        .bucket(&object.source.bucket)
        .key(&object.source.key)
        .set_version_id(object.source.version_id.clone())
        .send()
        .await?;
    let scope = value
        .metadata()
        .and_then(|metadata| metadata.get("scope"))
        .cloned();
    let content_type = value.content_type().map(str::to_owned);
    let temporary = tempfile::NamedTempFile::new()?;
    let mut output = tokio::fs::File::from_std(temporary.reopen()?);
    let digest = measured(value.body, object.byte_length, Some(&mut output)).await?;
    output.flush().await?;
    drop(output);
    check_hash(&digest, &object.checksum)?;
    let mut put = destination
        .put_object()
        .bucket(&object.destination.bucket)
        .key(&object.destination.key)
        .body(ByteStream::from_path(temporary.path()).await?)
        .content_length(object.byte_length)
        .set_content_type(content_type)
        .if_none_match("*")
        .checksum_sha256(STANDARD.encode(digest))
        .metadata("checksum", &object.checksum)
        .metadata("byteLength", object.byte_length.to_string())
        .metadata("migrationId", migration);
    if let Some(scope) = scope {
        put = put.metadata("scope", scope);
    }
    let put = put.send().await;
    if let Err(error) = put {
        // A request can commit before its acknowledgement is lost.
        if verify_object(destination, &object, migration)
            .await
            .is_err()
        {
            return Err(error.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_mismatched_registry_buckets_and_cell_prefixes() {
        let mut object: Object = serde_json::from_value(json!({
            "source":{"bucket":"source-bucket","key":"cells/source/object","versionId":"original"},
            "destination":{"bucket":"destination-bucket","key":"cells/destination/object"},
            "checksum":"a".repeat(64),"byteLength":3
        }))
        .unwrap();
        assert!(
            validate(
                &object,
                "source",
                "source-bucket",
                "destination",
                "destination-bucket"
            )
            .is_ok()
        );
        assert!(
            validate(
                &object,
                "source",
                "other-bucket",
                "destination",
                "destination-bucket"
            )
            .is_err()
        );
        object.destination.key = "cells/destination-other/object".into();
        assert!(
            validate(
                &object,
                "source",
                "source-bucket",
                "destination",
                "destination-bucket"
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn checks_exported_length_and_digest_while_staging() {
        let temporary = tempfile::NamedTempFile::new().unwrap();
        let mut file = tokio::fs::File::from_std(temporary.reopen().unwrap());
        let bytes = [0, 255, 42];
        let measured_digest = measured(ByteStream::from(bytes.to_vec()), 3, Some(&mut file))
            .await
            .unwrap();
        file.flush().await.unwrap();
        assert_eq!(tokio::fs::read(temporary.path()).await.unwrap(), bytes);
        assert_eq!(measured_digest, <[u8; 32]>::from(Sha256::digest(bytes)));
        assert!(check_hash(&measured_digest, &"a".repeat(64)).is_err());
        assert!(
            measured(ByteStream::from(bytes.to_vec()), 2, None)
                .await
                .is_err()
        );
        assert!(
            measured(ByteStream::from(bytes.to_vec()), 4, None)
                .await
                .is_err()
        );
    }
}
