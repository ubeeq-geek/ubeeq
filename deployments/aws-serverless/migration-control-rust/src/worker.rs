#[path = "worker/transfer.rs"]
mod transfer;

use std::env;

use aws_config::{BehaviorVersion, Region, SdkConfig};
use aws_sdk_lambda::{Client as Lambda, primitives::Blob, types::InvocationType};
use aws_sdk_s3::Client as S3;
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use ubeeq_migration_control_api::{
    lifecycle::{self, CellCommand, Failure, MigrationBackend, Operation},
    store::MigrationStore,
};

#[derive(Deserialize)]
struct Batch {
    #[serde(default, rename = "Records")]
    records: Vec<Record>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    message_id: String,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Command {
    migration_id: String,
    operation: QueueOperation,
    rollback_window_seconds: Option<i64>,
}

#[derive(Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum QueueOperation {
    Resume,
    Rollback,
    Retire,
}

impl From<QueueOperation> for Operation {
    fn from(value: QueueOperation) -> Self {
        match value {
            QueueOperation::Resume => Self::Resume,
            QueueOperation::Rollback => Self::Rollback,
            QueueOperation::Retire => Self::Retire,
        }
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str, Failure> {
    value[name]
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("Missing migration field {name}.").into())
}

struct RegisteredCell {
    id: String,
    bucket: String,
    function: String,
    lambda: Lambda,
    s3: S3,
}

impl RegisteredCell {
    async fn load(config: &SdkConfig, store: &MigrationStore, id: &str) -> Result<Self, Failure> {
        let record = store.registered_cell(id).await?;
        if record["state"] != "active" || record["cellId"].as_str() != Some(id) {
            return Err("Migration cell is not active in the operator registry.".into());
        }
        let region = field(&record, "region")?;
        let regional = config
            .to_builder()
            .region(Region::new(region.to_owned()))
            .build();
        Ok(Self {
            id: id.to_owned(),
            bucket: field(&record, "objectBucket")?.into(),
            function: field(&record, "migrationEndpoint")?.into(),
            lambda: Lambda::new(&regional),
            s3: S3::new(&regional),
        })
    }

    async fn invoke(&self, payload: Value) -> Result<Value, Failure> {
        let result = self
            .lambda
            .invoke()
            .function_name(&self.function)
            .invocation_type(InvocationType::RequestResponse)
            .payload(Blob::new(serde_json::to_vec(&payload)?))
            .send()
            .await?;
        let body: Value = serde_json::from_slice(
            result
                .payload()
                .ok_or("Missing migration cell response.")?
                .as_ref(),
        )?;
        if result.status_code() != 200
            || result.function_error().is_some()
            || !body.is_object()
            || body.get("error").is_some_and(|value| !value.is_null())
        {
            return Err("Regional migration command failed.".into());
        }
        Ok(body.get("result").cloned().unwrap_or_else(|| json!({})))
    }
}

struct Backend<'a> {
    store: &'a MigrationStore,
    checkpoint: Value,
    source: RegisteredCell,
    destination: RegisteredCell,
}

impl MigrationBackend for Backend<'_> {
    async fn checkpoint(&mut self, id: &str) -> Result<Value, Failure> {
        if self.checkpoint["id"].as_str() != Some(id) {
            return Err("Unexpected migration checkpoint identity.".into());
        }
        Ok(self.checkpoint.clone())
    }

    async fn route(&mut self, creator: &str) -> Result<Value, Failure> {
        self.store.route(creator).await
    }

    async fn save_checkpoint(&mut self, previous: &str, next: &Value) -> Result<(), Failure> {
        self.store.save_checkpoint(previous, next).await
    }

    async fn save_route(&mut self, previous: u64, next: &Value) -> Result<(), Failure> {
        self.store.save_route(previous, next).await
    }

    async fn cell(&mut self, command: CellCommand, checkpoint: &Value) -> Result<Value, Failure> {
        let (cell, operation) = match command {
            CellCommand::SourceHold => (&self.source, "source_hold"),
            CellCommand::SourceRelease => (&self.source, "source_release"),
            CellCommand::Export => (&self.source, "export"),
            CellCommand::Import => (&self.destination, "import"),
            CellCommand::Enable => (&self.destination, "enable"),
            CellCommand::Rollback => (&self.destination, "rollback"),
            CellCommand::Retire => (&self.source, "retire"),
        };
        let mut payload = json!({"operation":operation,"checkpoint":checkpoint});
        if command == CellCommand::Export {
            payload["destinationBucket"] = json!(self.destination.bucket);
        }
        cell.invoke(payload).await
    }

    async fn transfer(&mut self, checkpoint: &Value) -> Result<(), Failure> {
        for object in transfer::objects(checkpoint, &self.source, &self.destination)? {
            transfer::copy(
                &self.source.s3,
                &self.destination.s3,
                object,
                field(checkpoint, "id")?,
            )
            .await?;
        }
        Ok(())
    }

    async fn verify(&mut self, checkpoint: &Value) -> Result<(), Failure> {
        for object in transfer::objects(checkpoint, &self.source, &self.destination)? {
            transfer::verify(&self.destination.s3, object, field(checkpoint, "id")?).await?;
        }
        Ok(())
    }
}

async fn execute(
    config: &SdkConfig,
    store: &MigrationStore,
    command: Command,
) -> Result<Value, Failure> {
    if command.migration_id.trim().is_empty() {
        return Err("Migration command is invalid.".into());
    }
    let checkpoint = store.checkpoint(&command.migration_id).await?;
    let source = field(&checkpoint["source"], "homeCellId")?;
    let destination = field(&checkpoint["destination"], "cellId")?;
    if source == destination || checkpoint["id"].as_str() != Some(command.migration_id.as_str()) {
        return Err("Migration checkpoint identity is invalid.".into());
    }
    let (source, destination) = tokio::try_join!(
        RegisteredCell::load(config, store, source),
        RegisteredCell::load(config, store, destination)
    )?;
    let mut backend = Backend {
        store,
        checkpoint,
        source,
        destination,
    };
    lifecycle::execute(
        &mut backend,
        &command.migration_id,
        command.operation.into(),
        command.rollback_window_seconds,
        OffsetDateTime::now_utc,
    )
    .await
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let region = env::var("UBEEQ_ROUTING_DIRECTORY_REGION")?;
    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region))
        .load()
        .await;
    let store = MigrationStore::new(
        aws_sdk_dynamodb::Client::new(&config),
        env::var("UBEEQ_ROUTING_DIRECTORY_TABLE_NAME")?,
    );
    run(service_fn(|event: LambdaEvent<Batch>| async {
        let mut failures = Vec::new();
        for record in event.payload.records {
            let checkpoint = match serde_json::from_str::<Command>(&record.body) {
                Ok(command) => {
                    let operation = command.operation;
                    execute(&config, &store, command).await.map(|checkpoint| (checkpoint, operation))
                },
                Err(error) => Err(error.into()),
            };
            match checkpoint {
                Ok((checkpoint, operation)) => {
                    let bytes = checkpoint["objectInventory"].as_array().into_iter().flatten()
                        .filter_map(|object| object["byteLength"].as_u64()).fold(0u64, u64::saturating_add);
                    println!("{}", json!({"event":"ubeeq.migration.command.completed","migrationId":checkpoint["id"],
                        "state":checkpoint["state"],"operation":operation,"sourceCellId":checkpoint["source"]["homeCellId"],
                        "destinationCellId":checkpoint["destination"]["cellId"],"transferBytes":bytes}));
                }
                Err(_) => {
                    eprintln!("{}", json!({"event":"ubeeq.migration.command.failed","messageId":record.message_id}));
                    failures.push(json!({"itemIdentifier":record.message_id}));
                }
            }
        }
        Ok::<_, Error>(json!({"batchItemFailures":failures}))
    })).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_existing_sqs_batch_and_command_shapes() {
        let batch: Batch = serde_json::from_value(json!({"Records":[
            {"messageId":"message","body":r#"{"migrationId":"migration","operation":"resume","rollbackWindowSeconds":60}"#},
        ]})).unwrap();
        assert_eq!(batch.records[0].message_id, "message");
        let command: Command = serde_json::from_str(&batch.records[0].body).unwrap();
        assert_eq!(command.migration_id, "migration");
        assert_eq!(Operation::from(command.operation), Operation::Resume);
        assert_eq!(command.rollback_window_seconds, Some(60));
    }
}
