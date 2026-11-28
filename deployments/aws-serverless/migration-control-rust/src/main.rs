use std::{collections::HashMap, env};

use aws_config::{BehaviorVersion, Region};
use aws_sdk_dynamodb::types::AttributeValue;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde::Serialize;
use serde_json::{Value, json};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use ubeeq_migration_control_api::store::document;
use url::Url;

const ROOT: &str = "/v1/operations/regional/";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    status_code: u16,
    headers: HashMap<&'static str, &'static str>,
    body: String,
}

fn response(status_code: u16, value: Value) -> Response {
    Response {
        status_code,
        headers: HashMap::from([
            ("content-type", "application/json; charset=utf-8"),
            ("cache-control", "no-store"),
        ]),
        body: value.to_string(),
    }
}

fn principal<'a>(arn: &'a str, service: &str) -> Option<(&'a str, &'a str, &'a str)> {
    let parts: Vec<_> = arn.split(':').collect();
    let [prefix, partition, actual_service, region, account, resource] = parts.as_slice() else {
        return None;
    };
    if *prefix != "arn"
        || !["aws", "aws-us-gov", "aws-cn"].contains(partition)
        || *actual_service != service
        || !region.is_empty()
        || account.len() != 12
        || !account.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((partition, account, resource))
}

fn authorized(expected: &str, actual: &str) -> bool {
    if expected.is_empty() || actual.is_empty() {
        return false;
    }
    if expected == actual {
        return true;
    }
    let Some((partition, account, resource)) = principal(expected, "iam") else {
        return false;
    };
    let Some(role) = resource
        .strip_prefix("role/")
        .and_then(|value| value.rsplit('/').next())
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let Some((session_partition, session_account, session)) = principal(actual, "sts") else {
        return false;
    };
    let Some((session_role, session_name)) = session
        .strip_prefix("assumed-role/")
        .and_then(|value| value.split_once('/'))
    else {
        return false;
    };
    partition == session_partition
        && account == session_account
        && role == session_role
        && !session_name.is_empty()
        && !session_name.contains('/')
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Collection {
    Routes,
    Migrations,
    Cells,
}

impl Collection {
    fn keys(self) -> (&'static str, &'static str) {
        match self {
            Self::Routes => ("route", "route"),
            Self::Migrations => ("migration", "checkpoint"),
            Self::Cells => ("cell", "cell"),
        }
    }

    fn project(self, mut value: Value) -> Result<Value, &'static str> {
        fn string(value: &Value) -> bool {
            value.as_str().is_some_and(|v| !v.trim().is_empty())
        }
        fn timestamp(value: &Value) -> bool {
            value
                .as_str()
                .is_some_and(|s| OffsetDateTime::parse(s, &Rfc3339).is_ok())
        }
        fn endpoint(value: &Value) -> bool {
            value
                .as_str()
                .and_then(|s| Url::parse(s).ok())
                .is_some_and(|url| {
                    url.scheme() == "https"
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.path() == "/"
                })
        }
        fn revision(value: &Value) -> bool {
            value
                .as_u64()
                .is_some_and(|v| (1..=MAX_SAFE_INTEGER).contains(&v))
        }
        let valid = match self {
            Self::Routes => {
                ["creatorId", "homeCellId", "homeRegion"]
                    .iter()
                    .all(|k| string(&value[k]))
                    && endpoint(&value["endpoint"])
                    && revision(&value["routingRevision"])
            }
            Self::Migrations => {
                let source = &value["source"];
                let destination = &value["destination"];
                string(&value["id"])
                    && string(&value["creatorId"])
                    && string(&source["homeCellId"])
                    && string(&source["homeRegion"])
                    && revision(&source["routingRevision"])
                    && string(&destination["cellId"])
                    && string(&destination["region"])
                    && source["homeCellId"] != destination["cellId"]
                    && endpoint(&source["endpoint"])
                    && endpoint(&destination["endpoint"])
                    && [
                        "requested",
                        "source_hold",
                        "exported",
                        "transferred",
                        "verified",
                        "cutover",
                        "rolled_back",
                        "retired",
                        "failed",
                    ]
                    .contains(&value["state"].as_str().unwrap_or_default())
            }
            Self::Cells => {
                ["cellId", "region", "migrationEndpoint", "objectBucket"]
                    .iter()
                    .all(|k| string(&value[k]))
                    && endpoint(&value["endpoint"])
                    && timestamp(&value["registeredAt"])
                    && ["active", "draining", "disabled"]
                        .contains(&value["state"].as_str().unwrap_or_default())
            }
        };
        if !valid || !timestamp(&value["updatedAt"]) {
            return Err("Stored control-plane metadata is invalid.");
        }
        if self == Self::Cells {
            let cell = value
                .as_object_mut()
                .ok_or("Stored migration cell is invalid.")?;
            cell.remove("migrationEndpoint");
            cell.remove("objectBucket");
        }
        Ok(value)
    }
}

fn cursor(collection: Collection, input: &str) -> Result<HashMap<String, AttributeValue>, Error> {
    let value: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(input)?)?;
    let pk = collection.keys().0;
    if value.as_object().is_none_or(|o| o.len() != 2) || value["pk"].as_str() != Some(pk) {
        return Err("Invalid control-plane cursor.".into());
    }
    let sk = value["sk"]
        .as_str()
        .filter(|key| !key.is_empty())
        .ok_or("Invalid control-plane cursor.")?;
    Ok(HashMap::from([
        ("pk".into(), AttributeValue::S(pk.into())),
        ("sk".into(), AttributeValue::S(sk.into())),
    ]))
}

enum Route<'a> {
    List(Collection),
    Command {
        migration: &'a str,
        operation: &'a str,
    },
    Missing,
}

fn route<'a>(method: &str, path: &'a str) -> Route<'a> {
    match (method, path.strip_prefix(ROOT)) {
        ("GET", Some("routes")) => Route::List(Collection::Routes),
        ("GET", Some("migrations")) => Route::List(Collection::Migrations),
        ("GET", Some("cells")) => Route::List(Collection::Cells),
        ("POST", Some(rest)) => {
            if let Some((migration, operation)) = rest
                .strip_prefix("migrations/")
                .and_then(|s| s.split_once('/'))
            {
                if !migration.trim().is_empty()
                    && ["resume", "rollback", "retire"].contains(&operation)
                {
                    return Route::Command {
                        migration,
                        operation,
                    };
                }
            }
            Route::Missing
        }
        _ => Route::Missing,
    }
}

fn command(event: &Value, migration: &str, operation: &str) -> Result<Value, Error> {
    let mut payload = json!({"migrationId": migration, "operation": operation});
    if let Some(raw) = event["body"].as_str().filter(|raw| !raw.is_empty()) {
        let bytes = if event["isBase64Encoded"].as_bool().unwrap_or(false) {
            STANDARD.decode(raw)?
        } else {
            raw.as_bytes().to_vec()
        };
        let body: Value = serde_json::from_slice(&bytes)?;
        if !body.is_object() {
            return Err("Migration command body must be an object.".into());
        }
        if let Some(window) = body.get("rollbackWindowSeconds") {
            let window = window
                .as_u64()
                .filter(|n| (1..=MAX_SAFE_INTEGER).contains(n))
                .ok_or("Migration command is invalid.")?;
            payload["rollbackWindowSeconds"] = json!(window);
        }
    }
    Ok(payload)
}

struct Api {
    dynamo: aws_sdk_dynamodb::Client,
    sqs: aws_sdk_sqs::Client,
    table: String,
    queue: String,
    operator: String,
}

impl Api {
    async fn list(&self, collection: Collection, query: &str) -> Result<Value, Error> {
        let (pk, field) = collection.keys();
        let params: Vec<_> = url::form_urlencoded::parse(query.as_bytes()).collect();
        let value = |key| {
            params
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_ref())
        };
        let limit = match value("limit") {
            Some(value) if value.trim().is_empty() => 1,
            Some(value) => value.trim().parse::<i32>()?.clamp(1, 100),
            None => 50,
        };
        let after = value("cursor")
            .filter(|key| !key.is_empty())
            .map(|key| cursor(collection, key))
            .transpose()?;
        let page = self
            .dynamo
            .query()
            .table_name(&self.table)
            .key_condition_expression("pk = :pk")
            .expression_attribute_values(":pk", AttributeValue::S(pk.into()))
            .limit(limit)
            .set_exclusive_start_key(after)
            .send()
            .await?;
        let items = page
            .items()
            .iter()
            .map(|item| {
                let value = document(
                    item.get(field)
                        .cloned()
                        .ok_or("Stored control-plane record is missing.")?,
                )?;
                Ok(collection.project(value)?)
            })
            .collect::<Result<Vec<_>, Error>>()?;
        let mut body = json!({"items":items});
        if let Some(after) = page.last_evaluated_key() {
            let sk = after
                .get("sk")
                .and_then(|v| v.as_s().ok())
                .ok_or("Missing cursor key.")?;
            let bytes = serde_json::to_vec(&json!({"pk":pk,"sk":sk}))?;
            body["nextCursor"] = json!(URL_SAFE_NO_PAD.encode(bytes));
        }
        Ok(body)
    }

    async fn handle(&self, event: Value) -> Response {
        let caller = event["requestContext"]["authorizer"]["iam"]["userArn"]
            .as_str()
            .unwrap_or_default();
        if !authorized(&self.operator, caller) {
            return response(
                403,
                json!({"error":{"code":"operator_authorization_denied","message":"Operator authorization is required."}}),
            );
        }
        let method = event["requestContext"]["http"]["method"]
            .as_str()
            .unwrap_or("GET");
        let path = event["rawPath"].as_str().unwrap_or("/");
        let result = match route(method, path) {
            Route::List(collection) => self
                .list(
                    collection,
                    event["rawQueryString"].as_str().unwrap_or_default(),
                )
                .await
                .map(|body| (200, body)),
            Route::Command {
                migration,
                operation,
            } => self
                .enqueue(&event, migration, operation)
                .await
                .map(|body| (202, body)),
            Route::Missing => {
                return response(
                    404,
                    json!({"error":{"code":"not_found","message":"Operator control-plane route was not found"}}),
                );
            }
        };
        match result {
            Ok((status, body)) => response(status, body),
            Err(_) => response(
                500,
                json!({"error":{"code":"control_plane_error","message":"Control plane failed"}}),
            ),
        }
    }

    async fn enqueue(
        &self,
        event: &Value,
        migration: &str,
        operation: &str,
    ) -> Result<Value, Error> {
        let message = command(event, migration, operation)?;
        self.sqs
            .send_message()
            .queue_url(&self.queue)
            .message_body(message.to_string())
            .send()
            .await?;
        Ok(json!({"migrationId":migration,"operation":operation,"state":"queued"}))
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let region = env::var("UBEEQ_ROUTING_DIRECTORY_REGION")?;
    let config = aws_config::defaults(BehaviorVersion::latest())
        .region(Region::new(region))
        .load()
        .await;
    let api = Api {
        dynamo: aws_sdk_dynamodb::Client::new(&config),
        sqs: aws_sdk_sqs::Client::new(&config),
        table: env::var("UBEEQ_ROUTING_DIRECTORY_TABLE_NAME")?,
        queue: env::var("UBEEQ_MIGRATION_COMMANDS_QUEUE_URL")?,
        operator: env::var("UBEEQ_MIGRATION_OPERATOR_PRINCIPAL_ARN")?,
    };
    run(service_fn(|event: LambdaEvent<Value>| async {
        Ok::<_, Error>(api.handle(event.payload).await)
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binds_authority_to_the_exact_role_account_and_partition() {
        let role = "arn:aws:iam::000000000001:role/path/Operator";
        assert!(authorized(role, role));
        assert!(authorized(
            role,
            "arn:aws:sts::000000000001:assumed-role/Operator/session"
        ));
        assert!(!authorized(
            role,
            "arn:aws:sts::000000000002:assumed-role/Operator/session"
        ));
        assert!(!authorized(
            role,
            "arn:aws-cn:sts::000000000001:assumed-role/Operator/session"
        ));
        assert!(!authorized(
            role,
            "arn:aws:sts::000000000001:assumed-role/Other/session"
        ));
        assert!(!authorized(role, ""));
    }

    #[test]
    fn shares_the_existing_cursor_format_and_rejects_cross_partition_reuse() {
        let encoded = URL_SAFE_NO_PAD.encode(br#"{"pk":"route","sk":"creator"}"#);
        let key = cursor(Collection::Routes, &encoded).unwrap();
        assert_eq!(key["sk"], AttributeValue::S("creator".into()));
        assert!(cursor(Collection::Migrations, &encoded).is_err());
    }

    #[test]
    fn validates_cell_records_and_redacts_private_locations() {
        let mut cell = json!({"cellId":"test","region":"us-east-2","endpoint":"https://cell.test/",
            "migrationEndpoint":"function","objectBucket":"source","state":"active",
            "registeredAt":"2026-11-26T00:00:00.000Z","updatedAt":"2026-11-26T00:00:00.000Z"});
        let public = Collection::Cells.project(cell.clone()).unwrap();
        assert_eq!(public["cellId"], "test");
        assert!(public.get("migrationEndpoint").is_none() && public.get("objectBucket").is_none());
        cell["state"] = json!("unknown");
        assert!(Collection::Cells.project(cell).is_err());
    }

    #[test]
    fn constructs_the_existing_queue_envelope_without_forwarding_other_fields() {
        let path = format!("{ROOT}migrations/id/resume");
        assert!(matches!(
            route("POST", &path),
            Route::Command {
                migration: "id",
                operation: "resume"
            }
        ));
        let event = json!({"body":STANDARD.encode(br#"{"rollbackWindowSeconds":60,"private":"ignored"}"#),"isBase64Encoded":true});
        assert_eq!(
            command(&event, "id", "resume").unwrap(),
            json!({"migrationId":"id","operation":"resume","rollbackWindowSeconds":60})
        );
        assert!(
            command(
                &json!({"body":r#"{"rollbackWindowSeconds":0}"#}),
                "id",
                "resume"
            )
            .is_err()
        );
    }
}
