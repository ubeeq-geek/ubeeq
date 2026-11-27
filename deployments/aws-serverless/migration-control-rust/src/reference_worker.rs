use std::{collections::HashMap, env};

use aws_config::BehaviorVersion;
use aws_sdk_dynamodb::{
    Client,
    types::{AttributeValue, ConditionCheck, Put, TransactWriteItem},
};
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde::Deserialize;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use ubeeq_migration_control_api::{
    lifecycle::Failure,
    reference_jobs::{JobOutcome, JobQueue, failed_asset, processing_job_id},
    reference_media::{copy_rendition, plan_rendition, verify_source},
    store::{attribute, document},
};
use uuid::Uuid;

type Item = HashMap<String, AttributeValue>;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Notification {
    id: String,
    cell_id: String,
    #[serde(rename = "type")]
    kind: String,
}

struct Worker {
    db: Client,
    s3: aws_sdk_s3::Client,
    queue: JobQueue,
    sqs: aws_sdk_sqs::Client,
    queue_url: String,
    table: String,
    bucket: String,
    instance: String,
    cell: String,
}

fn field<'a>(record: &'a Value, key: &str) -> Result<&'a str, Failure> {
    record[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing processing field {key}").into())
}

fn revision(row: &Value) -> Result<u64, Failure> {
    row["revision"]
        .as_u64()
        .filter(|rev| (1..9_007_199_254_740_991).contains(rev))
        .ok_or_else(|| "Invalid processing record revision".into())
}

fn pk(repository: &str, id: &str) -> String {
    format!("{repository}#{id}")
}

fn key(pk: &str, sk: &str) -> Item {
    HashMap::from([
        ("pk".into(), AttributeValue::S(pk.into())),
        ("sk".into(), AttributeValue::S(sk.into())),
    ])
}

fn timestamp(now: OffsetDateTime) -> Result<String, Failure> {
    let whole = now.replace_nanosecond(0)?.format(&Rfc3339)?;
    Ok(format!(
        "{}.{:03}Z",
        whole.trim_end_matches('Z'),
        now.millisecond()
    ))
}

fn stamp(record: &mut Value, asset: &Value, now: &str) {
    for name in [
        "instanceId",
        "homeCellId",
        "dataHomeRegion",
        "dataHomeAssignedAt",
        "routingRevision",
    ] {
        record[name] = asset[name].clone();
    }
    record["revision"] = json!(1);
    record["createdAt"] = json!(now);
    record["updatedAt"] = json!(now);
}

impl Worker {
    async fn raw(&self, pk: &str, sk: &str) -> Result<Option<Item>, Failure> {
        Ok(self
            .db
            .get_item()
            .table_name(&self.table)
            .set_key(Some(key(pk, sk)))
            .consistent_read(true)
            .send()
            .await?
            .item)
    }

    async fn read(&self, repository: &str, id: &str) -> Result<Option<Value>, Failure> {
        self.raw(&pk(repository, id), "record")
            .await?
            .and_then(|mut row| row.remove("value"))
            .map(document)
            .transpose()
    }

    fn check(&self, pk: &str, sk: &str, rev: Option<u64>) -> Result<TransactWriteItem, Failure> {
        let mut check = ConditionCheck::builder()
            .table_name(&self.table)
            .set_key(Some(key(pk, sk)));
        check = if let Some(rev) = rev {
            check
                .condition_expression("#rev = :rev")
                .expression_attribute_names("#rev", "revision")
                .expression_attribute_values(":rev", AttributeValue::N(rev.to_string()))
        } else {
            check.condition_expression("attribute_not_exists(pk)")
        };
        Ok(TransactWriteItem::builder()
            .condition_check(check.build()?)
            .build())
    }

    fn put(
        &self,
        repository: &str,
        record: &Value,
        prior: Option<u64>,
    ) -> Result<TransactWriteItem, Failure> {
        let id = field(record, "id")?;
        let mut item = key(&pk(repository, id), "record");
        item.extend([
            ("repository".into(), AttributeValue::S(repository.into())),
            ("id".into(), AttributeValue::S(id.into())),
            (
                "revision".into(),
                AttributeValue::N(revision(record)?.to_string()),
            ),
            ("value".into(), attribute(record)),
        ]);
        let mut put = Put::builder().table_name(&self.table).set_item(Some(item));
        put = if let Some(prior) = prior {
            put.condition_expression("#rev = :rev")
                .expression_attribute_names("#rev", "revision")
                .expression_attribute_values(":rev", AttributeValue::N(prior.to_string()))
        } else {
            put.condition_expression("attribute_not_exists(pk)")
        };
        Ok(TransactWriteItem::builder().put(put.build()?).build())
    }

    async fn fence(&self, repository: &str) -> Result<TransactWriteItem, Failure> {
        let pk = format!("__ubeeq_repository_snapshot#{repository}");
        let prior = self.raw(&pk, "fence").await?;
        let mut item = key(&pk, "fence");
        item.insert(
            "version".into(),
            AttributeValue::S(Uuid::new_v4().to_string()),
        );
        let mut put = Put::builder().table_name(&self.table).set_item(Some(item));
        put = if let Some(prior) = prior {
            put.condition_expression("#version = :version")
                .expression_attribute_names("#version", "version")
                .expression_attribute_values(
                    ":version",
                    prior
                        .get("version")
                        .filter(|value| value.as_s().is_ok())
                        .ok_or("Invalid repository fence")?
                        .clone(),
                )
        } else {
            put.condition_expression("attribute_not_exists(pk)")
        };
        Ok(TransactWriteItem::builder().put(put.build()?).build())
    }

    async fn commit(&self, actions: Vec<TransactWriteItem>) -> Result<(), Failure> {
        self.db
            .transact_write_items()
            .set_transact_items(Some(actions))
            .send()
            .await?;
        Ok(())
    }

    async fn process(&self, lease: &Value) -> Result<(), Failure> {
        let asset_id = field(&lease["payload"], "assetId")?;
        let mut asset = self
            .read("assets", asset_id)
            .await?
            .ok_or("Processing asset is missing")?;
        if asset["id"] != asset_id
            || asset["instanceId"] != self.instance
            || asset["homeCellId"] != self.cell
        {
            return Err("Processing asset is outside the worker cell".into());
        }
        let original_revision = revision(&asset)?;
        if asset["status"] == "ready" {
            return self
                .commit(vec![
                    self.queue
                        .finish(lease, JobOutcome::Completed, OffsetDateTime::now_utc())?,
                    self.check(&pk("assets", asset_id), "record", Some(original_revision))?,
                ])
                .await;
        }
        if !matches!(asset["status"].as_str(), Some("pending" | "processing")) {
            return Err("Processing asset needs explicit recovery".into());
        }
        let source = verify_source(&self.s3, &self.bucket, &self.cell, &asset).await?;
        let plan = plan_rendition(&asset, &source)?;
        let now = timestamp(OffsetDateTime::now_utc())?;
        let mut journal = if let Some(journal) = self.read("hostRecords", &plan.journal_id).await? {
            journal
        } else {
            let mut row = json!({"id":plan.journal_id,"namespace":"runtime-processed-outputs",
                "scopeId":asset["creatorId"],"key":plan.usage_key,"value":plan.journal});
            stamp(&mut row, &asset, &now);
            let actions = vec![
                self.put("hostRecords", &row, None)?,
                self.fence("hostRecords").await?,
                self.queue.guard(lease, OffsetDateTime::now_utc())?,
                self.check(&pk("assets", asset_id), "record", Some(original_revision))?,
                self.check("__ubeeq_repository_snapshot#global-v2", "fence", None)?,
            ];
            if let Err(error) = self.commit(actions).await {
                self.read("hostRecords", &plan.journal_id)
                    .await?
                    .ok_or(error)?
            } else {
                row
            }
        };
        if journal["instanceId"] != self.instance
            || journal["homeCellId"] != self.cell
            || journal["namespace"] != "runtime-processed-outputs"
            || journal["scopeId"] != asset["creatorId"]
            || journal["key"] != plan.usage_key
            || journal["value"]["fingerprint"] != plan.journal["fingerprint"]
            || journal["value"]["plan"] != plan.journal["plan"]
            || !journal["value"]["objects"].is_object()
        {
            return Err("Processed output journal requires reconciliation".into());
        }
        self.commit(vec![
            self.queue.guard(lease, OffsetDateTime::now_utc())?,
            self.check(&pk("assets", asset_id), "record", Some(original_revision))?,
        ])
        .await?;
        let primary = field(&journal["value"]["plan"], "primary")?.to_owned();
        let rendition = copy_rendition(&self.s3, &source, &plan).await?;
        if journal["value"]["objects"]
            .get(&primary)
            .is_some_and(|saved| saved != &rendition)
        {
            return Err("Rendition version conflicts with its journal".into());
        }

        let now = timestamp(OffsetDateTime::now_utc())?;
        let journal_revision = revision(&journal)?;
        journal["value"]["objects"][&primary] = rendition.clone();
        journal["revision"] = json!(journal_revision + 1);
        journal["updatedAt"] = json!(now);
        let original = asset["storage"].clone();
        asset["storage"] = rendition;
        asset["originalStorage"] = original;
        asset["deliveryMimeType"] = asset["mimeType"].clone();
        asset["processedRenditions"] = json!([]);
        asset["status"] = json!("ready");
        asset["revision"] = json!(original_revision + 1);
        asset["updatedAt"] = json!(now);
        let mut payload = source.metadata;
        payload["checksum"] = asset["checksum"].clone();
        payload["sourceVersionId"] = asset["objectVersion"].clone();
        payload["renditions"] = json!([source.lineage]);
        payload["outputLineage"] = json!([{"outputId":source.lineage["id"],"sourceVersionId":asset["objectVersion"],"role":"source"}]);
        let mut evidence = json!({"id":Uuid::new_v4().to_string(),"subjectType":"asset","subjectId":asset_id,
            "source":"local.processing","payload":payload});
        let mut usage = json!({"id":Uuid::new_v4().to_string(),"accountId":asset["creatorId"],
            "meter":"processing_units","quantity":1,"idempotencyKey":format!("asset-processing:{asset_id}:{}",field(&asset,"objectVersion")?)});
        let mut audit = json!({"id":Uuid::new_v4().to_string(),"action":"asset.processing_completed","subjectId":asset_id,
            "payload":{"jobId":lease["id"],"sourceVersionId":asset["objectVersion"]}});
        for record in [&mut evidence, &mut usage, &mut audit] {
            stamp(record, &asset, &now);
        }
        let host_fence = self.fence("hostRecords").await?;
        let asset_fence = self.fence("assets").await?;
        self.commit(vec![
            self.put("assets", &asset, Some(original_revision))?,
            self.put("hostRecords", &journal, Some(journal_revision))?,
            self.put("moderationEvidence", &evidence, None)?,
            self.put("usageEvents", &usage, None)?,
            self.put("auditEvents", &audit, None)?,
            host_fence,
            asset_fence,
            self.check("__ubeeq_repository_snapshot#global-v2", "fence", None)?,
            self.queue
                .finish(lease, JobOutcome::Completed, OffsetDateTime::now_utc())?,
        ])
        .await
    }

    async fn repair_upload_notifications(&self) -> Result<(), Failure> {
        let mut cursor = None;
        let mut repaired = 0;
        loop {
            let page = self.db.query().table_name(&self.table)
                .index_name("repository-id-index")
                .key_condition_expression("#repository = :repository")
                .filter_expression("#value.#namespace = :namespace AND #value.#instance = :instance AND #value.#cell = :cell AND #value.#intent.#phase = :completed AND #value.#intent.#queue = :pending")
                .expression_attribute_names("#repository","repository")
                .expression_attribute_names("#value","value")
                .expression_attribute_names("#namespace","namespace")
                .expression_attribute_names("#instance","instanceId")
                .expression_attribute_names("#cell","homeCellId")
                .expression_attribute_names("#intent","value")
                .expression_attribute_names("#phase","phase")
                .expression_attribute_names("#queue","queueState")
                .expression_attribute_values(":repository",AttributeValue::S("hostRecords".into()))
                .expression_attribute_values(":namespace",AttributeValue::S("runtime-upload".into()))
                .expression_attribute_values(":instance",AttributeValue::S(self.instance.clone()))
                .expression_attribute_values(":cell",AttributeValue::S(self.cell.clone()))
                .expression_attribute_values(":completed",AttributeValue::S("completed".into()))
                .expression_attribute_values(":pending",AttributeValue::S("pending".into()))
                .limit(100).set_exclusive_start_key(cursor).send().await?;
            for entry in page.items() {
                let Some(id) = entry.get("id").and_then(|value| value.as_s().ok()) else {
                    continue;
                };
                match self.reoffer_upload(id).await {
                    Ok(true) => repaired += 1,
                    Ok(false) => {}
                    Err(_) => eprintln!("Upload processing notification remains pending"),
                }
                if repaired >= 25 {
                    return Ok(());
                }
            }
            cursor = page.last_evaluated_key;
            if cursor.as_ref().is_none_or(HashMap::is_empty) {
                return Ok(());
            }
        }
    }

    async fn reoffer_upload(&self, id: &str) -> Result<bool, Failure> {
        let Some(mut row) = self.read("hostRecords", id).await? else {
            return Ok(false);
        };
        let intent = &row["value"];
        if row["namespace"] != "runtime-upload"
            || row["instanceId"] != self.instance
            || row["homeCellId"] != self.cell
            || intent["phase"] != "completed"
            || intent["queueState"] != "pending"
        {
            return Ok(false);
        }
        let asset_id = field(intent, "assetId")?;
        let version = field(&intent["completedObject"], "versionId")?;
        if row["scopeId"] != intent["creatorId"] || row["key"] != intent["uploadId"] {
            return Err("Invalid upload processing receipt".into());
        }
        let asset = self
            .read("assets", asset_id)
            .await?
            .ok_or("Missing upload asset")?;
        if asset["instanceId"] != self.instance
            || asset["homeCellId"] != self.cell
            || asset["creatorId"] != intent["creatorId"]
            || asset["workId"] != intent["workId"]
            || asset["objectVersion"] != version
        {
            return Err("Upload asset is outside its recorded scope".into());
        }
        let queue_key = format!("asset-process:{asset_id}:{version}");
        let job_id = processing_job_id(&self.cell, &queue_key);
        let job = match self.read("durableJobs", &job_id).await? {
            Some(job) => job,
            None => {
                let now = timestamp(OffsetDateTime::now_utc())?;
                let job = json!({"id":job_id,"type":"asset.process","cellId":self.cell,"payload":{"assetId":asset_id},
                    "idempotencyKey":queue_key,"state":"queued","attempt":0,"maxAttempts":3,"availableAt":now,
                    "revision":1,"createdAt":now,"updatedAt":now,"requestCorrelationId":intent["correlationId"]});
                let actions = vec![
                    self.put("durableJobs", &job, None)?,
                    self.check(&pk("assets", asset_id), "record", Some(revision(&asset)?))?,
                    self.check(&pk("hostRecords", id), "record", Some(revision(&row)?))?,
                ];
                if let Err(error) = self.commit(actions).await {
                    self.read("durableJobs", &job_id).await?.ok_or(error)?
                } else {
                    job
                }
            }
        };
        if job["id"] != job_id
            || job["cellId"] != self.cell
            || job["type"] != "asset.process"
            || job["payload"]["assetId"] != asset_id
            || job["idempotencyKey"] != queue_key
        {
            return Err("Invalid upload processing job".into());
        }
        if !matches!(
            job["state"].as_str(),
            Some("completed" | "cancelled" | "dead_lettered")
        ) {
            self.sqs
                .send_message()
                .queue_url(&self.queue_url)
                .message_body(
                    json!({"id":job_id,"type":"asset.process","cellId":self.cell}).to_string(),
                )
                .send()
                .await?;
        }
        let rev = revision(&row)?;
        row["value"]["queueState"] = json!("queued");
        row["value"]["jobId"] = json!(job_id);
        row["revision"] = json!(rev + 1);
        row["updatedAt"] = json!(timestamp(OffsetDateTime::now_utc())?);
        self.commit(vec![
            self.put("hostRecords", &row, Some(rev))?,
            self.fence("hostRecords").await?,
            self.check("__ubeeq_repository_snapshot#global-v2", "fence", None)?,
        ])
        .await?;
        Ok(true)
    }

    async fn one(&self, message: &Message) -> Result<(), Failure> {
        let worker = format!("aws-worker:{}", message.message_id);
        let notification = message
            .body
            .as_deref()
            .map(serde_json::from_str::<Notification>)
            .transpose()?;
        let lease = match notification {
            Some(notification)
                if notification.cell_id == self.cell && notification.kind == "asset.process" =>
            {
                self.queue.lease_notified(&notification.id, &worker).await?
            }
            Some(_) => return Err("SQS notification does not belong to this worker".into()),
            None => self.queue.lease(&worker).await?,
        };
        let Some(lease) = lease else {
            return Ok(());
        };
        if let Err(error) = self.process(&lease).await {
            let now = OffsetDateTime::now_utc();
            let exhausted = lease["attempt"].as_u64() >= lease["maxAttempts"].as_u64();
            let retry = self.queue.finish(
                &lease,
                JobOutcome::Retry {
                    code: "processing_failed".into(),
                    message: "Asset processing could not be completed".into(),
                    at: now + Duration::seconds(1),
                },
                now,
            )?;
            let mut actions = vec![retry];
            if let Some(asset_id) = lease["payload"]["assetId"].as_str()
                && let Some(asset) = self.read("assets", asset_id).await?
                && asset["id"] == asset_id
                && asset["instanceId"] == self.instance
                && asset["homeCellId"] == self.cell
            {
                let updated_at = timestamp(now)?;
                let mut audit = json!({"id":Uuid::new_v4().to_string(),"action":"asset.processing_failed",
                    "subjectId":asset_id,"payload":{"jobId":lease["id"],"attempt":lease["attempt"],
                    "error":{"code":"processing_failed","message":"Asset processing could not be completed"}}});
                stamp(&mut audit, &asset, &updated_at);
                actions.push(self.put("auditEvents", &audit, None)?);
                if exhausted && let Some((failed, previous)) = failed_asset(asset, &updated_at)? {
                    actions.push(self.put("assets", &failed, Some(previous))?);
                    actions.push(self.fence("assets").await?);
                    actions.push(self.check(
                        "__ubeeq_repository_snapshot#global-v2",
                        "fence",
                        None,
                    )?);
                }
            }
            self.commit(actions).await?;
            if !exhausted {
                return Err(error);
            }
        }
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let config = aws_config::defaults(BehaviorVersion::latest()).load().await;
    let db = Client::new(&config);
    let table = env::var("UBEEQ_RECORDS_TABLE")?;
    let cell = env::var("UBEEQ_CELL_ID").or_else(|_| env::var("AWS_REGION"))?;
    let instance = env::var("UBEEQ_INSTANCE_ID").unwrap_or_else(|_| "aws-reference".into());
    let queue_arn = env::var("UBEEQ_JOBS_QUEUE_ARN")?;
    let schedule_arn = env::var("UBEEQ_RECOVERY_SCHEDULE_ARN")?;
    let worker = Worker {
        queue: JobQueue::new(db.clone(), table.clone(), cell.clone(), instance.clone()),
        sqs: aws_sdk_sqs::Client::new(&config),
        queue_url: env::var("UBEEQ_JOBS_QUEUE_URL")?,
        db,
        table,
        cell,
        s3: aws_sdk_s3::Client::new(&config),
        bucket: env::var("UBEEQ_SOURCE_BUCKET")?,
        instance,
    };
    run(service_fn(|event: LambdaEvent<Batch>| async {
        let recovering = event.payload.is_recovery_tick(&schedule_arn);
        if (recovering
            || event
                .payload
                .records
                .iter()
                .any(|message| message.from_queue(&queue_arn)))
            && worker.repair_upload_notifications().await.is_err()
        {
            eprintln!("Upload processing notification repair deferred");
        }
        if recovering {
            worker
                .one(&Message {
                    message_id: event.context.request_id,
                    body: None,
                    event_source: None,
                    event_source_arn: None,
                })
                .await
                .map_err(|_| Error::from("Scheduled processing job could not be completed"))?;
        }
        let mut failures = Vec::new();
        for message in event.payload.records {
            if !message.from_queue(&queue_arn)
                || message.body.is_none()
                || worker.one(&message).await.is_err()
            {
                failures.push(json!({"itemIdentifier":message.message_id}));
            }
        }
        Ok::<_, Error>(json!({"batchItemFailures":failures}))
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

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
