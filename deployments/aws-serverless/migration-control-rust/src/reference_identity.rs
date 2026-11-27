use std::time::{Duration, Instant, SystemTime};

use aws_credential_types::provider::{ProvideCredentials, SharedCredentialsProvider};
use aws_sigv4::{
    http_request::{SignableBody, SignableRequest, SigningSettings, sign},
    sign::v4,
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use tokio::sync::Mutex;

#[derive(Deserialize)]
struct Header {
    alg: String,
    kid: String,
}

#[derive(Deserialize)]
pub struct AccessClaims {
    iss: String,
    client_id: String,
    token_use: String,
    pub sub: String,
    pub username: Option<String>,
    pub iat: i64,
    pub exp: i64,
    nbf: Option<i64>,
    #[serde(rename = "custom:account_scope")]
    pub account_scope: Option<String>,
    #[serde(rename = "cognito:groups", default)]
    pub groups: Value,
}

#[derive(Deserialize)]
pub struct Jwk {
    kid: String,
    kty: String,
    alg: String,
    #[serde(rename = "use")]
    usage: String,
    n: String,
    e: String,
}

pub fn verify_access_token(
    token: &str,
    issuer: &str,
    client_id: &str,
    now: i64,
    keys: &[Jwk],
) -> Option<AccessClaims> {
    let (signed, signature) = token.rsplit_once('.')?;
    let (header, payload) = signed.split_once('.')?;
    let header: Header = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).ok()?).ok()?;
    if header.alg != "RS256" || header.kid.is_empty() {
        return None;
    }
    let mut matching = keys.iter().filter(|key| key.kid == header.kid);
    let key = matching.next()?;
    if matching.next().is_some() || key.kty != "RSA" || key.alg != "RS256" || key.usage != "sig" {
        return None;
    }
    let public_key = RsaPublicKeyComponents {
        n: URL_SAFE_NO_PAD.decode(&key.n).ok()?,
        e: URL_SAFE_NO_PAD.decode(&key.e).ok()?,
    };
    public_key
        .verify(
            &RSA_PKCS1_2048_8192_SHA256,
            signed.as_bytes(),
            &URL_SAFE_NO_PAD.decode(signature).ok()?,
        )
        .ok()?;
    let claims: AccessClaims =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    (claims.iss == issuer
        && claims.client_id == client_id
        && claims.token_use == "access"
        && !claims.sub.is_empty()
        && claims.exp > now
        && claims.nbf.is_none_or(|not_before| not_before <= now))
    .then_some(claims)
}

#[derive(Debug, PartialEq)]
pub enum AccountScope {
    Creator,
    Customer,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct UserAttribute {
    name: String,
    value: String,
}

pub fn bind_user(
    claims: &AccessClaims,
    username: &str,
    attributes: &[UserAttribute],
) -> Option<AccountScope> {
    if username.is_empty()
        || claims
            .username
            .as_deref()
            .is_some_and(|issued| issued != username)
    {
        return None;
    }
    let subject = attributes.iter().find(|item| item.name == "sub")?;
    if subject.value != claims.sub {
        return None;
    }
    let mut scopes = attributes
        .iter()
        .filter(|item| item.name == "custom:account_scope");
    let scope = scopes.next().map(|item| item.value.as_str());
    if scopes.next().is_some() {
        return None;
    }
    match (scope, claims.account_scope.as_deref()) {
        (None, None | Some("creator_operator"))
        | (Some("creator_operator"), Some("creator_operator")) => Some(AccountScope::Creator),
        (Some("customer_account"), Some("customer_account")) => Some(AccountScope::Customer),
        _ => None,
    }
}

pub struct CognitoIdentity {
    http: reqwest::Client,
    endpoint: String,
    pool_id: String,
    region: String,
    issuer: String,
    client_id: String,
    keys: Mutex<Option<KeySet>>,
}

struct KeySet {
    fetched_at: Instant,
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct CurrentUser {
    username: String,
    user_attributes: Vec<UserAttribute>,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

impl CognitoIdentity {
    pub fn new(
        pool_id: &str,
        client_id: String,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let Some((region, pool)) = pool_id.split_once('_') else {
            return Err("Invalid Cognito user pool ID".into());
        };
        if region.is_empty()
            || !region
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || pool.is_empty()
            || !pool.bytes().all(|byte| byte.is_ascii_alphanumeric())
            || client_id.is_empty()
        {
            return Err("Invalid Cognito user pool or app client configuration".into());
        }
        let suffix = if region.starts_with("cn-") {
            "amazonaws.com.cn"
        } else {
            "amazonaws.com"
        };
        let endpoint = format!("https://cognito-idp.{region}.{suffix}");
        Ok(Self {
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(5))
                .build()?,
            issuer: format!("{endpoint}/{pool_id}"),
            endpoint,
            pool_id: pool_id.into(),
            region: region.into(),
            client_id,
            keys: Mutex::new(None),
        })
    }

    async fn current_user_operation(&self, target: &str, token: &str) -> Option<reqwest::Response> {
        self.http
            .post(&self.endpoint)
            .header("content-type", "application/x-amz-json-1.1")
            .header("x-amz-target", target)
            .json(&json!({"AccessToken": token}))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()
            .filter(|response| response.status().is_success())
    }

    async fn verified_user(
        &self,
        token: &str,
    ) -> Option<(AccessClaims, CurrentUser, AccountScope)> {
        let (header, _) = token.split_once('.')?;
        if token.len() > 32_768 {
            return None;
        }
        let header: Header = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).ok()?).ok()?;
        if header.alg != "RS256" || header.kid.is_empty() {
            return None;
        }
        let claims = {
            let mut cache = self.keys.lock().await;
            if cache.as_ref().is_none_or(|set| {
                let age = set.fetched_at.elapsed();
                age >= Duration::from_secs(3600)
                    || (age >= Duration::from_secs(30)
                        && !set.keys.iter().any(|key| key.kid == header.kid))
            }) {
                let response = self
                    .http
                    .get(format!("{}/.well-known/jwks.json", self.issuer))
                    .send()
                    .await
                    .ok()?;
                if !response.status().is_success() {
                    return None;
                }
                let set: Jwks = response.json().await.ok()?;
                *cache = Some(KeySet {
                    fetched_at: Instant::now(),
                    keys: set.keys,
                });
            }
            verify_access_token(
                token,
                &self.issuer,
                &self.client_id,
                OffsetDateTime::now_utc().unix_timestamp(),
                &cache.as_ref()?.keys,
            )?
        };
        let user: CurrentUser = self
            .current_user_operation("AWSCognitoIdentityProviderService.GetUser", token)
            .await?
            .json()
            .await
            .ok()?;
        if claims.exp <= OffsetDateTime::now_utc().unix_timestamp() {
            return None;
        }
        let scope = bind_user(&claims, &user.username, &user.user_attributes)?;
        Some((claims, user, scope))
    }

    pub async fn verify_session(&self, token: &str) -> Option<AccountScope> {
        let (claims, _, scope) = self.verified_user(token).await?;
        Some(
            if claims.groups.as_array().is_some_and(|groups| {
                groups
                    .iter()
                    .any(|role| role.as_str() == Some("customer_account"))
            }) {
                AccountScope::Customer
            } else {
                scope
            },
        )
    }

    pub async fn authenticate(
        &self,
        email: &str,
        password: &str,
        provider: Option<&SharedCredentialsProvider>,
    ) -> Result<(String, i64), SignInError> {
        let response = self
            .http
            .post(&self.endpoint)
            .header("content-type", "application/x-amz-json-1.1")
            .header(
                "x-amz-target",
                "AWSCognitoIdentityProviderService.InitiateAuth",
            )
            .json(&json!({
                "AuthFlow": "USER_PASSWORD_AUTH", "ClientId": self.client_id,
                "AuthParameters": {"USERNAME": email, "PASSWORD": password}
            }))
            .send()
            .await
            .map_err(|_| SignInError::Unavailable)?;
        let success = response.status().is_success();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| SignInError::Unavailable)?;
        let token = sign_in_token(success, &payload)?;
        let (claims, user, scope) = self
            .verified_user(token)
            .await
            .ok_or(SignInError::Unavailable)?;
        let subject = if scope == AccountScope::Customer {
            &claims.sub
        } else {
            &user.username
        };
        self.require_active_account(subject, &claims.sub, scope, provider)
            .await?;
        if claims.exp <= OffsetDateTime::now_utc().unix_timestamp() {
            return Err(SignInError::Unavailable);
        }
        Ok((token.to_owned(), claims.exp))
    }

    async fn require_active_account(
        &self,
        subject: &str,
        sub: &str,
        scope: AccountScope,
        provider: Option<&SharedCredentialsProvider>,
    ) -> Result<(), SignInError> {
        let credentials = provider
            .ok_or(SignInError::Unavailable)?
            .provide_credentials()
            .await
            .map_err(|_| SignInError::Unavailable)?
            .into();
        let body = json!({"UserPoolId": self.pool_id, "Username": subject}).to_string();
        let headers = [
            ("content-type", "application/x-amz-json-1.1"),
            (
                "x-amz-target",
                "AWSCognitoIdentityProviderService.AdminGetUser",
            ),
        ];
        let params = v4::SigningParams::builder()
            .identity(&credentials)
            .region(&self.region)
            .name("cognito-idp")
            .time(SystemTime::now())
            .settings(SigningSettings::default())
            .build()
            .map_err(|_| SignInError::Unavailable)?;
        let request = SignableRequest::new(
            "POST",
            &self.endpoint,
            headers.into_iter(),
            SignableBody::Bytes(body.as_bytes()),
        )
        .map_err(|_| SignInError::Unavailable)?;
        let (signature, _) = sign(request, &params.into())
            .map_err(|_| SignInError::Unavailable)?
            .into_parts();
        let mut request = self.http.post(&self.endpoint).body(body);
        for (key, value) in headers.into_iter().chain(signature.headers()) {
            request = request.header(key, value);
        }
        let response = request.send().await.map_err(|_| SignInError::Unavailable)?;
        let success = response.status().is_success();
        let payload = response
            .json()
            .await
            .map_err(|_| SignInError::Unavailable)?;
        active_account(success, &payload, subject, sub, scope)
    }

    pub async fn sign_out(&self, token: &str) -> bool {
        self.current_user_operation("AWSCognitoIdentityProviderService.GlobalSignOut", token)
            .await
            .is_some()
    }
}

#[derive(Debug, PartialEq)]
pub enum SignInError {
    Invalid,
    Challenge,
    Unavailable,
}

fn exception(payload: &Value) -> Option<&str> {
    payload["__type"]
        .as_str()
        .and_then(|name| name.rsplit('#').next())
}

fn sign_in_token(success: bool, payload: &Value) -> Result<&str, SignInError> {
    if !success {
        return Err(match exception(payload) {
            Some("NotAuthorizedException" | "UserNotFoundException") => SignInError::Invalid,
            Some("UserNotConfirmedException" | "PasswordResetRequiredException") => {
                SignInError::Challenge
            }
            _ => SignInError::Unavailable,
        });
    }
    if payload["ChallengeName"]
        .as_str()
        .is_some_and(|challenge| !challenge.is_empty())
    {
        return Err(SignInError::Challenge);
    }
    payload["AuthenticationResult"]["AccessToken"]
        .as_str()
        .filter(|token| !token.is_empty() && token.trim() == *token)
        .ok_or(SignInError::Unavailable)
}

fn active_account(
    success: bool,
    payload: &Value,
    subject: &str,
    sub: &str,
    scope: AccountScope,
) -> Result<(), SignInError> {
    if !success {
        return Err(if exception(payload) == Some("UserNotFoundException") {
            SignInError::Invalid
        } else {
            SignInError::Unavailable
        });
    }
    let attributes = payload["UserAttributes"]
        .as_array()
        .ok_or(SignInError::Unavailable)?;
    let attribute = |name: &str| {
        let mut values = attributes
            .iter()
            .filter(|item| item["Name"].as_str() == Some(name));
        let value = values.next().and_then(|item| item["Value"].as_str());
        if values.next().is_none() { value } else { None }
    };
    let provider_name = payload["Username"]
        .as_str()
        .filter(|name| !name.is_empty())
        .ok_or(SignInError::Unavailable)?;
    if attribute("sub") != Some(sub) || (scope == AccountScope::Creator && provider_name != subject)
    {
        return Err(SignInError::Unavailable);
    }
    let enabled = payload["Enabled"]
        .as_bool()
        .ok_or(SignInError::Unavailable)?;
    let status = payload["UserStatus"]
        .as_str()
        .ok_or(SignInError::Unavailable)?;
    let active = match status {
        "CONFIRMED" | "EXTERNAL_PROVIDER" => true,
        "FORCE_CHANGE_PASSWORD" => {
            scope == AccountScope::Customer
                && attribute("custom:account_scope") == Some("customer_account")
                && attribute("email_verified") == Some("true")
        }
        "UNCONFIRMED" | "ARCHIVED" | "COMPROMISED" | "RESET_REQUIRED" => false,
        _ => return Err(SignInError::Unavailable),
    };
    if enabled && active {
        Ok(())
    } else {
        Err(SignInError::Invalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_in_requires_an_access_token_and_active_account_evidence() {
        assert_eq!(
            sign_in_token(false, &json!({"__type":"NotAuthorizedException"})),
            Err(SignInError::Invalid)
        );
        assert_eq!(
            sign_in_token(
                false,
                &json!({"__type":"provider#PasswordResetRequiredException"})
            ),
            Err(SignInError::Challenge)
        );
        assert_eq!(
            sign_in_token(
                true,
                &json!({"ChallengeName":"SMS_MFA","AuthenticationResult":{"AccessToken":"token"}})
            ),
            Err(SignInError::Challenge)
        );
        assert_eq!(
            sign_in_token(true, &json!({"AuthenticationResult":{"IdToken":"token"}})),
            Err(SignInError::Unavailable)
        );
        assert_eq!(
            sign_in_token(
                true,
                &json!({"AuthenticationResult":{"AccessToken":"token"}})
            ),
            Ok("token")
        );

        let mut account = json!({"Enabled":true, "UserStatus":"CONFIRMED", "Username":"username",
            "UserAttributes":[{"Name":"sub", "Value":"subject"}]});
        assert_eq!(
            active_account(true, &account, "username", "subject", AccountScope::Creator),
            Ok(())
        );
        assert_eq!(
            active_account(true, &account, "username", "another", AccountScope::Creator),
            Err(SignInError::Unavailable)
        );
        account["Enabled"] = json!(false);
        assert_eq!(
            active_account(true, &account, "username", "subject", AccountScope::Creator),
            Err(SignInError::Invalid)
        );
    }

    #[test]
    fn binds_current_user_scope_to_signed_scope_and_subject() {
        let mut claims: AccessClaims = serde_json::from_value(serde_json::json!({
            "iss":"issuer", "client_id":"client", "token_use":"access", "sub":"subject",
            "username":"user", "iat":1, "exp":50, "custom:account_scope":"customer_account"
        }))
        .unwrap();
        let attrs = [
            UserAttribute {
                name: "sub".into(),
                value: "subject".into(),
            },
            UserAttribute {
                name: "custom:account_scope".into(),
                value: "customer_account".into(),
            },
        ];
        assert_eq!(
            bind_user(&claims, "user", &attrs),
            Some(AccountScope::Customer)
        );
        assert_eq!(bind_user(&claims, "other", &attrs), None);
        assert_eq!(bind_user(&claims, "user", &attrs[..1]), None);
        claims.account_scope = None;
        assert_eq!(bind_user(&claims, "user", &attrs), None);
        assert_eq!(
            bind_user(&claims, "user", &attrs[..1]),
            Some(AccountScope::Creator)
        );
    }

    #[test]
    fn rejects_unsigned_tokens_and_unknown_signing_keys() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"iss":"issuer","client_id":"client","token_use":"access","sub":"subject","iat":1,"exp":50}"#);
        for alg in ["none", "RS256"] {
            let header = URL_SAFE_NO_PAD
                .encode(serde_json::json!({"alg": alg, "kid": "unknown"}).to_string());
            assert!(
                verify_access_token(
                    &format!("{header}.{payload}.AA"),
                    "issuer",
                    "client",
                    2,
                    &[]
                )
                .is_none()
            );
        }
    }

    #[test]
    fn verifies_signed_access_tokens_with_pool_client_and_expiry_binding() {
        let keys = [serde_json::from_value(serde_json::json!({
            "kid": "fixture", "kty": "RSA", "alg": "RS256", "use": "sig",
            "n": "y_LySmqaOmY36PH6Xs2GL5Y5_XUPbiw2MrPXvxGe-goi7z_HrHGibyI2i6dS92Q9aH0nSHIB1-QkCNV3ZaFRCjKuBO5jDk0-plvF-mFQhhxVjRQ4XBvJI1KzVfrc7_guA26-sTcoTbsCub61S_Z8DhBGTxDOSh5uXGTgi7j1Ev5FuHSsyD_gjr1mpQkWJ7sN2Kfpel_SAI2dEvg0n1PvcdTL7o2SBtr8dkfxoKTlOQYBqxOomLF4dHVjF5pqyRr8dewG4-Pz6xxKeMWu9rMqDCdptuVISHSnUXBA_kCvDnpdAkFh25P0xQkTARxAWKLvUndqx_L6c4K96T7hocWUEw", "e": "AQAB"
        })).unwrap()];
        let token = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImZpeHR1cmUifQ.eyJpc3MiOiJpc3N1ZXIiLCJjbGllbnRfaWQiOiJjbGllbnQiLCJ0b2tlbl91c2UiOiJhY2Nlc3MiLCJzdWIiOiJzdWJqZWN0IiwiaWF0IjoxLCJleHAiOjUwfQ.AMft3Hg4f5U2hBDUASTVd7RHx6K0h5AQSrV_SgZ-ALQwhzMFOFPBdeIaHh3ia_NC_Bx1qArz5R2eTdgerIzmQOo4q2vHV9NXuSmFENkw3ZVZvH84Iklsoprbqe1PJxaws6Aar9pqPq0d2pdZqujqen2NykhpYYK84jz61-4jCAbu_TfNJrnyTwbxthTBxuR2-qvSTsPSYUeMlr-sRfepqA3SgEHkFHOhotV2HYV0dtaPgbaPIeBZZqKi3KR_XAyZXx0vVHBnVBnjrCP41_CgJOsJC5XukeqkGpurnivhSCp5st0vxB1FyiOHX23pHHOf68Tnt-xTBvN9qTotxAi2gw";
        assert_eq!(
            verify_access_token(token, "issuer", "client", 2, &keys)
                .unwrap()
                .sub,
            "subject"
        );
        assert!(verify_access_token(token, "wrong-pool", "client", 2, &keys).is_none());
        assert!(verify_access_token(token, "issuer", "wrong-client", 2, &keys).is_none());
        assert!(verify_access_token(token, "issuer", "client", 50, &keys).is_none());
        let altered = token.replacen('.', "A.", 1);
        assert!(verify_access_token(&altered, "issuer", "client", 2, &keys).is_none());
    }
}
