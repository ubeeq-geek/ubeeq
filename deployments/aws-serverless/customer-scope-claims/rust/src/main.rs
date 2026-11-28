mod scope;

use std::{env, io, sync::Arc};

use aws_config::{BehaviorVersion, Region};
use aws_sdk_lambda::{Client, primitives::Blob, types::InvocationType};
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use regex::Regex;
use serde_json::Value;

struct Delegate {
    arn: String,
    client: Client,
}

impl Delegate {
    async fn new(arn: String) -> Result<Self, Error> {
        let version_arn = Regex::new(
            r"^arn:aws[a-z-]*:lambda:([a-z0-9-]+):[0-9]{12}:function:[A-Za-z0-9_-]+:[1-9][0-9]*$",
        )?;
        let region = version_arn
            .captures(&arn)
            .ok_or("An immutable existing claims trigger ARN is required.")?[1]
            .to_owned();
        let configuration = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(region))
            .load()
            .await;
        Ok(Self {
            arn,
            client: Client::new(&configuration),
        })
    }

    async fn invoke(&self, event: &Value) -> Result<Value, Error> {
        let result = self
            .client
            .invoke()
            .function_name(&self.arn)
            .invocation_type(InvocationType::RequestResponse)
            .payload(Blob::new(serde_json::to_vec(event)?))
            .send()
            .await
            .map_err(|_| "Existing claims trigger invocation failed.")?;
        if result.status_code() != 200 || result.function_error().is_some() {
            return Err("Existing claims trigger did not return its genuine response.".into());
        }
        let payload = result
            .payload()
            .ok_or("Existing claims trigger did not return its genuine response.")?;
        serde_json::from_slice(payload.as_ref())
            .map_err(|_| "Existing claims trigger returned invalid JSON.".into())
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    let clients = env::var("CUSTOMER_SCOPE_CLIENT_IDS").unwrap_or_default();
    let realm = scope::Realm::new(
        env::var("CUSTOMER_SCOPE_USER_POOL_ID").unwrap_or_default(),
        clients
            .split(',')
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect(),
    )
    .map_err(io::Error::other)?;
    let delegate = match env::var("CUSTOMER_SCOPE_DELEGATE_ARN") {
        Ok(arn) if !arn.is_empty() => Some(Delegate::new(arn).await?),
        _ => None,
    };
    let configuration = Arc::new((realm, delegate));

    run(service_fn(|event: LambdaEvent<Value>| {
        let configuration = Arc::clone(&configuration);
        async move {
            let (realm, delegate) = &*configuration;
            let input = event.payload;
            realm.validate_event(&input).map_err(io::Error::other)?;
            let result = match delegate {
                Some(delegate) => delegate.invoke(&input).await?,
                None => input.clone(),
            };
            Ok::<Value, Error>(scope::apply(&input, result).map_err(io::Error::other)?)
        }
    }))
    .await
}
