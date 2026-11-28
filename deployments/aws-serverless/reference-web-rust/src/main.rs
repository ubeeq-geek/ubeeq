use std::{collections::BTreeMap, env, path::PathBuf, time::Duration};

use base64::{Engine, engine::general_purpose::STANDARD};
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use reqwest::{Client, Method, Url, header::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const LIMIT: usize = 6 * 1024 * 1024;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Event {
    raw_path: Option<String>,
    raw_query_string: Option<String>,
    headers: BTreeMap<String, String>,
    body: Option<String>,
    is_base64_encoded: bool,
    request_context: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    status_code: u16,
    headers: BTreeMap<String, String>,
    body: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    is_base64_encoded: bool,
}

impl Response {
    fn new(status_code: u16, mut headers: BTreeMap<String, String>, body: &[u8]) -> Self {
        headers
            .entry("cache-control".into())
            .or_insert_with(|| "no-store".into());
        let content_type = headers
            .get("content-type")
            .map(String::as_str)
            .unwrap_or("");
        let is_base64_encoded =
            !content_type.contains("json") && !content_type.starts_with("text/");
        let body = if is_base64_encoded {
            STANDARD.encode(body)
        } else {
            String::from_utf8_lossy(body).into_owned()
        };
        Self {
            status_code,
            headers,
            body,
            is_base64_encoded,
        }
    }

    fn json(status: u16, value: Value) -> Self {
        Self::new(
            status,
            BTreeMap::from([(
                "content-type".into(),
                "application/json; charset=utf-8".into(),
            )]),
            value.to_string().as_bytes(),
        )
    }
}

struct Web {
    upstream: Url,
    client: Client,
    assets: PathBuf,
}

fn proxy_path(path: &str) -> Option<&str> {
    if let Some(rest) = path.strip_prefix("/api") {
        if !rest.starts_with('/') {
            return None;
        }
        let route = rest.strip_prefix('/').unwrap_or_default();
        let retained = [
            "storefront",
            "connections/paypal",
            "offers",
            "checkouts",
            "purchase-claims",
            "me",
            "auth/email",
            "discord",
            "commerce",
        ]
        .iter()
        .any(|prefix| {
            route == *prefix
                || route
                    .strip_prefix(prefix)
                    .is_some_and(|suffix| suffix.starts_with('/'))
        }) || [
            "webhooks/paypal/",
            "downloads/",
            "private-assets/",
            "previews/",
        ]
        .iter()
        .any(|prefix| route.starts_with(prefix));
        return Some(if retained { path } else { rest });
    }
    (path == "/commerce"
        || ["/v1/", "/commerce/", "/buy/"]
            .iter()
            .any(|prefix| path.starts_with(prefix)))
    .then_some(path)
}

impl Web {
    async fn serve(&self, event: Event) -> Response {
        let path = event.raw_path.as_deref().unwrap_or("/");
        let file = match path {
            "/" | "/workspace" => Some("workspace.html"),
            "/websites" => Some("websites.html"),
            "/website-editor.js" => Some("websites.js"),
            "/extension-contracts" => Some("extension-contracts.json"),
            _ => None,
        };
        if let Some(file) = file {
            return match (
                std::fs::read(self.assets.join(file)),
                std::fs::read(self.assets.join(format!("{file}.headers.json"))),
            ) {
                (Ok(bytes), Ok(headers)) => match serde_json::from_slice(&headers) {
                    Ok(headers) => Response::new(200, headers, &bytes),
                    Err(_) => Response::json(503, json!({"error":"reference_web_unavailable"})),
                },
                _ if path == "/website-editor.js" => {
                    Response::json(503, json!({"error":"website_editor_build_required"}))
                }
                _ => Response::json(503, json!({"error":"reference_web_unavailable"})),
            };
        }
        if path == "/health" {
            return Response::json(200, json!({"status":"ok"}));
        }
        if path == "/api-configuration" {
            return Response::json(
                200,
                json!({"apiPath":"/api","referenceApiUrl":self.upstream.origin().ascii_serialization()}),
            );
        }
        let Some(path) = proxy_path(path) else {
            return Response::json(404, json!({"error":"not_found"}));
        };
        let unavailable = || Response::json(502, json!({"error":"reference_api_unavailable"}));
        let data = event.body.unwrap_or_default();
        let bytes = if event.is_base64_encoded {
            match STANDARD.decode(data) {
                Ok(bytes) => bytes,
                Err(_) => return unavailable(),
            }
        } else {
            data.into_bytes()
        };
        if bytes.len() > MAX_REQUEST_BYTES {
            return Response::json(413, json!({"error":"payload_too_large"}));
        }
        let Ok(method) = Method::from_bytes(
            event.request_context["http"]["method"]
                .as_str()
                .unwrap_or("GET")
                .as_bytes(),
        ) else {
            return unavailable();
        };
        if !bytes.is_empty() && matches!(method, Method::GET | Method::HEAD) {
            return unavailable();
        }
        let mut target = self.upstream.clone();
        target.set_path(path);
        target.set_query(
            event
                .raw_query_string
                .as_deref()
                .filter(|query| !query.is_empty()),
        );
        target.set_fragment(None);
        let mut request = self.client.request(method, target);
        request = request.header(
            "content-type",
            event
                .headers
                .get("content-type")
                .map(String::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("application/json"),
        );
        for (name, value) in event.headers {
            if ["authorization", "idempotency-key", "origin"].contains(&name.as_str())
                || name.starts_with("paypal-")
            {
                request = request.header(name, value);
            }
        }
        if !bytes.is_empty() {
            request = request.body(bytes);
        }
        let Ok(mut result) = request.send().await else {
            return unavailable();
        };
        let status = result.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            return unavailable();
        }
        let headers = response_headers(result.headers());
        let mut body = Vec::new();
        loop {
            match result.chunk().await {
                Ok(Some(chunk)) if body.len() + chunk.len() <= LIMIT => {
                    body.extend_from_slice(&chunk)
                }
                Ok(None) => break,
                _ => return unavailable(),
            }
        }
        let response = Response::new(status, headers, &body);
        if serde_json::to_vec(&response).map_or(true, |data| data.len() > LIMIT) {
            return unavailable();
        }
        response
    }
}

fn response_headers(input: &HeaderMap) -> BTreeMap<String, String> {
    let headers = [
        "content-type",
        "cache-control",
        "content-security-policy",
        "content-disposition",
        "x-content-type-options",
        "x-request-id",
        "referrer-policy",
        "access-control-allow-origin",
        "access-control-allow-headers",
        "access-control-allow-methods",
        "vary",
        "etag",
    ];
    let mut result: BTreeMap<_, _> = headers
        .into_iter()
        .filter_map(|name| {
            input
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(|value| (name.to_owned(), value.to_owned()))
        })
        .collect();
    result
        .entry("content-type".into())
        .or_insert_with(|| "application/json".into());
    result
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let upstream = Url::parse(&env::var("UBEEQ_REFERENCE_WEB_API_URL")?)?;
    if !matches!(upstream.scheme(), "http" | "https")
        || upstream.host().is_none()
        || !upstream.username().is_empty()
        || upstream.password().is_some()
    {
        return Err("Reference API URL must be HTTP(S) without credentials.".into());
    }
    let web = Web {
        upstream,
        client: Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()?,
        assets: PathBuf::from(env::var("LAMBDA_TASK_ROOT").unwrap_or_else(|_| ".".into()))
            .join("assets"),
    };
    run(service_fn(|event: LambdaEvent<Event>| async {
        Ok::<_, Error>(web.serve(event.payload).await)
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};

    #[test]
    fn maps_reference_and_commerce_routes() {
        for (source, target) in [
            ("/api/v1/works", Some("/v1/works")),
            ("/v1/works", Some("/v1/works")),
            ("/api/me", Some("/api/me")),
            ("/api/webhooks/paypal/key", Some("/api/webhooks/paypal/key")),
            ("/api/commerce/status", Some("/api/commerce/status")),
            ("/api/me-extra", Some("/me-extra")),
            ("/commerce", Some("/commerce")),
            ("/buy/work", Some("/buy/work")),
            ("/workspace", None),
        ] {
            assert_eq!(proxy_path(source), target, "{source}");
        }
    }

    #[tokio::test]
    async fn decodes_compressed_binary_proxy_content_and_preserves_selected_headers() {
        let upstream = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}", upstream.local_addr().unwrap())).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                assert!(!line.is_empty());
                request.push_str(&line);
            }
            assert!(request.starts_with("POST /v1/works/a%2Fb?view=private HTTP/1.1"));
            let headers = request.to_ascii_lowercase();
            assert!(headers.contains("authorization: bearer fixture"));
            assert!(headers.contains("idempotency-key: fixture"));
            assert!(
                headers
                    .lines()
                    .any(|line| line.starts_with("accept-encoding:") && line.contains("gzip"))
            );
            assert!(!headers.contains("cookie:"));
            let mut body = [0; 3];
            reader.read_exact(&mut body).unwrap();
            assert_eq!(body, [0, 255, 42]);
            stream.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Encoding: gzip\r\nContent-Disposition: attachment\r\nSet-Cookie: private=test\r\nContent-Length: 23\r\nConnection: close\r\n\r\n\x1f\x8b\x08\x00\x00\x00\x00\x00\x00\xff\x63\xf8\xaf\x05\x00\xb6\xed\xde\xb7\x03\x00\x00\x00").unwrap();
        });
        let web = Web {
            upstream: url,
            client: Client::builder()
                .timeout(Duration::from_secs(3))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            assets: PathBuf::new(),
        };
        let response = web
            .serve(Event {
                raw_path: Some("/api/v1/works/a%2Fb".into()),
                raw_query_string: Some("view=private".into()),
                headers: BTreeMap::from([
                    ("authorization".into(), "Bearer fixture".into()),
                    ("idempotency-key".into(), "fixture".into()),
                    ("cookie".into(), "private=test".into()),
                ]),
                body: Some(STANDARD.encode([0, 255, 42])),
                is_base64_encoded: true,
                request_context: json!({"http":{"method":"POST"}}),
            })
            .await;
        assert_eq!(response.status_code, 206);
        assert_eq!(response.headers["content-disposition"], "attachment");
        assert!(!response.headers.contains_key("set-cookie"));
        assert!(!response.headers.contains_key("content-encoding"));
        assert!(response.is_base64_encoded);
        assert_eq!(STANDARD.decode(response.body).unwrap(), [0, 255, 42]);
        server.join().unwrap();
    }
}
