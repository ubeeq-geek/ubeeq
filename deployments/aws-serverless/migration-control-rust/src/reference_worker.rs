use std::env;

use aws_config::BehaviorVersion;
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde::Deserialize;
use serde_json::json;
use ubeeq_migration_control_api::reference_processing::ProcessingWorker;

#[derive(Deserialize)]
struct Batch {
    #[serde(rename = "Records", default)]
    records: Vec<Message>,
    source: Option<String>,
    #[serde(rename = "detail-type")]
    detail_type: Option<String>,
    #[serde(default)]
    resources: Vec<String>,
}

impl Batch {
    fn is_recovery_tick(&self, schedule_arn: &str) -> bool {
        self.records.is_empty()
            && self.source.as_deref() == Some("aws.events")
            && self.detail_type.as_deref() == Some("Scheduled Event")
            && self.resources == [schedule_arn]
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    message_id: String,
    body: Option<String>,
    event_source: Option<String>,
    #[serde(rename = "eventSourceARN")]
    event_source_arn: Option<String>,
}

impl Message {
    fn from_queue(&self, queue_arn: &str) -> bool {
        self.event_source.as_deref() == Some("aws:sqs")
            && self.event_source_arn.as_deref() == Some(queue_arn)
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::defaults(BehaviorVersion::latest()).load().await;
    let queue_arn = env::var("UBEEQ_JOBS_QUEUE_ARN")?;
    let schedule_arn = env::var("UBEEQ_RECOVERY_SCHEDULE_ARN")?;
    let worker = ProcessingWorker::new(
        &config,
        env::var("UBEEQ_RECORDS_TABLE")?,
        env::var("UBEEQ_CELL_ID").or_else(|_| env::var("AWS_REGION"))?,
        env::var("UBEEQ_INSTANCE_ID").unwrap_or_else(|_| "aws-reference".into()),
        env::var("UBEEQ_SOURCE_BUCKET")?,
        env::var("UBEEQ_JOBS_QUEUE_URL")?,
    );
    run(service_fn(|event: LambdaEvent<Batch>| {
        let (worker, queue_arn, schedule_arn) =
            (&worker, queue_arn.as_str(), schedule_arn.as_str());
        async move {
            let recovering = event.payload.is_recovery_tick(schedule_arn);
            if (recovering
                || event
                    .payload
                    .records
                    .iter()
                    .any(|message| message.from_queue(queue_arn)))
                && worker.repair_upload_notifications().await.is_err()
            {
                eprintln!("Upload processing notification repair deferred");
            }
            if recovering {
                worker
                    .recover_one(&format!("aws-worker:{}", event.context.request_id))
                    .await
                    .map_err(|_| Error::from("Scheduled processing job could not be completed"))?;
            }
            let mut failures = Vec::new();
            for message in event.payload.records {
                let worked = match message.body.as_deref() {
                    Some(body) if message.from_queue(queue_arn) => worker
                        .run_notification(&format!("aws-worker:{}", message.message_id), body)
                        .await
                        .is_ok(),
                    _ => false,
                };
                if !worked {
                    failures.push(json!({"itemIdentifier":message.message_id}));
                }
            }
            Ok::<_, Error>(json!({"batchItemFailures":failures}))
        }
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use ubeeq_migration_control_api::reference_jobs::failed_asset;

    #[test]
    fn terminal_processing_failure_only_changes_an_unfinished_asset() {
        let now = "2026-11-27T00:00:00.000Z";
        for status in ["pending", "processing"] {
            let (failed, previous) =
                failed_asset(json!({"id":"asset","revision":4,"status":status}), now)
                    .unwrap()
                    .unwrap();
            assert_eq!(previous, 4);
            assert_eq!(
                failed,
                json!({"id":"asset","revision":5,"status":"failed","updatedAt":now})
            );
        }
        for status in ["ready", "deleted", "failed"] {
            assert!(
                failed_asset(json!({"id":"asset","revision":4,"status":status}), now)
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn only_an_eventbridge_tick_runs_scheduled_job_recovery() {
        for (payload, expected) in [
            (
                json!({"source":"aws.events","detail-type":"Scheduled Event","resources":["expected-schedule"]}),
                true,
            ),
            (json!({"Records":[]}), false),
            (
                json!({"source":"aws.events","detail-type":"Scheduled Event","resources":["foreign-schedule"]}),
                false,
            ),
            (
                json!({"source":"aws.events","detail-type":"Other Event"}),
                false,
            ),
            (
                json!({"source":"aws.events","detail-type":"Scheduled Event","Records":[{"messageId":"queued"}]}),
                false,
            ),
        ] {
            let batch: Batch = serde_json::from_value(payload).unwrap();
            assert_eq!(batch.is_recovery_tick("expected-schedule"), expected);
        }
    }

    #[test]
    fn an_sqs_delivery_must_identify_the_configured_queue() {
        let message: Message = serde_json::from_value(json!({
            "messageId": "job-notification", "body": "{}", "eventSource": "aws:sqs", "eventSourceARN": "expected-queue"
        })).unwrap();
        assert!(message.from_queue("expected-queue"));
        assert!(!message.from_queue("foreign-queue"));
    }
}
