use std::collections::HashSet;

use serde_json::{Map, Value};

const SCOPE: &str = "custom:account_scope";
const INVALID_EVENT: &str = "A genuine Cognito pre-token event is required.";
const CONFLICTING_CONTEXT: &str = "The Cognito issued-scope context conflicts.";

pub struct Realm {
    user_pool_id: String,
    client_ids: HashSet<String>,
}

impl Realm {
    pub fn new(user_pool_id: String, client_ids: Vec<String>) -> Result<Self, &'static str> {
        let unique: HashSet<_> = client_ids.iter().cloned().collect();
        if user_pool_id.is_empty()
            || client_ids.is_empty()
            || client_ids.iter().any(String::is_empty)
            || unique.len() != client_ids.len()
        {
            return Err("Actual Cognito pool and client IDs are required.");
        }
        Ok(Self {
            user_pool_id,
            client_ids: unique,
        })
    }

    pub fn validate_event(&self, event: &Value) -> Result<(), &'static str> {
        let client = event["callerContext"]["clientId"].as_str();
        if event["userPoolId"].as_str() != Some(self.user_pool_id.as_str())
            || !client.is_some_and(|id| self.client_ids.contains(id))
        {
            return Err("Cognito trigger is outside the configured identity realm.");
        }
        Ok(())
    }
}

fn ensure_object<'a>(
    object: &'a mut Map<String, Value>,
    field: &str,
    error: &'static str,
) -> Result<&'a mut Map<String, Value>, &'static str> {
    object
        .entry(field)
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or(error)
}

pub fn apply(original: &Value, mut result: Value) -> Result<Value, &'static str> {
    let attributes = original["request"]["userAttributes"]
        .as_object()
        .ok_or(INVALID_EVENT)?;
    if !original["response"].is_object() || !result["response"].is_object() {
        return Err(INVALID_EVENT);
    }
    let Some(scope) = attributes.get(SCOPE) else {
        return Ok(result);
    };
    let subject = attributes.get("sub").and_then(Value::as_str);
    if !matches!(original["version"].as_str(), Some("2" | "3"))
        || !matches!(
            scope.as_str(),
            Some("customer_account" | "creator_operator")
        )
        || !subject.is_some_and(|sub| !sub.is_empty())
        || result["userPoolId"] != original["userPoolId"]
        || result["callerContext"]["clientId"] != original["callerContext"]["clientId"]
        || result["request"]["userAttributes"]["sub"].as_str() != subject
    {
        return Err(CONFLICTING_CONTEXT);
    }

    let response = result["response"].as_object_mut().ok_or(INVALID_EVENT)?;
    let details = ensure_object(
        response,
        "claimsAndScopeOverrideDetails",
        "Existing token override details are unavailable.",
    )?;
    let generation = ensure_object(
        details,
        "accessTokenGeneration",
        "Existing access-token overrides are unavailable.",
    )?;
    if let Some(suppressed) = generation.get("claimsToSuppress") {
        let suppressed = suppressed
            .as_array()
            .filter(|values| values.iter().all(Value::is_string))
            .ok_or("Existing access-token claims are unavailable.")?;
        if suppressed.iter().any(|value| value.as_str() == Some(SCOPE)) {
            return Err("An existing trigger conflicts with canonical issued scope.");
        }
    }
    let claims = ensure_object(
        generation,
        "claimsToAddOrOverride",
        "Existing access-token claims are unavailable.",
    )?;
    if claims.get(SCOPE).is_some_and(|existing| existing != scope) {
        return Err("An existing trigger conflicts with canonical issued scope.");
    }
    claims.insert(SCOPE.to_owned(), scope.clone());
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event() -> Value {
        json!({
            "version": "2",
            "userPoolId": "us-east-2_pool",
            "callerContext": {"clientId": "client"},
            "request": {"userAttributes": {"sub": "subject", "custom:account_scope": "customer_account"}},
            "response": {}
        })
    }

    #[test]
    fn preserves_delegate_result_except_for_the_canonical_access_claim() {
        let original = event();
        let mut result = original.clone();
        result["response"] = json!({
            "other": true,
            "claimsAndScopeOverrideDetails": {
                "groupOverrideDetails": {"groupsToOverride": ["customers"]},
                "idTokenGeneration": {"claimsToAddOrOverride": {"name": "Customer"}},
                "accessTokenGeneration": {
                    "scopesToAdd": ["existing.scope"],
                    "claimsToAddOrOverride": {"existing": "value"}
                }
            }
        });
        let mut expected = result.clone();
        expected["response"]["claimsAndScopeOverrideDetails"]["accessTokenGeneration"]["claimsToAddOrOverride"]
            [SCOPE] = json!("customer_account");
        assert_eq!(apply(&original, result), Ok(expected));
    }

    #[test]
    fn rejects_pool_client_subject_version_and_claim_conflicts() {
        let original = event();
        let realm = Realm::new("us-east-2_pool".into(), vec!["client".into()]).unwrap();
        assert!(realm.validate_event(&original).is_ok());
        assert!(Realm::new("pool".into(), vec!["client".into(), "client".into()]).is_err());

        let mut changed = original.clone();
        changed["userPoolId"] = json!("another");
        assert!(realm.validate_event(&changed).is_err());
        assert_eq!(apply(&original, changed), Err(CONFLICTING_CONTEXT));

        let mut changed = original.clone();
        changed["callerContext"]["clientId"] = json!("another");
        assert!(realm.validate_event(&changed).is_err());
        assert_eq!(apply(&original, changed), Err(CONFLICTING_CONTEXT));

        let mut changed = original.clone();
        changed["request"]["userAttributes"]["sub"] = json!("another");
        assert_eq!(apply(&original, changed), Err(CONFLICTING_CONTEXT));

        let mut changed = original.clone();
        changed["version"] = json!("1");
        assert_eq!(apply(&changed, changed.clone()), Err(CONFLICTING_CONTEXT));

        for overrides in [
            json!({"claimsToSuppress": [SCOPE]}),
            json!({"claimsToAddOrOverride": {(SCOPE): "creator_operator"}}),
            json!({"claimsToSuppress": [false]}),
        ] {
            let mut changed = original.clone();
            changed["response"]["claimsAndScopeOverrideDetails"]["accessTokenGeneration"] =
                overrides;
            assert!(apply(&original, changed).is_err());
        }
    }

    #[test]
    fn leaves_an_unscoped_delegate_result_unchanged() {
        let mut original = event();
        original["request"]["userAttributes"]
            .as_object_mut()
            .unwrap()
            .remove(SCOPE);
        let mut result = original.clone();
        result["response"] = json!({"delegate": true});
        assert_eq!(apply(&original, result.clone()), Ok(result));
        assert_eq!(
            apply(&original, json!({"response": null})),
            Err(INVALID_EVENT)
        );
    }

    #[test]
    fn accepts_the_canonical_creator_scope_for_a_v3_event() {
        let mut original = event();
        original["version"] = json!("3");
        original["request"]["userAttributes"][SCOPE] = json!("creator_operator");
        let result = apply(&original, original.clone()).unwrap();
        assert_eq!(
            result["response"]["claimsAndScopeOverrideDetails"]["accessTokenGeneration"]["claimsToAddOrOverride"]
                [SCOPE],
            "creator_operator"
        );
    }
}
