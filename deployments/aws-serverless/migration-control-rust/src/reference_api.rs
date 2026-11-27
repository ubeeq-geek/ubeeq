use std::{
    collections::{BTreeMap, HashMap},
    env,
};

use aws_config::{BehaviorVersion, Region};
use aws_sdk_dynamodb::{
    Client, operation::query::builders::QueryFluentBuilder, types::AttributeValue,
};
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ubeeq_migration_control_api::store::MigrationStore;
use url::Url;
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    raw_path: String,
    #[serde(default)]
    raw_query_string: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    request_context: RequestContext,
}

#[derive(Deserialize)]
struct RequestContext {
    http: HttpContext,
}

#[derive(Deserialize)]
struct HttpContext {
    method: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    status_code: u16,
    headers: BTreeMap<&'static str, String>,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_base64_encoded: Option<bool>,
}

fn respond(status_code: u16, request_id: &str, body: Value) -> Response {
    Response {
        status_code,
        headers: BTreeMap::from([
            ("cache-control", "no-store".into()),
            ("content-type", "application/json; charset=utf-8".into()),
            ("x-request-id", request_id.into()),
        ]),
        body: body.to_string(),
        is_base64_encoded: None,
    }
}

fn error(status: u16, id: &str, code: &str, message: &str) -> Response {
    respond(
        status,
        id,
        json!({"error": {"code": code, "message": message, "requestId": id}}),
    )
}

fn redirect(endpoint: &str, requested_path: &str) -> Option<Url> {
    if !requested_path.starts_with('/') {
        return None;
    }
    let base = Url::parse(endpoint).ok()?;
    if base.scheme() != "https"
        || base.path() != "/"
        || !base.username().is_empty()
        || base.password().is_some()
    {
        return None;
    }
    let target = base.join(requested_path).ok()?;
    (target.origin() == base.origin()
        && !requested_path.starts_with("//")
        && target.username().is_empty()
        && target.password().is_none())
    .then_some(target)
}

fn route_response(route: &Value, query: &str, id: &str) -> Response {
    let requested_path = url::form_urlencoded::parse(query.as_bytes())
        .find_map(|(name, value)| (name == "path").then_some(value));
    if let Some(path) = requested_path.filter(|path| !path.is_empty()) {
        let endpoint = route["endpoint"].as_str().unwrap_or_default();
        return match redirect(endpoint, &path) {
            Some(location) => Response {
                status_code: 307,
                headers: BTreeMap::from([
                    ("cache-control", "no-store".into()),
                    ("location", location.into()),
                    ("x-request-id", id.into()),
                ]),
                body: String::new(),
                is_base64_encoded: Some(true),
            },
            None => error(
                500,
                id,
                "internal_error",
                "A routed request path must be an absolute local path.",
            ),
        };
    }
    let fields = [
        "creatorId",
        "homeCellId",
        "homeRegion",
        "endpoint",
        "routingRevision",
        "state",
    ];
    let public_route: serde_json::Map<String, Value> = fields
        .into_iter()
        .filter_map(|key| route.get(key).map(|value| (key.to_owned(), value.clone())))
        .collect();
    respond(200, id, json!({"route": public_route, "requestId": id}))
}

#[derive(Serialize)]
struct Cell {
    id: String,
    region: String,
    operator: String,
}

struct Runtime {
    instance_id: String,
    cell: Cell,
    records: Option<(Client, String)>,
    routing: Option<MigrationStore>,
}

fn creator_page(
    client: &Client,
    table: &str,
    cursor: Option<HashMap<String, AttributeValue>>,
) -> QueryFluentBuilder {
    client
        .query()
        .table_name(table)
        .index_name("repository-id-index")
        .key_condition_expression("#repository = :repository")
        .expression_attribute_names("#repository", "repository")
        .expression_attribute_values(":repository", AttributeValue::S("creators".into()))
        .limit(1)
        .set_exclusive_start_key(cursor)
}

fn in_cell(item: &HashMap<String, AttributeValue>, cell: &str) -> bool {
    item.get("value")
        .and_then(|value| value.as_m().ok())
        .and_then(|value| value.get("homeCellId"))
        .and_then(|value| value.as_s().ok())
        .is_some_and(|home_cell| home_cell == cell)
}

async fn readiness(runtime: &Runtime, id: &str) -> Response {
    let Some((client, table)) = &runtime.records else {
        return error(
            500,
            id,
            "internal_error",
            "UBEEQ_RECORDS_TABLE is not configured",
        );
    };
    let mut cursor = None;
    loop {
        let page = match creator_page(client, table, cursor).send().await {
            Ok(page) => page,
            Err(_) => return error(500, id, "internal_error", "Unable to check persistence"),
        };
        let found = page
            .items()
            .iter()
            .any(|item| in_cell(item, &runtime.cell.id));
        cursor = page.last_evaluated_key;
        if found || cursor.as_ref().is_none_or(HashMap::is_empty) {
            break;
        }
    }
    respond(
        200,
        id,
        json!({
            "ok": true, "status": "ok", "cell": runtime.cell, "routingRevision": 1,
            "dependencies": [{"name": "persistence", "status": "ok"}], "requestId": id
        }),
    )
}

async fn handle(request: Request, runtime: &Runtime) -> Response {
    let id = request
        .headers
        .iter()
        .find(|(name, value)| name.eq_ignore_ascii_case("x-request-id") && !value.is_empty())
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    if request.request_context.http.method == "GET" {
        if request.raw_path == "/health" {
            return respond(200, &id, json!({"ok": true, "requestId": id}));
        }
        if request.raw_path == "/.well-known/ubeeq" {
            return respond(
                200,
                &id,
                json!({
                    "protocolVersion": "1", "instanceId": runtime.instance_id,
                    "federationEnabled": false, "requestId": id
                }),
            );
        }
        if matches!(request.raw_path.as_str(), "/ready" | "/diagnostics") {
            return readiness(runtime, &id).await;
        }
        if let Some(creator) = request
            .raw_path
            .strip_prefix("/v1/routing/creators/")
            .filter(|id| !id.is_empty() && !id.contains('/'))
        {
            let Some(store) = &runtime.routing else {
                return error(
                    503,
                    &id,
                    "regional_control_unavailable",
                    "This cell is not configured with a managed routing control plane",
                );
            };
            return match store.route_optional(creator).await {
                Ok(Some(route)) => route_response(&route, &request.raw_query_string, &id),
                Ok(None) => error(
                    404,
                    &id,
                    "routing_not_found",
                    "No home cell route exists for this creator",
                ),
                Err(_) => error(
                    500,
                    &id,
                    "internal_error",
                    "Unable to read the home cell route",
                ),
            };
        }
    }
    error(404, &id, "not_found", "Route was not found")
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let aws_region = env::var("AWS_REGION").ok();
    let cell = Cell {
        id: env::var("UBEEQ_CELL_ID")
            .ok()
            .or_else(|| aws_region.clone())
            .unwrap_or_else(|| "aws-reference-cell".into()),
        region: env::var("UBEEQ_CELL_REGION")
            .ok()
            .or(aws_region)
            .unwrap_or_else(|| "unknown".into()),
        operator: env::var("UBEEQ_CELL_OPERATOR").unwrap_or_else(|_| "self-hosted".into()),
    };
    let records = if let Ok(table) = env::var("UBEEQ_RECORDS_TABLE") {
        let configuration = aws_config::defaults(BehaviorVersion::latest()).load().await;
        Some((Client::new(&configuration), table))
    } else {
        None
    };
    let routing = if let Ok(table) = env::var("UBEEQ_ROUTING_DIRECTORY_TABLE_NAME") {
        let region = env::var("UBEEQ_ROUTING_DIRECTORY_REGION")?;
        let configuration = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region))
            .load()
            .await;
        Some(MigrationStore::new(
            aws_sdk_dynamodb::Client::new(&configuration),
            table,
        ))
    } else {
        None
    };
    let runtime = Runtime {
        instance_id: env::var("UBEEQ_INSTANCE_ID").unwrap_or_else(|_| "aws-reference".into()),
        cell,
        records,
        routing,
    };
    run(service_fn(|event: LambdaEvent<Request>| {
        handle_event(event, &runtime)
    }))
    .await
}

async fn handle_event(event: LambdaEvent<Request>, runtime: &Runtime) -> Result<Response, Error> {
    Ok(handle(event.payload, runtime).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn health_preserves_request_id_and_routes_require_configuration() {
        let runtime = Runtime {
            cell: Cell {
                id: "test".into(),
                region: "local".into(),
                operator: "self-hosted".into(),
            },
            instance_id: "reference-test".into(),
            records: None,
            routing: None,
        };
        for (path, status, fields) in [
            ("/health", 200, json!({"ok": true, "requestId": "test-id"})),
            (
                "/.well-known/ubeeq",
                200,
                json!({"protocolVersion": "1", "instanceId": "reference-test", "federationEnabled": false, "requestId": "test-id"}),
            ),
            (
                "/v1/routing/creators/c1",
                503,
                json!({"error": {"code": "regional_control_unavailable", "message": "This cell is not configured with a managed routing control plane", "requestId": "test-id"}}),
            ),
            (
                "/ready",
                500,
                json!({"error": {"code": "internal_error", "message": "UBEEQ_RECORDS_TABLE is not configured", "requestId": "test-id"}}),
            ),
        ] {
            let request = serde_json::from_value(json!({
                "rawPath": path, "requestContext": {"http": {"method": "GET"}},
                "headers": {"X-Request-Id": "test-id"}
            }))
            .unwrap();
            let response = handle(request, &runtime).await;
            assert_eq!(response.status_code, status);
            assert_eq!(response.headers["x-request-id"], "test-id");
            assert_eq!(response.headers["cache-control"], "no-store");
            assert_eq!(
                serde_json::from_str::<Value>(&response.body).unwrap(),
                fields
            );
        }
    }

    #[test]
    fn readiness_only_accepts_creator_records_in_the_current_cell() {
        let item = HashMap::from([(
            "value".into(),
            AttributeValue::M(HashMap::from([(
                "homeCellId".into(),
                AttributeValue::S("local-cell".into()),
            )])),
        )]);
        assert!(in_cell(&item, "local-cell"));
        assert!(!in_cell(&item, "foreign-cell"));
        assert!(!in_cell(&HashMap::new(), "local-cell"));
    }

    #[test]
    fn route_exposes_public_fields_and_redirect_stays_on_home_origin() {
        let route =
            json!({"endpoint": "https://home.example/", "creatorId": "c1", "updatedAt": "private"});
        let result = route_response(&route, "", "id");
        assert_eq!(
            serde_json::from_str::<Value>(&result.body).unwrap()["route"],
            json!({"endpoint": "https://home.example/", "creatorId": "c1"})
        );
        let result = route_response(&route, "path=%2Fstudio%3Fpage%3D2", "id");
        assert_eq!(result.status_code, 307);
        assert_eq!(
            result.headers["location"],
            "https://home.example/studio?page=2"
        );
        for query in ["path=%2F%2Fother.example", "path=%2F%5Cother.example"] {
            assert_eq!(route_response(&route, query, "id").status_code, 500);
        }
    }
}
