use std::env;

use aws_config::{BehaviorVersion, Region};
use aws_sdk_s3::Client;
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde_json::{Value, json};
use ubeeq_migration_control_api::{
    lifecycle::Failure,
    regional::{RegionalCommand, RegionalOperation, RegionalStore},
    store::MigrationStore,
};

async fn execute(
    store: &RegionalStore,
    directory: Option<&MigrationStore>,
    s3: &Client,
    bucket: &str,
    cell: &str,
    region: &str,
    input: Value,
) -> Result<Value, Failure> {
    let command = RegionalCommand::parse(input, cell, region)?;
    match command.operation {
        RegionalOperation::Export => store.export(&command, s3, bucket).await,
        RegionalOperation::Import => store.import(&command, s3, bucket).await,
        RegionalOperation::Retire => {
            let directory =
                directory.ok_or("Retirement requires the configured control-plane directory.")?;
            let checkpoint = directory.checkpoint(command.id()).await?;
            let route = directory.route(command.creator()).await?;
            let destination = &command.checkpoint["destination"];
            let revision = command.checkpoint["source"]["routingRevision"]
                .as_u64()
                .and_then(|value| value.checked_add(1))
                .ok_or("Missing cutover routing revision.")?;
            if checkpoint != command.checkpoint
                || route["creatorId"] != command.creator()
                || route["homeCellId"] != destination["cellId"]
                || route["homeRegion"] != destination["region"]
                || route["endpoint"] != destination["endpoint"]
                || route["routingRevision"].as_u64() != Some(revision)
                || route["state"] != "rollback_available"
            {
                return Err("Retirement checkpoint or destination route changed.".into());
            }
            store.retire(&command, s3, bucket).await
        }
        RegionalOperation::SourceHold
        | RegionalOperation::SourceRelease
        | RegionalOperation::Enable
        | RegionalOperation::Rollback => {
            store.apply_metadata(&command).await?;
            Ok(json!({}))
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let cell = env::var("UBEEQ_CELL_ID")?;
    let region = env::var("UBEEQ_CELL_REGION")?;
    let bucket = env::var("UBEEQ_SOURCE_BUCKET")?;
    if cell.is_empty() || region.is_empty() || bucket.is_empty() {
        return Err("Regional migration configuration is incomplete.".into());
    }
    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region.clone()))
        .load()
        .await;
    let store = RegionalStore::new(
        aws_sdk_dynamodb::Client::new(&config),
        env::var("UBEEQ_RECORDS_TABLE")?,
        env::var("UBEEQ_INSTANCE_ID").unwrap_or_else(|_| "aws-reference".into()),
        cell.clone(),
        region.clone(),
    );
    let directory = match (
        env::var("UBEEQ_ROUTING_DIRECTORY_TABLE_NAME"),
        env::var("UBEEQ_ROUTING_DIRECTORY_REGION"),
    ) {
        (Ok(table), Ok(region)) if !table.is_empty() && !region.is_empty() => {
            let config = config.to_builder().region(Region::new(region)).build();
            Some(MigrationStore::new(
                aws_sdk_dynamodb::Client::new(&config),
                table,
            ))
        }
        _ => None,
    };
    let s3 = Client::new(&config);
    run(service_fn(|event: LambdaEvent<Value>| {
        let store = &store;
        let s3 = &s3;
        let directory = directory.as_ref();
        let (bucket, cell, region) = (&bucket, &cell, &region);
        async move {
            let value = match execute(store, directory, s3, bucket, cell, region, event.payload).await {
                Ok(result) => json!({"result":result}),
                Err(_) => {
                    eprintln!("{}", json!({"event":"ubeeq.migration.cell.failed","requestId":event.context.request_id}));
                    json!({"error":{"message":"Migration cell command failed."}})
                }
            };
            Ok::<_, Error>(value)
        }
    })).await
}
