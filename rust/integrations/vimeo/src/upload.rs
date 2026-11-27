use crate::Error;
use reqwest::{Client, Response, Url};

pub const CHUNK_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub fn upload_url(value: &str) -> Result<Url, Error> {
    let url = Url::parse(value).map_err(|_| "Invalid Vimeo upload URL")?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url
            .host_str()
            .is_some_and(|host| host == "vimeo.com" || host.ends_with(".vimeo.com"))
    {
        return Err("Untrusted Vimeo upload URL".into());
    }
    Ok(url)
}

fn offset_header(response: &Response) -> Result<u64, Error> {
    if !response.status().is_success() {
        return Err(format!("Vimeo upload returned HTTP {}", response.status().as_u16()).into());
    }
    let offset = response
        .headers()
        .get("upload-offset")
        .and_then(|value| value.to_str().ok())
        .ok_or("Vimeo response has no upload offset")?;
    parse_offset(offset)
}

fn parse_offset(offset: &str) -> Result<u64, Error> {
    if offset.is_empty() || !offset.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("Invalid Vimeo upload offset".into());
    }
    offset
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| "Invalid Vimeo upload offset".into())
}

pub struct TusClient(Client);

impl TusClient {
    pub fn new() -> Result<Self, Error> {
        Ok(Self(
            Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(10))
                .timeout(std::time::Duration::from_secs(60))
                .build()?,
        ))
    }

    pub async fn offset(&self, link: &str, source_length: u64) -> Result<u64, Error> {
        let response = self
            .0
            .head(upload_url(link)?)
            .header("tus-resumable", "1.0.0")
            .send()
            .await
            .map_err(|error| error.without_url())?;
        let offset = offset_header(&response)?;
        if offset > source_length {
            return Err("Vimeo upload offset exceeds the source length".into());
        }
        Ok(offset)
    }

    pub async fn append(&self, link: &str, offset: u64, body: Vec<u8>) -> Result<u64, Error> {
        if !(1..=CHUNK_BYTES).contains(&body.len()) {
            return Err("Invalid Vimeo upload chunk length".into());
        }
        let expected = offset
            .checked_add(body.len() as u64)
            .filter(|value| *value <= MAX_SAFE_INTEGER)
            .ok_or("Invalid Vimeo upload range")?;
        let response = self
            .0
            .patch(upload_url(link)?)
            .header("tus-resumable", "1.0.0")
            .header("upload-offset", offset.to_string())
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/offset+octet-stream",
            )
            .body(body)
            .send()
            .await
            .map_err(|error| error.without_url())?;
        let next = offset_header(&response)?;
        if next != expected {
            return Err("Vimeo upload offset did not advance by the chunk length".into());
        }
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admits_only_https_vimeo_upload_capabilities() {
        assert!(upload_url("https://files.tus.vimeo.com/upload/a?ticket=test").is_ok());
        for value in [
            "http://files.tus.vimeo.com/a",
            "https://vimeo.com.other.test/a",
            "https://vimeo.com@other.test/a",
            "https://user@vimeo.com/a",
            "https://vimeo.com:8443/a",
        ] {
            assert!(upload_url(value).is_err());
        }
    }

    #[test]
    fn accepts_only_safe_unsigned_decimal_offsets() {
        assert_eq!(parse_offset("0008").unwrap(), 8);
        assert_eq!(parse_offset("9007199254740991").unwrap(), MAX_SAFE_INTEGER);
        for value in ["", "-1", "1.5", "+1", " 1", "9007199254740992"] {
            assert!(parse_offset(value).is_err());
        }
    }
}
