use std::collections::HashMap;

use aws_sdk_dynamodb::{
    Client,
    types::{AttributeValue, ConditionCheck, Put, TransactWriteItem},
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
}

impl JobQueue {
    pub fn new(client: Client, table: String, cell: String) -> Self {
        Self {
            client,
            table,
            cell,
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
                let next = claim(&job, &format!("{worker}:{}", Uuid::new_v4()), due, now)?;
                let put = Put::builder().table_name(&self.table).set_item(Some(job_item(&next)?))
                    .condition_expression("#rev = :rev AND #value.#cell = :cell AND #value.#state = :state AND #value.#due <= :now")
                    .expression_attribute_names("#rev","revision")
                    .expression_attribute_names("#value","value")
                    .expression_attribute_names("#cell","cellId")
                    .expression_attribute_names("#state","state")
                    .expression_attribute_names("#due",due)
                    .expression_attribute_values(":rev",AttributeValue::N(number(&job,"revision")?.to_string()))
                    .expression_attribute_values(":cell",AttributeValue::S(self.cell.clone()))
                    .expression_attribute_values(":state",text(&job,"state")?)
                    .expression_attribute_values(":now",AttributeValue::S(timestamp(now)?))
                    .build()?;
                match self
                    .client
                    .put_item()
                    .table_name(put.table_name)
                    .set_item(Some(put.item))
                    .set_condition_expression(put.condition_expression)
                    .set_expression_attribute_names(put.expression_attribute_names)
                    .set_expression_attribute_values(put.expression_attribute_values)
                    .send()
                    .await
                {
                    Ok(_) if next["state"] == "leased" => return Ok(Some(next)),
                    Ok(_) => {}
                    Err(failure)
                        if failure
                            .as_service_error()
                            .is_some_and(|e| e.is_conditional_check_failed_exception()) => {}
                    Err(failure) => return Err(failure.into()),
                }
            }
            cursor = page.last_evaluated_key;
            if cursor.as_ref().is_none_or(HashMap::is_empty) {
                return Ok(None);
            }
        }
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

fn job_item(job: &Value) -> Result<HashMap<String, AttributeValue>, Failure> {
    let id = job["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Missing job ID")?;
    Ok(HashMap::from([
        ("pk".into(), AttributeValue::S(format!("durableJobs#{id}"))),
        ("sk".into(), AttributeValue::S("record".into())),
        ("repository".into(), AttributeValue::S("durableJobs".into())),
        ("id".into(), AttributeValue::S(id.into())),
        (
            "revision".into(),
            AttributeValue::N(number(job, "revision")?.to_string()),
        ),
        ("value".into(), attribute(job)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

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
