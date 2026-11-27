use crate::Error;
use serde_json::Value;

pub fn video_url(uri: &str) -> Result<String, Error> {
    let valid = uri
        .strip_prefix("/videos/")
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit()));
    if !valid {
        return Err("Invalid Vimeo video URI".into());
    }
    Ok(format!("https://api.vimeo.com{uri}"))
}

pub fn provider_client() -> Result<reqwest::Client, Error> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?)
}

pub async fn read_provider(
    client: &reqwest::Client,
    token: &str,
    uri: &str,
) -> Result<&'static str, Error> {
    let mut response = client
        .get(video_url(uri)?)
        .bearer_auth(token)
        .header(
            reqwest::header::ACCEPT,
            "application/vnd.vimeo.*+json;version=3.4",
        )
        .send()
        .await
        .map_err(reqwest::Error::without_url)?;
    let status = response.status().as_u16();
    if !response.status().is_success() {
        return remote_state(status, &Value::Null);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(reqwest::Error::without_url)?
    {
        if chunk.len() > 1024 * 1024 - body.len() {
            return Err("Vimeo video metadata exceeds the response limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&body)?;
    if !value.is_object() {
        return Err("Invalid Vimeo video metadata".into());
    }
    remote_state(status, &value)
}

pub fn remote_state(status: u16, response: &Value) -> Result<&'static str, Error> {
    match status {
        404 => Ok("MISSING"),
        200..=299 => match response["transcode"]["status"].as_str() {
            Some("complete") => Ok("PUBLISHED"),
            Some("error") => Ok("FAILED"),
            _ => Ok("PROCESSING"),
        },
        _ => Err(format!("Vimeo reconciliation returned HTTP {status}").into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_builds_endpoints_from_numeric_video_uris() {
        assert_eq!(
            video_url("/videos/123").unwrap(),
            "https://api.vimeo.com/videos/123"
        );
        for uri in [
            "/videos/",
            "//other.test/videos/123",
            "/videos/123?next=other",
        ] {
            assert!(video_url(uri).is_err());
        }
    }

    #[test]
    fn remote_status_transitions_match_existing_vimeo_worker() {
        assert_eq!(
            remote_state(200, &json!({"transcode":{"status":"complete"}})).unwrap(),
            "PUBLISHED"
        );
        assert_eq!(
            remote_state(200, &json!({"transcode":{"status":"error"}})).unwrap(),
            "FAILED"
        );
        assert_eq!(remote_state(200, &json!({})).unwrap(), "PROCESSING");
        assert_eq!(remote_state(404, &Value::Null).unwrap(), "MISSING");
        assert!(remote_state(429, &Value::Null).is_err());
    }
}
