use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use serde_json::Value;

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

#[cfg(test)]
mod tests {
    use super::*;

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
