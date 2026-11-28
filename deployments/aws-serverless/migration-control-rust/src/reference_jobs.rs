use std::collections::HashMap;

use aws_sdk_dynamodb::{
    Client,
    types::{AttributeValue, ConditionCheck, Put, TransactWriteItem, Update},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    lifecycle::Failure,
    store::{attribute, document},
};

pub fn processing_job_id(cell: &str, intent: &str) -> String {
    let hash: String = Sha256::digest(format!("{cell}:{intent}").as_bytes())
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("job-{hash}")
}

fn timestamp(instant: OffsetDateTime) -> Result<String, Failure> {
    let whole = instant.replace_nanosecond(0)?.format(&Rfc3339)?;
    Ok(format!(
        "{}.{:03}Z",
        whole.trim_end_matches('Z'),
        instant.millisecond()
    ))
}

fn text(value: &Value, field: &str) -> Result<AttributeValue, Failure> {
    Ok(AttributeValue::S(
        value[field]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or("Missing durable job field")?
            .to_owned(),
    ))
}

fn number(value: &Value, field: &str) -> Result<u64, Failure> {
    value[field]
        .as_u64()
        .filter(|value| *value < 9_007_199_254_740_991)
        .ok_or_else(|| "Invalid durable job number".into())
}

fn due_field(job: &Value, now: OffsetDateTime) -> Option<&'static str> {
    let field = match job["state"].as_str()? {
        "leased" => "leaseExpiresAt",
        "queued" | "retry_scheduled" => "availableAt",
        _ => return None,
    };
    let due = OffsetDateTime::parse(job[field].as_str()?, &Rfc3339).ok()?;
    (due <= now).then_some(field)
}

fn claim(job: &Value, owner: &str, due: &str, now: OffsetDateTime) -> Result<Value, Failure> {
    let mut next = job.clone();
    let attempt = number(job, "attempt")?;
    let max_attempts = number(job, "maxAttempts")?;
    if next.get("requestCorrelationId").is_none() {
        next["requestCorrelationId"] = if attempt == 0 {
            job["correlationId"].clone()
        } else {
            Value::Null
        };
    }
    if due == "leaseExpiresAt" && attempt >= max_attempts {
        next["state"] = json!("dead_lettered");
        next["lastError"] = json!({"code":"lease_attempts_exhausted","message":"Worker leases expired through the configured attempt budget."});
        next.as_object_mut()
            .ok_or("Invalid job document")?
            .remove("leaseExpiresAt");
    } else {
        next["state"] = json!("leased");
        next["attempt"] = json!(attempt + 1);
        next["leaseExpiresAt"] = json!(timestamp(now + Duration::seconds(60))?);
        next["correlationId"] = json!(owner);
    }
    next["revision"] = json!(number(job, "revision")? + 1);
    next["updatedAt"] = json!(timestamp(now)?);
    Ok(next)
}

pub enum JobOutcome {
    Completed,
    Retry {
        code: String,
        message: String,
        at: OffsetDateTime,
    },
}

pub struct JobQueue {
    client: Client,
    table: String,
    cell: String,
    instance: String,
}

impl JobQueue {
    pub fn new(client: Client, table: String, cell: String, instance: String) -> Self {
        Self {
            client,
            table,
            cell,
            instance,
        }
    }

    pub async fn lease(&self, worker: &str) -> Result<Option<Value>, Failure> {
        let mut cursor = None;
        loop {
            let page = self
                .client
                .query()
                .table_name(&self.table)
                .index_name("repository-id-index")
                .key_condition_expression("#repository = :repository")
                .expression_attribute_names("#repository", "repository")
                .expression_attribute_values(":repository", AttributeValue::S("durableJobs".into()))
                .limit(100)
                .set_exclusive_start_key(cursor)
                .send()
                .await?;
            for row in page.items() {
                let Some(value) = row.get("value") else {
                    continue;
                };
                let job = document(value.clone())?;
                let now = OffsetDateTime::now_utc();
                if job["cellId"] != self.cell || job["type"] != "asset.process" {
                    continue;
                }
                let Some(due) = due_field(&job, now) else {
                    continue;
                };
                if let Some(next) = self.claim_job(&job, worker, due, now).await?
                    && next["state"] == "leased"
                {
                    return Ok(Some(next));
                }
            }
            cursor = page.last_evaluated_key;
            if cursor.as_ref().is_none_or(HashMap::is_empty) {
                return Ok(None);
            }
        }
    }

    async fn claim_job(
        &self,
        job: &Value,
        worker: &str,
        due: &str,
        now: OffsetDateTime,
    ) -> Result<Option<Value>, Failure> {
        let Some(asset_id) = job["payload"]["assetId"]
            .as_str()
            .filter(|id| !id.is_empty())
        else {
            return Ok(None);
        };
        let next = claim(job, &format!("{worker}:{}", Uuid::new_v4()), due, now)?;
        let mut actions = claim_transaction(
            &self.table,
            &self.instance,
            &self.cell,
            asset_id,
            job,
            &next,
            due,
            now,
        )?;
        if next["state"] == "dead_lettered" {
            let item = self
                .client
                .get_item()
                .table_name(&self.table)
                .key("pk", AttributeValue::S(format!("assets#{asset_id}")))
                .key("sk", AttributeValue::S("record".into()))
                .consistent_read(true)
                .send()
                .await?
                .item;
            if let Some(asset) = item
                .and_then(|mut row| row.remove("value"))
                .map(document)
                .transpose()?
                && asset["id"] == asset_id
                && asset["instanceId"] == self.instance
                && asset["homeCellId"] == self.cell
            {
                let guard = actions
                    .pop()
                    .and_then(|action| action.condition_check)
                    .ok_or("Missing asset claim guard")?;
                actions.extend(expired_asset_actions(
                    &self.table,
                    guard,
                    asset,
                    &next,
                    now,
                )?);
            }
        }
        match self
            .client
            .transact_write_items()
            .set_transact_items(Some(actions))
            .send()
            .await
        {
            Ok(_) => Ok(Some(next)),
            Err(failure)
                if matches!(
                    failure.as_service_error(),
                    Some(aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError::TransactionCanceledException(cancelled))
                        if transaction_revision_conflict(cancelled.cancellation_reasons().iter().map(|reason| reason.code()))
                ) =>
            {
                Ok(None)
            }
            Err(failure) => Err(failure.into()),
        }
    }

    pub async fn lease_notified(
        &self,
        job_id: &str,
        worker: &str,
    ) -> Result<Option<Value>, Failure> {
        let mut row = self
            .client
            .get_item()
            .table_name(&self.table)
            .key("pk", AttributeValue::S(format!("durableJobs#{job_id}")))
            .key("sk", AttributeValue::S("record".into()))
            .consistent_read(true)
            .send()
            .await?
            .item
            .ok_or("Notified job is unavailable")?;
        let job = document(row.remove("value").ok_or("Notified job has no record")?)?;
        if job["id"] != job_id || job["cellId"] != self.cell || job["type"] != "asset.process" {
            return Err("Notified job does not belong to this worker".into());
        }
        if matches!(
            job["state"].as_str(),
            Some("completed" | "dead_lettered" | "cancelled")
        ) {
            return Ok(None);
        }
        let now = OffsetDateTime::now_utc();
        let due = due_field(&job, now).ok_or("Notified job is not yet available")?;
        let next = self
            .claim_job(&job, worker, due, now)
            .await?
            .ok_or("Notified job changed while claiming")?;
        Ok((next["state"] == "leased").then_some(next))
    }

    pub fn guard(&self, lease: &Value, now: OffsetDateTime) -> Result<TransactWriteItem, Failure> {
        let put = self
            .finish(lease, JobOutcome::Completed, now)?
            .put
            .ok_or("Missing lease conditions")?;
        let id = lease["id"].as_str().ok_or("Missing job ID")?;
        let check = ConditionCheck::builder()
            .table_name(put.table_name)
            .key("pk", AttributeValue::S(format!("durableJobs#{id}")))
            .key("sk", AttributeValue::S("record".into()))
            .condition_expression(put.condition_expression.ok_or("Missing lease condition")?)
            .set_expression_attribute_names(put.expression_attribute_names)
            .set_expression_attribute_values(put.expression_attribute_values)
            .build()?;
        Ok(TransactWriteItem::builder().condition_check(check).build())
    }

    /// Enlist the final job transition with its effect records in the same transaction.
    pub fn finish(
        &self,
        lease: &Value,
        outcome: JobOutcome,
        now: OffsetDateTime,
    ) -> Result<TransactWriteItem, Failure> {
        if lease["cellId"] != self.cell
            || lease["state"] != "leased"
            || OffsetDateTime::parse(
                lease["leaseExpiresAt"]
                    .as_str()
                    .ok_or("Missing lease expiry")?,
                &Rfc3339,
            )? <= now
        {
            return Err("The current job lease is required".into());
        }
        let mut next = lease.clone();
        match outcome {
            JobOutcome::Completed => next["state"] = json!("completed"),
            JobOutcome::Retry { code, message, at } => {
                next["lastError"] = json!({"code": code, "message": message});
                if number(lease, "attempt")? >= number(lease, "maxAttempts")? {
                    next["state"] = json!("dead_lettered");
                } else {
                    next["state"] = json!("retry_scheduled");
                    next["availableAt"] = json!(timestamp(at)?);
                }
            }
        }
        next.as_object_mut()
            .ok_or("Invalid job document")?
            .remove("leaseExpiresAt");
        next["revision"] = json!(number(lease, "revision")? + 1);
        next["updatedAt"] = json!(timestamp(now)?);
        let put = Put::builder().table_name(&self.table).set_item(Some(job_item(&next)?))
            .condition_expression("#rev = :rev AND #value.#cell = :cell AND #value.#state = :leased AND #value.#owner = :owner AND #value.#expiry = :expiry AND #value.#expiry > :now")
            .expression_attribute_names("#rev","revision")
            .expression_attribute_names("#value","value")
            .expression_attribute_names("#cell","cellId")
            .expression_attribute_names("#state","state")
            .expression_attribute_names("#owner","correlationId")
            .expression_attribute_names("#expiry","leaseExpiresAt")
            .expression_attribute_values(":rev",AttributeValue::N(number(lease,"revision")?.to_string()))
            .expression_attribute_values(":cell",AttributeValue::S(self.cell.clone()))
            .expression_attribute_values(":leased",AttributeValue::S("leased".into()))
            .expression_attribute_values(":owner",text(lease,"correlationId")?)
            .expression_attribute_values(":expiry",text(lease,"leaseExpiresAt")?)
            .expression_attribute_values(":now",AttributeValue::S(timestamp(now)?))
            .build()?;
        Ok(TransactWriteItem::builder().put(put).build())
    }
}

fn claim_transaction(
    table: &str,
    instance: &str,
    cell: &str,
    asset_id: &str,
    job: &Value,
    next: &Value,
    due: &str,
    now: OffsetDateTime,
) -> Result<Vec<TransactWriteItem>, Failure> {
    let put = Put::builder().table_name(table).set_item(Some(job_item(next)?))
                    .condition_expression("#rev = :rev AND #value.#cell = :cell AND #value.#state = :state AND #value.#due <= :now AND #value.#payload.#asset = :asset")
                    .expression_attribute_names("#rev","revision")
                    .expression_attribute_names("#value","value")
                    .expression_attribute_names("#cell","cellId")
                    .expression_attribute_names("#state","state")
                    .expression_attribute_names("#due",due)
                    .expression_attribute_names("#payload","payload")
                    .expression_attribute_names("#asset","assetId")
                    .expression_attribute_values(":rev",AttributeValue::N(number(job,"revision")?.to_string()))
                    .expression_attribute_values(":cell",AttributeValue::S(cell.to_owned()))
                    .expression_attribute_values(":state",text(job,"state")?)
                    .expression_attribute_values(":now",AttributeValue::S(timestamp(now)?))
                    .expression_attribute_values(":asset",AttributeValue::S(asset_id.to_owned()))
                    .build()?;
    let asset = ConditionCheck::builder()
        .table_name(table)
        .key("pk", AttributeValue::S(format!("assets#{asset_id}")))
        .key("sk", AttributeValue::S("record".into()))
        .condition_expression(
            "#value.#id = :asset AND #value.#instance = :instance AND #value.#cell = :cell",
        )
        .expression_attribute_names("#value", "value")
        .expression_attribute_names("#id", "id")
        .expression_attribute_names("#instance", "instanceId")
        .expression_attribute_names("#cell", "homeCellId")
        .expression_attribute_values(":asset", AttributeValue::S(asset_id.to_owned()))
        .expression_attribute_values(":instance", AttributeValue::S(instance.to_owned()))
        .expression_attribute_values(":cell", AttributeValue::S(cell.to_owned()))
        .build()?;
    Ok(vec![
        TransactWriteItem::builder().put(put).build(),
        TransactWriteItem::builder().condition_check(asset).build(),
    ])
}

pub fn transaction_revision_conflict<'a>(codes: impl Iterator<Item = Option<&'a str>>) -> bool {
    let mut conflict = false;
    for code in codes {
        match code {
            Some("ConditionalCheckFailed" | "TransactionConflict") => conflict = true,
            Some("None") => {}
            _ => return false,
        }
    }
    conflict
}

pub fn public_job(mut job: Value) -> Value {
    if let Some(fields) = job.as_object_mut() {
        match fields.remove("requestCorrelationId") {
            Some(Value::String(trace)) => {
                fields.insert("correlationId".into(), Value::String(trace));
            }
            None if fields.get("attempt").and_then(Value::as_u64) == Some(0) => {}
            _ => {
                fields.remove("correlationId");
            }
        }
    }
    job
}

pub fn failed_asset(mut asset: Value, now: &str) -> Result<Option<(Value, u64)>, Failure> {
    if !matches!(asset["status"].as_str(), Some("pending" | "processing")) {
        return Ok(None);
    }
    let previous = number(&asset, "revision")?;
    if previous == 0 {
        return Err("Invalid asset revision".into());
    }
    asset["status"] = json!("failed");
    asset["revision"] = json!(previous + 1);
    asset["updatedAt"] = json!(now);
    Ok(Some((asset, previous)))
}

fn expired_asset_actions(
    table: &str,
    guard: ConditionCheck,
    asset: Value,
    job: &Value,
    now: OffsetDateTime,
) -> Result<Vec<TransactWriteItem>, Failure> {
    let stamp = timestamp(now)?;
    let Some((failed, previous)) = failed_asset(asset, &stamp)? else {
        return Ok(vec![
            TransactWriteItem::builder().condition_check(guard).build(),
        ]);
    };
    let condition = format!("{} AND #rev = :rev", guard.condition_expression);
    let mut values = guard.expression_attribute_values.unwrap_or_default();
    values.insert(":rev".into(), AttributeValue::N(previous.to_string()));
    let mut names = guard.expression_attribute_names.unwrap_or_default();
    names.insert("#rev".into(), "revision".into());
    let asset = Put::builder()
        .table_name(table)
        .set_item(Some(processing_record_item("assets", &failed)?))
        .condition_expression(condition)
        .set_expression_attribute_names(Some(names))
        .set_expression_attribute_values(Some(values))
        .build()?;
    let mut audit = json!({"id":Uuid::new_v4().to_string(),"action":"asset.processing_failed","subjectId":failed["id"],
        "payload":{"jobId":job["id"],"attempt":job["attempt"],"error":job["lastError"]},
        "revision":1,"createdAt":stamp,"updatedAt":stamp});
    for field in [
        "instanceId",
        "homeCellId",
        "dataHomeRegion",
        "dataHomeAssignedAt",
        "routingRevision",
    ] {
        audit[field] = failed[field].clone();
    }
    let audit_write = Put::builder()
        .table_name(table)
        .set_item(Some(processing_record_item("auditEvents", &audit)?))
        .condition_expression("attribute_not_exists(pk)")
        .build()?;
    let fence = Update::builder()
        .table_name(table)
        .key(
            "pk",
            AttributeValue::S("__ubeeq_repository_snapshot#assets".into()),
        )
        .key("sk", AttributeValue::S("fence".into()))
        .update_expression("SET #version = :version")
        .expression_attribute_names("#version", "version")
        .expression_attribute_values(":version", AttributeValue::S(Uuid::new_v4().to_string()))
        .build()?;
    let global = ConditionCheck::builder()
        .table_name(table)
        .key(
            "pk",
            AttributeValue::S("__ubeeq_repository_snapshot#global-v2".into()),
        )
        .key("sk", AttributeValue::S("fence".into()))
        .condition_expression("attribute_not_exists(pk)")
        .build()?;
    Ok(vec![
        TransactWriteItem::builder().put(asset).build(),
        TransactWriteItem::builder().put(audit_write).build(),
        TransactWriteItem::builder().update(fence).build(),
        TransactWriteItem::builder().condition_check(global).build(),
    ])
}

fn job_item(job: &Value) -> Result<HashMap<String, AttributeValue>, Failure> {
    processing_record_item("durableJobs", job)
}

fn processing_record_item(
    repository: &str,
    record: &Value,
) -> Result<HashMap<String, AttributeValue>, Failure> {
    let id = record["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Missing job ID")?;
    Ok(HashMap::from([
        ("pk".into(), AttributeValue::S(format!("{repository}#{id}"))),
        ("sk".into(), AttributeValue::S("record".into())),
        ("repository".into(), AttributeValue::S(repository.into())),
        ("id".into(), AttributeValue::S(id.into())),
        (
            "revision".into(),
            AttributeValue::N(number(record, "revision")?.to_string()),
        ),
        ("value".into(), attribute(record)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expired_final_lease_records_the_asset_failure_and_audit_in_the_claim_transaction() {
        let now = OffsetDateTime::UNIX_EPOCH;
        let job = json!({"id":"job-1","state":"leased","leaseExpiresAt":"1970-01-01T00:00:00.000Z",
            "revision":2,"attempt":2,"maxAttempts":2,"payload":{"assetId":"asset-1"}});
        let terminal = claim(&job, "worker:token", "leaseExpiresAt", now).unwrap();
        let mut actions = claim_transaction(
            "records",
            "i",
            "c",
            "asset-1",
            &job,
            &terminal,
            "leaseExpiresAt",
            now,
        )
        .unwrap();
        let guard = actions.pop().unwrap().condition_check.unwrap();
        let asset = json!({"id":"asset-1","instanceId":"i","homeCellId":"c","status":"processing","revision":5});
        let extras =
            expired_asset_actions("records", guard.clone(), asset, &terminal, now).unwrap();
        actions.extend(extras);
        assert_eq!(actions.len(), 5);
        let updated = actions[1].put.as_ref().unwrap();
        assert_eq!(
            document(updated.item["value"].clone()).unwrap()["status"],
            "failed"
        );
        assert_eq!(
            updated.expression_attribute_values.as_ref().unwrap()[":rev"],
            AttributeValue::N("5".into())
        );
        let audit = actions[2].put.as_ref().unwrap();
        assert_eq!(
            document(audit.item["value"].clone()).unwrap()["payload"]["error"]["code"],
            "lease_attempts_exhausted"
        );
        assert!(actions[3].update.is_some());
        assert!(actions[4].condition_check.is_some());
        let ready =
            expired_asset_actions("records", guard, json!({"status":"ready"}), &terminal, now)
                .unwrap();
        assert_eq!(ready.len(), 1);
        assert!(ready[0].condition_check.is_some());
    }

    #[test]
    fn claim_transaction_binds_the_job_to_the_current_asset_instance_and_cell() {
        let now = OffsetDateTime::UNIX_EPOCH;
        let job = json!({"id":"job-1","state":"queued","availableAt":"1970-01-01T00:00:00.000Z",
            "revision":1,"attempt":0,"maxAttempts":2,"payload":{"assetId":"asset-1"}});
        let next = claim(&job, "worker:token", "availableAt", now).unwrap();
        let actions = claim_transaction(
            "records",
            "instance-1",
            "cell-1",
            "asset-1",
            &job,
            &next,
            "availableAt",
            now,
        )
        .unwrap();
        assert_eq!(actions.len(), 2);
        let put = actions[0].put.as_ref().unwrap();
        assert_eq!(
            put.item["pk"],
            AttributeValue::S("durableJobs#job-1".into())
        );
        assert!(
            put.condition_expression
                .as_deref()
                .unwrap()
                .contains("#value.#payload.#asset = :asset")
        );
        let guard = actions[1].condition_check.as_ref().unwrap();
        assert_eq!(guard.key["pk"], AttributeValue::S("assets#asset-1".into()));
        assert_eq!(
            guard.condition_expression,
            "#value.#id = :asset AND #value.#instance = :instance AND #value.#cell = :cell"
        );
        let values = guard.expression_attribute_values.as_ref().unwrap();
        assert_eq!(values[":instance"], AttributeValue::S("instance-1".into()));
        assert_eq!(values[":cell"], AttributeValue::S("cell-1".into()));
        assert_eq!(
            values[":asset"],
            put.expression_attribute_values.as_ref().unwrap()[":asset"]
        );
    }

    #[test]
    fn claims_due_jobs_and_preserves_the_request_trace_on_recovery() {
        let now = OffsetDateTime::UNIX_EPOCH + Duration::seconds(60);
        let job = json!({"state":"queued","availableAt":"1970-01-01T00:01:00.000Z","revision":1,
            "attempt":0,"maxAttempts":2,"correlationId":"original-request"});
        assert!(due_field(&job, now - Duration::milliseconds(1)).is_none());
        let next = claim(&job, "worker:token", due_field(&job, now).unwrap(), now).unwrap();
        assert_eq!(next["requestCorrelationId"], "original-request");
        assert_eq!(next["correlationId"], "worker:token");
        assert_eq!(next["attempt"], 1);
        let later = now + Duration::seconds(60);
        let exhausted = claim(
            &next,
            "worker:next",
            due_field(&next, later).unwrap(),
            later,
        )
        .unwrap();
        assert_eq!(exhausted["attempt"], 2);
        let end = claim(
            &exhausted,
            "worker:other",
            "leaseExpiresAt",
            later + Duration::seconds(60),
        )
        .unwrap();
        assert_eq!(end["state"], "dead_lettered");
        assert!(end.get("leaseExpiresAt").is_none());
    }
}
