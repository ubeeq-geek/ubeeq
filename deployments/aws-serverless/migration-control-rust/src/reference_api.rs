use std::{
    collections::{BTreeMap, HashMap},
    env,
    time::Duration as StdDuration,
};

use aws_config::{BehaviorVersion, Region};
use aws_credential_types::provider::SharedCredentialsProvider;
use aws_sdk_dynamodb::{
    Client,
    operation::query::builders::QueryFluentBuilder,
    types::{AttributeValue, ConditionCheck, Put, TransactWriteItem},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use ubeeq_migration_control_api::{
    lifecycle::Failure,
    reference_identity::{AccountScope, CognitoIdentity, SignInError},
    store::{MigrationStore, attribute, document},
};
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
    body: Option<String>,
    #[serde(default)]
    is_base64_encoded: bool,
}

#[derive(Deserialize)]
struct RequestContext {
    http: HttpContext,
}

#[derive(Deserialize)]
struct HttpContext {
    method: String,
}

#[derive(Debug, Serialize)]
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
    delivery: Option<(aws_sdk_s3::Client, String)>,
    routing: Option<MigrationStore>,
    identity: Option<CognitoIdentity>,
    password_authentication: bool,
    credentials: Option<SharedCredentialsProvider>,
}

fn repository_page(
    client: &Client,
    table: &str,
    cursor: Option<HashMap<String, AttributeValue>>,
    limit: i32,
    repository: &str,
) -> QueryFluentBuilder {
    client
        .query()
        .table_name(table)
        .index_name("repository-id-index")
        .key_condition_expression("#repository = :repository")
        .expression_attribute_names("#repository", "repository")
        .expression_attribute_values(":repository", AttributeValue::S(repository.into()))
        .limit(limit)
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
        let page = match repository_page(client, table, cursor, 1, "creators")
            .send()
            .await
        {
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

fn bearer(request: &Request) -> Option<&str> {
    let value = request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))?
        .1
        .as_str();
    let (scheme, token) = value.split_once(char::is_whitespace)?;
    let token = token.trim_start();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

async fn creator_session<'a>(
    request: &'a Request,
    runtime: &Runtime,
    id: &str,
) -> Result<(&'a str, String), Response> {
    let token = bearer(request).ok_or_else(|| {
        error(
            401,
            id,
            "authentication_required",
            "A bearer session is required",
        )
    })?;
    let scope = match &runtime.identity {
        Some(identity) => identity.verify_session(token).await,
        None => None,
    };
    match scope {
        Some((AccountScope::Creator, subject)) => Ok((token, subject)),
        Some((AccountScope::Customer, _)) => Err(error(
            403,
            id,
            "creator_access_denied",
            "Customer accounts do not have creator access.",
        )),
        None => Err(error(
            401,
            id,
            "authentication_invalid",
            "The session is invalid or expired",
        )),
    }
}

fn json_body(request: &Request, id: &str) -> Result<Value, Response> {
    let body = request.body.as_deref().unwrap_or_default();
    let bytes = if request.is_base64_encoded {
        STANDARD
            .decode(body)
            .map_err(|_| error(400, id, "invalid_json", "Request body must be JSON"))?
    } else {
        body.as_bytes().to_vec()
    };
    if bytes.len() > 10 * 1024 * 1024 {
        return Err(error(
            413,
            id,
            "payload_too_large",
            "Request body exceeds 10 MiB",
        ));
    }
    if bytes.is_empty() {
        Ok(json!({}))
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|_| error(400, id, "invalid_json", "Request body must be JSON"))
    }
}

fn password_input(request: &Request, id: &str) -> Result<(String, String), Response> {
    let body = json_body(request, id)?;
    let field = |name: &str| {
        body[name]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| error(400, id, "invalid_request", &format!("{name} is required")))
    };
    Ok((field("email")?, field("password")?))
}

async fn sign_in(request: &Request, runtime: &Runtime, id: &str) -> Response {
    let Some(identity) = runtime
        .identity
        .as_ref()
        .filter(|_| runtime.password_authentication)
    else {
        return error(
            404,
            id,
            "local_auth_unavailable",
            "This instance uses an external identity provider",
        );
    };
    let (email, password) = match password_input(request, id) {
        Ok(values) => values,
        Err(response) => return response,
    };
    match identity
        .authenticate(&email, &password, runtime.credentials.as_ref())
        .await
    {
        Ok((token, exp)) => {
            if let Some(timestamp) = OffsetDateTime::from_unix_timestamp(exp)
                .ok()
                .and_then(|timestamp| timestamp.format(&Rfc3339).ok())
            {
                let expires_at = timestamp.replace('Z', ".000Z");
                return respond(
                    200,
                    id,
                    json!({"token": token, "expiresAt": expires_at, "requestId": id}),
                );
            }
            sign_in_unavailable(id)
        }
        Err(SignInError::Invalid) => error(
            401,
            id,
            "invalid_credentials",
            "Sign-in could not be completed with these credentials.",
        ),
        Err(SignInError::Challenge) => error(
            409,
            id,
            "authentication_challenge_required",
            "Complete the required account confirmation, password reset or sign-in challenge before signing in.",
        ),
        Err(SignInError::Unavailable) => sign_in_unavailable(id),
    }
}

fn sign_in_unavailable(id: &str) -> Response {
    error(
        503,
        id,
        "identity_provider_unavailable",
        "Sign-in is temporarily unavailable.",
    )
}

fn creator_selection(request: &Request) -> Option<String> {
    request
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("x-creator-id"))
        .map(|(_, value)| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            url::form_urlencoded::parse(request.raw_query_string.as_bytes())
                .find_map(|(name, value)| (name == "creatorId").then(|| value.trim().to_owned()))
                .filter(|value| !value.is_empty())
        })
}

fn accessible_creator_ids(
    records: &mut [Value],
    operator: Option<&str>,
    subject: &str,
) -> Vec<String> {
    records.sort_by(|a, b| a["createdAt"].as_str().cmp(&b["createdAt"].as_str()));
    let operator = operator.or_else(|| {
        records
            .first()
            .and_then(|first| first["subjectId"].as_str())
    });
    if operator.is_some_and(|operator| !operator.is_empty() && operator != subject) {
        return Vec::new();
    }
    records
        .iter()
        .filter(|record| record["subjectId"].as_str() == Some(subject))
        .filter_map(|record| record["id"].as_str().map(str::to_owned))
        .collect()
}

struct CreatorRecords<'a> {
    client: &'a Client,
    table: &'a str,
    cell: &'a str,
    instance: &'a str,
}

impl CreatorRecords<'_> {
    async fn read(
        &self,
        repository: &str,
        id: &str,
    ) -> Result<Option<Value>, ubeeq_migration_control_api::lifecycle::Failure> {
        let item = self
            .client
            .get_item()
            .table_name(self.table)
            .key("pk", AttributeValue::S(format!("{repository}#{id}")))
            .key("sk", AttributeValue::S("record".into()))
            .consistent_read(true)
            .send()
            .await?
            .item;
        item.and_then(|mut item| item.remove("value"))
            .map(document)
            .transpose()
    }

    async fn list(
        &self,
        repository: &str,
    ) -> Result<Vec<Value>, ubeeq_migration_control_api::lifecycle::Failure> {
        let mut records = Vec::new();
        let mut cursor = None;
        loop {
            let page = repository_page(self.client, self.table, cursor, 100, repository)
                .send()
                .await?;
            for mut item in page.items.unwrap_or_default() {
                if in_cell(&item, self.cell) {
                    let record = document(item.remove("value").ok_or("Missing Creator record")?)?;
                    if record["instanceId"].as_str() == Some(self.instance) {
                        records.push(record);
                    }
                }
            }
            cursor = page.last_evaluated_key;
            if cursor.as_ref().is_none_or(HashMap::is_empty) {
                return Ok(records);
            }
        }
    }

    async fn owned_creator(
        &self,
        id: &str,
        subject: &str,
    ) -> Result<Option<Value>, ubeeq_migration_control_api::lifecycle::Failure> {
        Ok(self.read("creators", id).await?.filter(|record| {
            record["homeCellId"].as_str() == Some(self.cell)
                && record["instanceId"].as_str() == Some(self.instance)
                && record["subjectId"].as_str() == Some(subject)
        }))
    }
}

const DIRECTORY_ERROR: &str = "Collection directory requires reconciliation.";

fn collection_directory(record: &Value, creator: &Value) -> Result<(Vec<String>, bool), Failure> {
    let values = &record["value"];
    if record["homeCellId"] != creator["homeCellId"]
        || record["dataHomeRegion"] != creator["dataHomeRegion"]
        || record["instanceId"] != creator["instanceId"]
        || record["scopeId"] != creator["id"]
        || record["namespace"] != "runtime-collection-directory"
        || record["key"] != "directory"
        || values["schemaVersion"] != 1
    {
        return Err(DIRECTORY_ERROR.into());
    }
    let mut seen = std::collections::HashSet::new();
    let ids = values["collectionIds"]
        .as_array()
        .ok_or(DIRECTORY_ERROR)?
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|id| !id.is_empty() && seen.insert(*id))
                .map(str::to_owned)
                .ok_or(DIRECTORY_ERROR)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let ready = match values.get("requiresMigration") {
        None => true,
        Some(value) => !value.as_bool().ok_or(DIRECTORY_ERROR)?,
    };
    Ok((ids, ready))
}

fn aggregate_members(collection: &Value) -> Option<Vec<String>> {
    let aggregate = &collection["collectionManagement"];
    if aggregate["schemaVersion"] != 1 {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    aggregate["members"]
        .as_array()?
        .iter()
        .enumerate()
        .map(|(index, member)| {
            let work = member["workId"].as_str()?;
            if member["collectionId"] != collection["id"]
                || member["position"] != index
                || work.is_empty()
                || !seen.insert(work)
                || OffsetDateTime::parse(member["addedAt"].as_str()?, &Rfc3339).is_err()
            {
                return None;
            }
            Some(work.to_owned())
        })
        .collect()
}

fn collection_view(collection: &Value, work_ids: Vec<String>, ready: bool) -> Value {
    let fields = [
        "id",
        "creatorId",
        "title",
        "description",
        "type",
        "visibility",
        "slug",
        "slugHistory",
        "status",
        "coverAssetId",
        "createdAt",
        "updatedAt",
        "revision",
        "archivedAt",
        "deletedAt",
        "workPublicationHistoryAt",
    ];
    let mut view: serde_json::Map<String, Value> = fields
        .into_iter()
        .filter_map(|key| {
            collection
                .get(key)
                .cloned()
                .map(|value| (key.into(), value))
        })
        .collect();
    for (name, fallback) in [
        ("type", json!("collection")),
        ("status", json!("draft")),
        ("slug", collection["id"].clone()),
        ("slugHistory", json!([])),
    ] {
        if view.get(name).is_none_or(Value::is_null) {
            view.insert(name.into(), fallback);
        }
    }
    view.insert("managementReady".into(), json!(ready));
    view.insert(
        "permissions".into(),
        json!({"canEdit": ready && collection["status"] != "deleted"}),
    );
    view.insert("workIds".into(), json!(work_ids));
    Value::Object(view)
}

fn same_creator_region(record: &Value, creator: &Value) -> bool {
    record["creatorId"] == creator["id"]
        && record["homeCellId"] == creator["homeCellId"]
        && record["instanceId"] == creator["instanceId"]
        && record["dataHomeRegion"] == creator["dataHomeRegion"]
}

impl CreatorRecords<'_> {
    async fn read_collection_directory(
        &self,
        creator: &Value,
    ) -> Result<(Vec<String>, bool), Failure> {
        let creator_id = creator["id"].as_str().ok_or("Creator ID is missing")?;
        let digest = Sha256::digest(serde_json::to_vec(&[self.instance, creator_id])?);
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        let key = format!("collection-directory-{hex}");
        match self.read("hostRecords", &key).await? {
            Some(directory) => collection_directory(&directory, creator),
            None => Ok((Vec::new(), false)),
        }
    }

    async fn collections(&self, creator: &Value) -> Result<(Vec<Value>, bool), Failure> {
        let (ids, can_create) = self.read_collection_directory(creator).await?;
        let mut rows = Vec::new();
        for id in &ids {
            rows.push(
                self.read("collections", id)
                    .await?
                    .filter(|row| same_creator_region(row, creator))
                    .ok_or(DIRECTORY_ERROR)?,
            );
        }
        rows.extend(self.list("collections").await?.into_iter().filter(|row| {
            same_creator_region(row, creator)
                && row["id"]
                    .as_str()
                    .is_some_and(|id| !ids.iter().any(|known| known == id))
        }));
        let mut legacy = None;
        let mut views = Vec::new();
        for row in rows.into_iter().filter(|row| row["status"] != "deleted") {
            views.push(
                self.collection_with_members(&row, creator, &ids, can_create, &mut legacy)
                    .await?,
            );
        }
        Ok((views, can_create))
    }

    async fn collection_with_members(
        &self,
        row: &Value,
        creator: &Value,
        ids: &[String],
        can_create: bool,
        legacy: &mut Option<Vec<Value>>,
    ) -> Result<Value, Failure> {
        let row_id = row["id"].as_str().ok_or("Collection ID is missing")?;
        let aggregate = aggregate_members(row);
        let ready = can_create && ids.iter().any(|id| id == row_id) && aggregate.is_some();
        let work_ids = if ready {
            aggregate.unwrap_or_default()
        } else {
            let candidates = match aggregate {
                Some(ids) => ids,
                None => {
                    if legacy.is_none() {
                        *legacy = Some(self.list("workMemberships").await?);
                    }
                    let mut rows: Vec<_> = legacy
                        .iter()
                        .flatten()
                        .filter(|member| {
                            member["collectionId"] == row_id
                                && member["dataHomeRegion"] == creator["dataHomeRegion"]
                        })
                        .collect();
                    rows.sort_by_key(|member| member["position"].as_i64());
                    rows.into_iter()
                        .filter_map(|member| member["workId"].as_str().map(str::to_owned))
                        .collect()
                }
            };
            let mut scoped = Vec::new();
            for work_id in candidates {
                if self
                    .read("works", &work_id)
                    .await?
                    .is_some_and(|work| same_creator_region(&work, creator))
                {
                    scoped.push(work_id);
                }
            }
            scoped
        };
        Ok(collection_view(row, work_ids, ready))
    }
}

fn collection_path(path: &str) -> Option<(&str, bool)> {
    let remainder = path.strip_prefix("/v1/collections/")?;
    let (id, works) = match remainder.strip_suffix("/works") {
        Some(id) => (id, true),
        None => (remainder, false),
    };
    (!id.is_empty() && !id.contains('/')).then_some((id, works))
}

fn collection_not_found(id: &str) -> Response {
    error(404, id, "collection_not_found", "Collection not found.")
}

fn migration_request(request: &Request, routing_configured: bool, id: &str) -> Response {
    if let Err(response) = json_body(request, id) {
        return response;
    }
    if routing_configured {
        error(
            503,
            id,
            "migration_worker_unavailable",
            "This cell has read-only routing access; migration execution is not configured",
        )
    } else {
        error(
            503,
            id,
            "regional_control_unavailable",
            "This cell is not configured with a managed routing control plane",
        )
    }
}

async fn migration_history(
    request: &Request,
    runtime: &Runtime,
    creator: &Value,
    id: &str,
) -> Response {
    let Some(store) = &runtime.routing else {
        return error(
            503,
            id,
            "regional_control_unavailable",
            "This cell is not configured with a managed routing control plane",
        );
    };
    let params: Vec<_> = url::form_urlencoded::parse(request.raw_query_string.as_bytes()).collect();
    let param = |key| {
        params
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_ref())
    };
    let limit = param("limit")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|value| !value.is_nan() && *value != 0.0)
        .unwrap_or(50.0)
        .clamp(1.0, 100.0);
    let Some(creator_id) = creator["id"].as_str().filter(|value| !value.is_empty()) else {
        return error(500, id, "internal_error", "Creator ID is missing");
    };
    if limit.fract() != 0.0 {
        return error(
            500,
            id,
            "internal_error",
            "Migration page limit must be an integer",
        );
    }
    match store
        .creator_migrations(
            creator_id,
            limit as i32,
            param("cursor").filter(|value| !value.is_empty()),
        )
        .await
    {
        Ok((migrations, cursor)) => {
            let mut body = json!({"migrations":migrations, "requestId":id});
            if let Some(cursor) = cursor {
                body["nextCursor"] = json!(cursor);
            }
            respond(200, id, body)
        }
        Err(_) => error(
            500,
            id,
            "internal_error",
            "Unable to read migration history",
        ),
    }
}

fn item_key(pk: &str, sk: &str) -> HashMap<String, AttributeValue> {
    HashMap::from([
        ("pk".into(), AttributeValue::S(pk.into())),
        ("sk".into(), AttributeValue::S(sk.into())),
    ])
}

fn build_record(
    repository: &str,
    value: &Value,
) -> Result<HashMap<String, AttributeValue>, Failure> {
    let id = value["id"].as_str().ok_or("Missing record ID")?;
    let mut item = item_key(&format!("{repository}#{id}"), "record");
    item.extend([
        ("id".into(), AttributeValue::S(id.into())),
        ("repository".into(), AttributeValue::S(repository.into())),
        (
            "revision".into(),
            AttributeValue::N(
                value["revision"]
                    .as_u64()
                    .ok_or("Missing record revision")?
                    .to_string(),
            ),
        ),
        ("value".into(), attribute(value)),
    ]);
    Ok(item)
}

fn valid_intent(key: &str) -> bool {
    (1..=128).contains(&key.len())
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn work_intent_digest(
    instance: &str,
    creator: &str,
    actor: &str,
    key: &str,
) -> Result<String, Failure> {
    let digest = Sha256::digest(serde_json::to_vec(&[instance, creator, actor, key])?);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

enum WorkWriteError {
    Held,
    Conflict,
    Reconcile,
    Failed,
}

impl CreatorRecords<'_> {
    async fn raw_get(
        &self,
        pk: &str,
        sk: &str,
    ) -> Result<Option<HashMap<String, AttributeValue>>, Failure> {
        Ok(self
            .client
            .get_item()
            .table_name(self.table)
            .set_key(Some(item_key(pk, sk)))
            .consistent_read(true)
            .send()
            .await?
            .item)
    }

    async fn marker(&self, pk: &str) -> Result<Option<String>, Failure> {
        self.raw_get(pk, "fence")
            .await?
            .map(|item| {
                item.get("version")
                    .and_then(|value| value.as_s().ok())
                    .filter(|version| !version.is_empty())
                    .cloned()
                    .ok_or_else(|| "Repository fence is invalid".into())
            })
            .transpose()
    }

    async fn migration_held(&self, creator: &str) -> Result<bool, Failure> {
        let mut cursor = None;
        loop {
            let page = self
                .client
                .scan()
                .table_name(self.table)
                .consistent_read(true)
                .filter_expression("begins_with(pk, :prefix) AND sk = :record")
                .expression_attribute_values(
                    ":prefix",
                    AttributeValue::S("moderationHolds#".into()),
                )
                .expression_attribute_values(":record", AttributeValue::S("record".into()))
                .set_exclusive_start_key(cursor)
                .send()
                .await?;
            for mut item in page.items.unwrap_or_default() {
                if in_cell(&item, self.cell) {
                    let hold = document(item.remove("value").ok_or("Missing hold record")?)?;
                    if hold["instanceId"] == self.instance
                        && hold["subjectId"] == creator
                        && hold["state"] == "active"
                        && hold["reason"]
                            .as_str()
                            .is_some_and(|reason| reason.starts_with("migration:"))
                    {
                        return Ok(true);
                    }
                }
            }
            cursor = page.last_evaluated_key;
            if cursor.as_ref().is_none_or(HashMap::is_empty) {
                return Ok(false);
            }
        }
    }

    async fn recover_work(
        &self,
        creator: &Value,
        actor: &str,
        title: &str,
        digest: &str,
    ) -> Result<Option<Value>, WorkWriteError> {
        let read = self
            .read("hostRecords", &format!("work-intake-{digest}"))
            .await
            .map_err(|_| WorkWriteError::Failed)?;
        let Some(receipt) = read else {
            return Ok(None);
        };
        let id = format!("work-{digest}");
        if receipt["instanceId"] != self.instance
            || receipt["homeCellId"] != self.cell
            || receipt["namespace"] != "runtime-work-intake"
            || receipt["scopeId"] != creator["id"]
            || receipt["key"] != digest
            || receipt["value"]["schemaVersion"] != 1
            || receipt["value"]["actorId"] != actor
            || receipt["value"]["workId"] != id
        {
            return Err(WorkWriteError::Failed);
        }
        if receipt["value"]["title"] != title {
            return Err(WorkWriteError::Conflict);
        }
        let work = self
            .read("works", &id)
            .await
            .map_err(|_| WorkWriteError::Failed)?
            .filter(|work| same_creator_region(work, creator))
            .ok_or(WorkWriteError::Reconcile)?;
        Ok(Some(work))
    }

    fn item_guard(
        &self,
        pk: &str,
        sk: &str,
        expected: Option<(&str, AttributeValue)>,
    ) -> Result<TransactWriteItem, Failure> {
        let check = ConditionCheck::builder()
            .table_name(self.table)
            .set_key(Some(item_key(pk, sk)));
        let check = match expected {
            Some((field, value)) => check
                .condition_expression("#field = :value")
                .expression_attribute_names("#field", field)
                .expression_attribute_values(":value", value),
            None => check.condition_expression("attribute_not_exists(pk)"),
        };
        Ok(TransactWriteItem::builder()
            .condition_check(check.build()?)
            .build())
    }

    async fn write_work(
        &self,
        creator: &Value,
        actor: &str,
        title: &str,
        digest: Option<&str>,
    ) -> Result<Value, WorkWriteError> {
        let failed = |_| WorkWriteError::Failed;
        let creator_id = creator["id"].as_str().ok_or(WorkWriteError::Failed)?;
        let revision = creator["revision"].as_u64().ok_or(WorkWriteError::Failed)?;
        let hold_fence = "__ubeeq_repository_snapshot#moderationHolds";
        let global = "__ubeeq_repository_snapshot#global-v2";
        let host_fence = "__ubeeq_repository_snapshot#hostRecords";
        let hold_version = self.marker(hold_fence).await.map_err(failed)?;
        if self.migration_held(creator_id).await.map_err(failed)? {
            return Err(WorkWriteError::Held);
        }
        if let Some(digest) = digest
            && let Some(work) = self.recover_work(creator, actor, title, digest).await?
        {
            return self
                .owned_creator(creator_id, actor)
                .await
                .map_err(failed)?
                .filter(|current| current["revision"] == revision)
                .map(|_| work)
                .ok_or(WorkWriteError::Failed);
        }

        let now = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|_| WorkWriteError::Failed)?;
        let work_id = digest
            .map(|key| format!("work-{key}"))
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let stamp = |id: &str| {
            json!({"id":id,"instanceId":self.instance,
            "homeCellId":self.cell,"dataHomeRegion":creator["dataHomeRegion"],
            "dataHomeAssignedAt":creator["dataHomeAssignedAt"],"routingRevision":creator["routingRevision"],
            "revision":1,"createdAt":now,"updatedAt":now})
        };
        let mut work = stamp(&work_id);
        work["creatorId"] = json!(creator_id);
        work["title"] = json!(title);
        work["status"] = json!("draft");

        let record_put = |repository: &str, record: &Value| -> Result<_, Failure> {
            Ok(TransactWriteItem::builder()
                .put(
                    Put::builder()
                        .table_name(self.table)
                        .set_item(Some(build_record(repository, record)?))
                        .condition_expression("attribute_not_exists(pk)")
                        .build()?,
                )
                .build())
        };
        let mut actions = vec![
            record_put("works", &work).map_err(failed)?,
            self.item_guard(
                &format!("creators#{creator_id}"),
                "record",
                Some(("revision", AttributeValue::N(revision.to_string()))),
            )
            .map_err(failed)?,
            self.item_guard(
                hold_fence,
                "fence",
                hold_version.map(|version| ("version", AttributeValue::S(version))),
            )
            .map_err(failed)?,
            self.item_guard(global, "fence", None).map_err(failed)?,
        ];
        if let Some(digest) = digest {
            let mut receipt = stamp(&format!("work-intake-{digest}"));
            receipt["namespace"] = json!("runtime-work-intake");
            receipt["scopeId"] = json!(creator_id);
            receipt["key"] = json!(digest);
            receipt["value"] =
                json!({"schemaVersion":1,"actorId":actor,"title":title,"workId":work_id});
            actions.push(record_put("hostRecords", &receipt).map_err(failed)?);
            let mut item = item_key(host_fence, "fence");
            item.insert(
                "version".into(),
                AttributeValue::S(Uuid::new_v4().to_string()),
            );
            let mut put = Put::builder().table_name(self.table).set_item(Some(item));
            put = match self.marker(host_fence).await.map_err(failed)? {
                Some(version) => put
                    .condition_expression("#version = :version")
                    .expression_attribute_names("#version", "version")
                    .expression_attribute_values(":version", AttributeValue::S(version)),
                None => put.condition_expression("attribute_not_exists(pk)"),
            };
            actions.push(
                TransactWriteItem::builder()
                    .put(put.build().map_err(|_| WorkWriteError::Failed)?)
                    .build(),
            );
        }
        if self
            .client
            .transact_write_items()
            .set_transact_items(Some(actions))
            .send()
            .await
            .is_ok()
        {
            return Ok(work);
        }
        if let Some(digest) = digest
            && self
                .owned_creator(creator_id, actor)
                .await
                .map_err(failed)?
                .is_some_and(|current| current["revision"] == revision)
            && !self.migration_held(creator_id).await.map_err(failed)?
            && let Some(work) = self.recover_work(creator, actor, title, digest).await?
        {
            return Ok(work);
        }
        Err(WorkWriteError::Failed)
    }
}

async fn create_work(
    request: &Request,
    repository: &CreatorRecords<'_>,
    creator: &Value,
    actor: &str,
    id: &str,
) -> Response {
    if creator["subjectId"] != actor
        || creator
            .get("deletion")
            .is_some_and(|value| !value.is_null() && value != false)
        || creator
            .get("status")
            .is_some_and(|status| status != "active")
    {
        return error(
            403,
            id,
            "work_edit_denied",
            "Current Work editing access is required.",
        );
    }
    let body = match json_body(request, id) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let Some(title) = body["title"]
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
    else {
        return error(400, id, "invalid_request", "title is required");
    };
    let digest = match body.get("idempotencyKey") {
        Some(value) => {
            let Some(key) = value.as_str().filter(|key| valid_intent(key)) else {
                return error(
                    400,
                    id,
                    "invalid_work_intent",
                    "Work request identity is invalid.",
                );
            };
            match work_intent_digest(
                repository.instance,
                creator["id"].as_str().unwrap_or_default(),
                actor,
                key,
            ) {
                Ok(digest) => Some(digest),
                Err(_) => return error(500, id, "internal_error", "Unable to create Work"),
            }
        }
        None => None,
    };
    match repository
        .write_work(creator, actor, title, digest.as_deref())
        .await
    {
        Ok(work) => respond(201, id, json!({"work":work,"requestId":id})),
        Err(WorkWriteError::Held) => error(
            409,
            id,
            "migration_source_held",
            "Creator writes are paused while a regional migration is in progress",
        ),
        Err(WorkWriteError::Conflict) => error(
            409,
            id,
            "work_intent_conflict",
            "This Work request identity already belongs to a different title.",
        ),
        Err(WorkWriteError::Reconcile) => error(
            409,
            id,
            "work_intake_requires_reconciliation",
            "The saved Work request requires reconciliation.",
        ),
        Err(WorkWriteError::Failed) => error(500, id, "internal_error", "Unable to create Work"),
    }
}

fn work_edit(work: &Value, body: &Value, id: &str) -> Result<Value, Response> {
    let conflict = || {
        error(
            409,
            id,
            "revision_conflict",
            "Reload the work before saving changes.",
        )
    };
    let revision = work["revision"]
        .as_u64()
        .filter(|revision| *revision < 9_007_199_254_740_991)
        .ok_or_else(conflict)?;
    if body["revision"].as_u64() != Some(revision) {
        return Err(conflict());
    }
    let title = body
        .get("title")
        .filter(|title| !title.is_null())
        .unwrap_or(&work["title"])
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .ok_or_else(|| error(400, id, "invalid_request", "title is required"))?;
    let mut updated = work.clone();
    updated["revision"] = json!(revision + 1);
    updated["title"] = json!(title);
    updated["updatedAt"] = json!(
        OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .map_err(|_| error(500, id, "internal_error", "Unable to update Work"))?
    );
    Ok(updated)
}

impl CreatorRecords<'_> {
    async fn patch_work(
        &self,
        creator: &Value,
        work: &Value,
        updated: &Value,
        hold_version: Option<String>,
    ) -> Result<bool, Failure> {
        let creator_id = creator["id"].as_str().ok_or("Missing Creator ID")?;
        let revision = creator["revision"]
            .as_u64()
            .ok_or("Missing Creator revision")?;
        let prior = work["revision"].as_u64().ok_or("Missing Work revision")?;
        let put = Put::builder()
            .table_name(self.table)
            .set_item(Some(build_record("works", updated)?))
            .condition_expression("#revision = :revision")
            .expression_attribute_names("#revision", "revision")
            .expression_attribute_values(":revision", AttributeValue::N(prior.to_string()))
            .build()?;
        let actions = vec![
            TransactWriteItem::builder().put(put).build(),
            self.item_guard(
                &format!("creators#{creator_id}"),
                "record",
                Some(("revision", AttributeValue::N(revision.to_string()))),
            )?,
            self.item_guard(
                "__ubeeq_repository_snapshot#moderationHolds",
                "fence",
                hold_version.map(|version| ("version", AttributeValue::S(version))),
            )?,
            self.item_guard("__ubeeq_repository_snapshot#global-v2", "fence", None)?,
        ];
        match self
            .client
            .transact_write_items()
            .set_transact_items(Some(actions))
            .send()
            .await
        {
            Ok(_) => Ok(true),
            Err(failure)
                if failure
                    .as_service_error()
                    .is_some_and(|error| match error {
                        aws_sdk_dynamodb::operation::transact_write_items::TransactWriteItemsError::TransactionCanceledException(cancelled) =>
                            cancelled.cancellation_reasons().first().and_then(|reason| reason.code()) == Some("ConditionalCheckFailed"),
                        _ => false,
                    }) =>
            {
                Ok(false)
            }
            Err(failure) => Err(failure.into()),
        }
    }
}

async fn private_work(
    request: &Request,
    repository: &CreatorRecords<'_>,
    creator: &Value,
    work: Value,
    region: &str,
    id: &str,
) -> Response {
    let unavailable = || error(500, id, "internal_error", "Unable to read or update Work");
    let Some(creator_id) = creator["id"].as_str() else {
        return unavailable();
    };
    let writing = request.request_context.http.method == "PATCH";
    let hold_version = if writing {
        match repository
            .marker("__ubeeq_repository_snapshot#moderationHolds")
            .await
        {
            Ok(version) => version,
            Err(_) => return unavailable(),
        }
    } else {
        None
    };
    match repository.migration_held(creator_id).await {
        Ok(true) => {
            return error(
                409,
                id,
                "migration_source_held",
                "Creator writes are paused while a regional migration is in progress",
            );
        }
        Ok(false) => {}
        Err(_) => return unavailable(),
    }
    if work["creatorId"] != creator_id {
        return error(
            403,
            id,
            "work_not_owned",
            "Work does not belong to the current creator",
        );
    }
    if work["dataHomeRegion"] != creator["dataHomeRegion"]
        || work["routingRevision"] != creator["routingRevision"]
    {
        return error(
            409,
            id,
            "data_home_mismatch",
            "Work and creator data homes do not match",
        );
    }
    if !writing {
        let assets = match repository.list("assets").await {
            Ok(assets) => assets
                .into_iter()
                .filter(|asset| asset["workId"] == work["id"] && asset["creatorId"] == creator_id)
                .collect::<Vec<_>>(),
            Err(_) => return unavailable(),
        };
        let publications = match repository.list("publications").await {
            Ok(publications) => publications
                .into_iter()
                .filter(|publication| publication["workId"] == work["id"])
                .collect::<Vec<_>>(),
            Err(_) => return unavailable(),
        };
        return respond(
            200,
            id,
            json!({"work":work,"assets":assets,"publications":publications,"requestId":id}),
        );
    }
    if creator["dataHomeRegion"] != region
        || creator["dataHomeAssignedAt"] != work["dataHomeAssignedAt"]
        || creator
            .get("deletion")
            .is_some_and(|value| !value.is_null() && value != false)
        || creator
            .get("status")
            .is_some_and(|status| status != "active")
    {
        return error(
            403,
            id,
            "work_edit_denied",
            "Current Work editing access is required.",
        );
    }
    let body = match json_body(request, id) {
        Ok(body) => body,
        Err(response) => return response,
    };
    let updated = match work_edit(&work, &body, id) {
        Ok(updated) => updated,
        Err(response) => return response,
    };
    match repository
        .patch_work(creator, &work, &updated, hold_version)
        .await
    {
        Ok(true) => respond(200, id, json!({"work":updated,"requestId":id})),
        Ok(false) => error(
            409,
            id,
            "revision_conflict",
            "Reload the work before saving changes.",
        ),
        Err(_) => unavailable(),
    }
}

async fn creator_read(request: &Request, runtime: &Runtime, id: &str) -> Response {
    let (_, subject) = match creator_session(request, runtime, id).await {
        Ok(session) => session,
        Err(response) => return response,
    };
    let unavailable = || error(500, id, "internal_error", "Unable to read Creator records");
    let Some((client, table)) = &runtime.records else {
        return unavailable();
    };
    let repository = CreatorRecords {
        client,
        table,
        cell: &runtime.cell.id,
        instance: &runtime.instance_id,
    };
    let work = if let Some(work_id) = single_path_id(&request.raw_path, "/v1/works/") {
        match repository.read("works", work_id).await {
            Ok(Some(work))
                if work["id"] == work_id
                    && work["homeCellId"] == repository.cell
                    && work["instanceId"] == repository.instance =>
            {
                Some(work)
            }
            Ok(_) => return error(404, id, "work_not_found", "Work was not found"),
            Err(_) => return unavailable(),
        }
    } else {
        None
    };
    let collection = if let Some((collection_id, false)) = collection_path(&request.raw_path) {
        match repository.read("collections", collection_id).await {
            Ok(Some(record))
                if record["homeCellId"] == runtime.cell.id
                    && record["instanceId"] == runtime.instance_id =>
            {
                Some(record)
            }
            Ok(_) => return collection_not_found(id),
            Err(_) => return unavailable(),
        }
    } else {
        None
    };
    let Ok(claim) = repository
        .read("instanceOperators", &runtime.instance_id)
        .await
    else {
        return unavailable();
    };
    let operator = match &claim {
        Some(record) => match record["actorId"].as_str().filter(|actor| !actor.is_empty()) {
            Some(actor) => Some(actor),
            None => return unavailable(),
        },
        None => None,
    };
    let ids = if operator.is_some_and(|actor| actor != subject) {
        Vec::new()
    } else {
        let Ok(mut records) = repository.list("creators").await else {
            return unavailable();
        };
        accessible_creator_ids(&mut records, operator, &subject)
    };
    if request.raw_path == "/v1/creators" {
        let mut creators = Vec::new();
        for creator_id in ids {
            match repository.owned_creator(&creator_id, &subject).await {
                Ok(Some(record)) => creators.push(record),
                Ok(None) => {}
                Err(_) => return unavailable(),
            }
        }
        return respond(200, id, json!({"creators": creators, "requestId": id}));
    }
    let Some(default_id) = ids.first() else {
        return error(
            403,
            id,
            "creator_access_denied",
            "This account does not have creator access in this instance.",
        );
    };
    let requested = if matches!(
        request.raw_path.as_str(),
        "/v1/migrations/me" | "/v1/migrations"
    ) {
        None
    } else {
        if let Some(work) = &work {
            work["creatorId"].as_str().map(str::to_owned)
        } else {
            creator_selection(request).or_else(|| {
                collection
                    .as_ref()?
                    .get("creatorId")?
                    .as_str()
                    .map(str::to_owned)
            })
        }
    };
    if requested
        .as_ref()
        .is_some_and(|requested| !ids.contains(requested))
    {
        return error(
            403,
            id,
            "creator_not_accessible",
            "The requested creator identity does not belong to your account.",
        );
    }
    let creator_id = requested.as_ref().unwrap_or(default_id);
    match repository.owned_creator(creator_id, &subject).await {
        Ok(Some(record)) => {
            if let Some(work) = work {
                return private_work(
                    request,
                    &repository,
                    &record,
                    work,
                    &runtime.cell.region,
                    id,
                )
                .await;
            }
            if request.raw_path == "/v1/migrations" {
                return migration_request(request, runtime.routing.is_some(), id);
            }
            if request.raw_path == "/v1/migrations/me" {
                return migration_history(request, runtime, &record, id).await;
            }
            if request.raw_path == "/v1/creators/me" {
                return respond(200, id, json!({"creator": record, "requestId": id}));
            }
            if let Some(collection) = collection {
                if collection["creatorId"] != record["id"] {
                    return collection_not_found(id);
                }
                if collection["dataHomeRegion"] != record["dataHomeRegion"]
                    || collection["routingRevision"] != record["routingRevision"]
                {
                    return error(
                        409,
                        id,
                        "data_home_mismatch",
                        "Collection and Creator data homes do not match.",
                    );
                }
                if record["dataHomeRegion"] != runtime.cell.region {
                    return error(404, id, "creator_not_found", "Creator not found.");
                }
                let result = async {
                    let (ids, ready) = repository.read_collection_directory(&record).await?;
                    repository
                        .collection_with_members(&collection, &record, &ids, ready, &mut None)
                        .await
                }
                .await;
                return match result {
                    Ok(view) => respond(200, id, json!({"collection":view,"requestId":id})),
                    Err(failure) if failure.to_string() == DIRECTORY_ERROR => {
                        error(500, id, "internal_error", DIRECTORY_ERROR)
                    }
                    Err(_) => error(500, id, "internal_error", "Unable to read Collection"),
                };
            }
            if record["contentAuthority"] == "retained-v1" {
                return error(
                    503,
                    id,
                    "retained_content_routes_unavailable",
                    "This Creator requires the retained content routes.",
                );
            }
            if request.raw_path == "/v1/works" && request.request_context.http.method == "POST" {
                if record["dataHomeRegion"] != runtime.cell.region {
                    return error(
                        403,
                        id,
                        "work_edit_denied",
                        "Current Work editing access is required.",
                    );
                }
                return create_work(request, &repository, &record, &subject, id).await;
            }
            if request.raw_path == "/v1/works" {
                return match repository.list("works").await {
                    Ok(works) => {
                        let works: Vec<_> = works
                            .into_iter()
                            .filter(|work| {
                                work["creatorId"] == record["id"] && work["status"] != "deleted"
                            })
                            .collect();
                        respond(200, id, json!({"works": works, "requestId": id}))
                    }
                    Err(_) => error(500, id, "internal_error", "Unable to read Works"),
                };
            }
            if record["dataHomeRegion"] != runtime.cell.region {
                return error(404, id, "creator_not_found", "Creator not found.");
            }
            match repository.collections(&record).await {
                Ok((collections, can_create)) => respond(
                    200,
                    id,
                    json!({
                        "collections": collections, "capabilities":{"canCreate":can_create}, "requestId": id
                    }),
                ),
                Err(failure) if failure.to_string() == DIRECTORY_ERROR => {
                    error(500, id, "internal_error", DIRECTORY_ERROR)
                }
                Err(_) => error(500, id, "internal_error", "Unable to read Collections"),
            }
        }
        Ok(None) => error(
            404,
            id,
            "creator_not_found",
            if requested.is_some() {
                "The selected creator was not found"
            } else {
                "No creator profile belongs to the current subject"
            },
        ),
        Err(_) => unavailable(),
    }
}

fn single_path_id<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    path.strip_prefix(prefix)
        .filter(|id| !id.is_empty() && !id.contains('/'))
}

fn delivery_key(key: &str, cell: &str, creator: &str) -> bool {
    let canonical = |part: &str| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && !part
                .bytes()
                .any(|byte| byte <= 31 || byte == 127 || matches!(byte, b'%' | b'\\'))
    };
    canonical(cell)
        && canonical(creator)
        && !cell.contains('/')
        && !creator.contains('/')
        && key.starts_with(&format!("cells/{cell}/creators/{creator}/"))
        && key.split('/').all(canonical)
}

fn has_public_hold(holds: &[Value], creator: &str, work: &str, assets: &[Value]) -> bool {
    holds.iter().any(|hold| {
        hold["state"] == "active"
            && hold["subjectId"].as_str().is_some_and(|subject| {
                subject == creator
                    || subject == work
                    || assets.iter().any(|asset| asset["id"] == subject)
            })
    })
}

async fn public_work(runtime: &Runtime, work_id: &str) -> Result<Option<Value>, Failure> {
    let (client, table) = runtime
        .records
        .as_ref()
        .ok_or("Persistence is not configured")?;
    let repository = CreatorRecords {
        client,
        table,
        cell: &runtime.cell.id,
        instance: &runtime.instance_id,
    };
    let local = |record: &Value| {
        record["instanceId"] == runtime.instance_id && record["homeCellId"] == runtime.cell.id
    };
    let Some(work) = repository.read("works", work_id).await?.filter(|work| {
        local(work)
            && work["id"] == work_id
            && matches!(work["status"].as_str(), Some("ready" | "published"))
    }) else {
        return Ok(None);
    };
    let creator = work["creatorId"]
        .as_str()
        .filter(|creator| !creator.is_empty())
        .ok_or("Missing Work Creator")?;
    if !repository
        .read("creators", creator)
        .await?
        .is_some_and(|record| local(&record) && record["id"] == creator)
    {
        return Ok(None);
    }
    let assets: Vec<_> = repository
        .list("assets")
        .await?
        .into_iter()
        .filter(|asset| {
            asset["workId"] == work_id
                && asset["creatorId"] == creator
                && asset["status"] == "ready"
        })
        .collect();
    let publications: Vec<_> = repository
        .list("publications")
        .await?
        .into_iter()
        .filter(|publication| publication["workId"] == work_id && publication["status"] == "live")
        .collect();
    if assets.is_empty()
        || publications.is_empty()
        || has_public_hold(
            &repository.list("moderationHolds").await?,
            creator,
            work_id,
            &assets,
        )
    {
        return Ok(None);
    }

    let (s3, bucket) = runtime
        .delivery
        .as_ref()
        .ok_or("Delivery is not configured")?;
    let expires_at = (OffsetDateTime::now_utc() + time::Duration::hours(1)).format(&Rfc3339)?;
    let mut delivered = Vec::with_capacity(assets.len());
    for mut asset in assets {
        let storage = &asset["storage"];
        let key = storage["key"]
            .as_str()
            .filter(|key| delivery_key(key, &runtime.cell.id, creator))
            .ok_or("Invalid Work asset key")?;
        let url = s3
            .get_object()
            .bucket(bucket)
            .key(key)
            .set_version_id(storage["versionId"].as_str().map(str::to_owned))
            .presigned(aws_sdk_s3::presigning::PresigningConfig::expires_in(
                StdDuration::from_secs(3600),
            )?)
            .await?;
        if asset["deliveryMimeType"].is_null() {
            asset["deliveryMimeType"] = asset["mimeType"].clone();
        }
        asset["delivery"] = json!({"url":url.uri(), "expiresAt":expires_at});
        delivered.push(asset);
    }
    Ok(Some(
        json!({"work": work, "assets": delivered, "publications": publications}),
    ))
}

fn private_response(mut response: Response) -> Response {
    response
        .headers
        .insert("cache-control", "private, no-store".into());
    response
}

async fn handle(request: Request, runtime: &Runtime) -> Response {
    let id = request
        .headers
        .iter()
        .find(|(name, value)| name.eq_ignore_ascii_case("x-request-id") && !value.is_empty())
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let method = request.request_context.http.method.as_str();
    let path = request.raw_path.as_str();
    if path == "/v1/operations" || path.starts_with("/v1/operations/") {
        return error(
            404,
            &id,
            "operations_unavailable",
            "Operator operations are not configured",
        );
    }
    if matches!(method, "GET" | "PATCH") && single_path_id(path, "/v1/works/").is_some() {
        return creator_read(&request, runtime, &id).await;
    }
    if method == "GET" && collection_path(path).is_some_and(|(_, works)| works) {
        return error(
            405,
            &id,
            "method_not_allowed",
            "Collection method is not supported.",
        );
    }
    if method == "GET"
        && (collection_path(path).is_some()
            || matches!(
                path,
                "/v1/creators"
                    | "/v1/creators/me"
                    | "/v1/works"
                    | "/v1/collections"
                    | "/v1/migrations/me"
            ))
    {
        return creator_read(&request, runtime, &id).await;
    }
    if method == "GET" {
        if let Some(work_id) = single_path_id(path, "/v1/public/works/") {
            let response = match public_work(runtime, work_id).await {
                Ok(Some(mut body)) => {
                    body["requestId"] = json!(id);
                    respond(200, &id, body)
                }
                Ok(None) => error(404, &id, "work_not_found", "Published work was not found"),
                Err(_) => error(500, &id, "internal_error", "Unable to read published Work"),
            };
            return private_response(response);
        }
        if single_path_id(path, "/v1/delivery/").is_some() {
            return private_response(error(
                404,
                &id,
                "delivery_not_found",
                "This delivery URL is served by the configured delivery provider",
            ));
        }
    }
    if method == "POST" && matches!(path, "/v1/migrations" | "/v1/works") {
        return creator_read(&request, runtime, &id).await;
    }
    if (method, path) == ("POST", "/v1/auth/sign-up") {
        return error(
            404,
            &id,
            "local_auth_unavailable",
            "This instance uses an external identity provider",
        );
    }
    if matches!(
        (method, path),
        ("GET" | "POST", "/v1/auth/email-verification")
            | ("POST", "/v1/auth/email-verification/complete")
    ) {
        return error(
            404,
            &id,
            "email_verification_unavailable",
            "Account email verification is unavailable.",
        );
    }
    if (method, path) == ("GET", "/v1/host-capabilities") {
        if let Err(response) = creator_session(&request, runtime, &id).await {
            return response;
        }
        return respond(
            200,
            &id,
            json!({
                "slots": {}, "transforms": {"graphicWatermark": false, "imageAdjustments": false}, "requestId": id
            }),
        );
    }
    if (method, path) == ("POST", "/v1/auth/sign-in") {
        return sign_in(&request, runtime, &id).await;
    }
    if (method, path) == ("POST", "/v1/auth/sign-out") {
        let token = match creator_session(&request, runtime, &id).await {
            Ok((token, _)) => token,
            Err(response) => return response,
        };
        if let Some(identity) = &runtime.identity
            && identity.sign_out(token).await
        {
            return Response {
                status_code: 204,
                headers: BTreeMap::from([
                    ("cache-control", "no-store".into()),
                    ("content-type", "application/json; charset=utf-8".into()),
                    ("x-request-id", id),
                ]),
                body: String::new(),
                is_base64_encoded: None,
            };
        }
        return error(500, &id, "internal_error", "Unable to sign out of Cognito");
    }
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
    let configuration = aws_config::defaults(BehaviorVersion::latest()).load().await;
    let records = env::var("UBEEQ_RECORDS_TABLE")
        .ok()
        .map(|table| (Client::new(&configuration), table));
    let delivery = env::var("UBEEQ_SOURCE_BUCKET")
        .ok()
        .map(|bucket| (aws_sdk_s3::Client::new(&configuration), bucket));
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
    let identity = match (
        env::var("UBEEQ_USER_POOL_ID"),
        env::var("UBEEQ_USER_POOL_CLIENT_ID"),
    ) {
        (Ok(pool), Ok(client)) => Some(CognitoIdentity::new(&pool, client)?),
        (Err(env::VarError::NotPresent), Err(env::VarError::NotPresent)) => None,
        _ => return Err("Cognito user pool and app client must both be configured".into()),
    };
    let password_authentication = env::var("UBEEQ_PASSWORD_AUTH_ENABLED").as_deref() == Ok("true");
    let credentials = if password_authentication && identity.is_some() {
        configuration.credentials_provider()
    } else {
        None
    };
    let runtime = Runtime {
        instance_id: env::var("UBEEQ_INSTANCE_ID").unwrap_or_else(|_| "aws-reference".into()),
        cell,
        records,
        delivery,
        routing,
        identity,
        password_authentication,
        credentials,
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
            delivery: None,
            routing: None,
            identity: None,
            password_authentication: false,
            credentials: None,
        };
        for (path, status, fields) in [
            (
                "/v1/host-capabilities",
                401,
                json!({"error":{"code":"authentication_required","message":"A bearer session is required","requestId":"test-id"}}),
            ),
            (
                "/v1/operations/jobs",
                404,
                json!({"error":{"code":"operations_unavailable","message":"Operator operations are not configured","requestId":"test-id"}}),
            ),
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
    fn creator_reads_respect_claims_legacy_operator_and_selection() {
        let mut records = [
            json!({"id":"later","subjectId":"actor","createdAt":"2026-03-01T00:00:00.000Z"}),
            json!({"id":"first","subjectId":"actor","createdAt":"2026-01-01T00:00:00.000Z"}),
            json!({"id":"other","subjectId":"foreign","createdAt":"2026-02-01T00:00:00.000Z"}),
        ];
        assert_eq!(
            accessible_creator_ids(&mut records, None, "actor"),
            ["first", "later"]
        );
        assert!(accessible_creator_ids(&mut records, None, "foreign").is_empty());
        assert!(accessible_creator_ids(&mut records, Some("foreign"), "actor").is_empty());
        assert_eq!(
            accessible_creator_ids(&mut records, Some("foreign"), "foreign"),
            ["other"]
        );
        let request = serde_json::from_value(json!({
            "rawPath":"/v1/creators/me", "rawQueryString":"creatorId=other",
            "requestContext":{"http":{"method":"GET"}}, "headers":{"x-creator-id":" first "}
        }))
        .unwrap();
        assert_eq!(creator_selection(&request).as_deref(), Some("first"));
    }

    #[test]
    fn work_edits_reject_stale_revisions_and_preserve_status() {
        let work = json!({"id":"w","revision":3,"title":"old","status":"published"});
        assert_eq!(
            work_edit(&work, &json!({"revision":2,"title":"new"}), "id")
                .unwrap_err()
                .status_code,
            409
        );
        let updated = work_edit(&work, &json!({"revision":3,"title":" new "}), "id").unwrap();
        assert_eq!(updated["revision"], 4);
        assert_eq!(updated["title"], "new");
        assert_eq!(updated["status"], "published");
    }
    #[test]
    fn work_intake_uses_existing_node_receipt_identity_and_dynamo_envelope() {
        assert!(valid_intent("intent_1"));
        assert!(!valid_intent("intent/1"));
        assert!(!valid_intent(&"a".repeat(129)));
        assert_eq!(
            work_intent_digest("instance", "creator", "actor", "intent_1").unwrap(),
            "efbab9816cbb65cf1424b708a6d7708aebb86d647e59f31d38208d283f7397cb"
        );
        let work = json!({"id":"work","revision":1,"status":"draft"});
        let item = build_record("works", &work).unwrap();
        assert_eq!(item["pk"], AttributeValue::S("works#work".into()));
        assert_eq!(item["sk"], AttributeValue::S("record".into()));
        assert_eq!(document(item["value"].clone()).unwrap(), work);
    }

    #[test]
    fn public_delivery_keys_and_holds_are_scoped() {
        assert!(delivery_key(
            "cells/c/creators/owner/renditions/id",
            "c",
            "owner"
        ));
        for key in [
            "cells/c/creators/other/renditions/id",
            "cells/other/creators/owner/id",
            "cells/c/creators/owner/../other",
            "cells/c/creators/owner/a%2Fb",
            "cells/c/creators/owner/",
        ] {
            assert!(!delivery_key(key, "c", "owner"));
        }
        let assets = [json!({"id":"asset"})];
        assert!(has_public_hold(
            &[json!({"subjectId":"asset","state":"active"})],
            "owner",
            "work",
            &assets
        ));
        assert!(!has_public_hold(
            &[
                json!({"subjectId":"unrelated","state":"active"}),
                json!({"subjectId":"work","state":"released"})
            ],
            "owner",
            "work",
            &assets
        ));
    }

    #[test]
    fn migration_requests_parse_body_before_reporting_read_only_control() {
        let request = |body| {
            serde_json::from_value(json!({
                "rawPath":"/v1/migrations", "requestContext":{"http":{"method":"POST"}}, "body":body
            }))
            .unwrap()
        };
        for (configured, body, status, code) in [
            (false, "{", 400, "invalid_json"),
            (false, "{}", 503, "regional_control_unavailable"),
            (true, "{}", 503, "migration_worker_unavailable"),
        ] {
            let response = migration_request(&request(body), configured, "req");
            assert_eq!(response.status_code, status);
            assert_eq!(
                serde_json::from_str::<Value>(&response.body).unwrap()["error"]["code"],
                code
            );
        }
    }

    #[test]
    fn collection_directory_and_membership_preserve_management_authority() {
        let creator = json!({"id":"creator","homeCellId":"cell","instanceId":"instance","dataHomeRegion":"region"});
        let mut directory = json!({"homeCellId":"cell","instanceId":"instance","dataHomeRegion":"region",
            "scopeId":"creator","namespace":"runtime-collection-directory","key":"directory",
            "value":{"schemaVersion":1,"collectionIds":["c"]}});
        assert_eq!(
            collection_directory(&directory, &creator).unwrap(),
            (vec!["c".into()], true)
        );
        directory["value"]["requiresMigration"] = json!(true);
        assert!(!collection_directory(&directory, &creator).unwrap().1);
        directory["value"]["collectionIds"] = json!(["c", "c"]);
        assert!(collection_directory(&directory, &creator).is_err());

        let mut collection = json!({"id":"c","creatorId":"creator","internal":"opaque","collectionManagement":{
            "schemaVersion":1,"members":[{"collectionId":"c","workId":"w","position":0,"addedAt":"2026-02-01T00:00:00Z"}]
        }});
        let members = aggregate_members(&collection).unwrap();
        let view = collection_view(&collection, members, false);
        assert_eq!(view["workIds"], json!(["w"]));
        assert_eq!(view["status"], "draft");
        assert_eq!(view["permissions"]["canEdit"], false);
        assert!(view.get("internal").is_none());
        collection["status"] = json!("deleted");
        assert_eq!(
            collection_view(&collection, vec![], true)["permissions"]["canEdit"],
            false
        );
        assert_eq!(collection_path("/v1/collections/a"), Some(("a", false)));
        assert_eq!(
            collection_path("/v1/collections/a/works"),
            Some(("a", true))
        );
        assert_eq!(collection_path("/v1/collections/a/extra"), None);
        collection["collectionManagement"]["members"][0]["position"] = json!(2);
        assert!(aggregate_members(&collection).is_none());
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
