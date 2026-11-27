use std::collections::HashMap;

use aws_sdk_dynamodb::{Client, types::AttributeValue};
use serde_json::Value;

use crate::lifecycle::Failure;

pub fn document(value: AttributeValue) -> Result<Value, Failure> {
    Ok(match value {
        AttributeValue::S(value) => Value::String(value),
        AttributeValue::N(value) => Value::Number(value.parse()?),
        AttributeValue::Bool(value) => Value::Bool(value),
        AttributeValue::Null(true) => Value::Null,
        AttributeValue::L(values) => {
            Value::Array(values.into_iter().map(document).collect::<Result<_, _>>()?)
        }
        AttributeValue::M(values) => Value::Object(
            values
                .into_iter()
                .map(|(k, v)| Ok((k, document(v)?)))
                .collect::<Result<_, Failure>>()?,
        ),
        _ => return Err("Unsupported control-plane attribute.".into()),
    })
}

pub(crate) fn attribute(value: &Value) -> AttributeValue {
    match value {
        Value::Null => AttributeValue::Null(true),
        Value::Bool(value) => AttributeValue::Bool(*value),
        Value::Number(value) => AttributeValue::N(value.to_string()),
        Value::String(value) => AttributeValue::S(value.clone()),
        Value::Array(values) => AttributeValue::L(values.iter().map(attribute).collect()),
        Value::Object(fields) => AttributeValue::M(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), attribute(value)))
                .collect(),
        ),
    }
}

fn key(pk: &str, sk: &str) -> HashMap<String, AttributeValue> {
    HashMap::from([
        ("pk".into(), AttributeValue::S(pk.into())),
        ("sk".into(), AttributeValue::S(sk.into())),
    ])
}

fn required<'a>(document: &'a Value, key: &str) -> Result<&'a str, Failure> {
    document[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Missing control-plane field {key}.").into())
}

pub struct MigrationStore {
    client: Client,
    table: String,
}

impl MigrationStore {
    pub fn new(client: Client, table: String) -> Self {
        Self { client, table }
    }

    async fn read_optional(
        &self,
        partition: &str,
        id: &str,
        field: &str,
    ) -> Result<Option<Value>, Failure> {
        let output = self
            .client
            .get_item()
            .table_name(&self.table)
            .set_key(Some(key(partition, id)))
            .consistent_read(true)
            .send()
            .await?;
        output
            .item
            .and_then(|mut item| item.remove(field))
            .map(document)
            .transpose()
    }

    async fn read(&self, partition: &str, id: &str, field: &str) -> Result<Value, Failure> {
        self.read_optional(partition, id, field)
            .await?
            .ok_or_else(|| "Control-plane metadata was not found.".into())
    }

    pub async fn route_optional(&self, creator: &str) -> Result<Option<Value>, Failure> {
        self.read_optional("route", creator, "route").await
    }

    pub async fn checkpoint(&self, id: &str) -> Result<Value, Failure> {
        self.read("migration", id, "checkpoint").await
    }

    pub async fn route(&self, creator: &str) -> Result<Value, Failure> {
        self.read("route", creator, "route").await
    }

    pub async fn registered_cell(&self, cell: &str) -> Result<Value, Failure> {
        self.read("cell", cell, "cell").await
    }

    pub async fn save_checkpoint(&self, previous: &str, next: &Value) -> Result<(), Failure> {
        let mut item = key("migration", required(next, "id")?);
        let updated = required(next, "updatedAt")?;
        if updated <= previous {
            return Err("A migration update must advance updatedAt.".into());
        }
        item.insert("checkpoint".into(), attribute(next));
        item.insert(
            "creatorId".into(),
            AttributeValue::S(required(next, "creatorId")?.into()),
        );
        item.insert("updatedAt".into(), AttributeValue::S(updated.into()));
        self.replace(item, "updatedAt", AttributeValue::S(previous.into()))
            .await
    }

    pub async fn save_route(&self, previous: u64, route: &Value) -> Result<(), Failure> {
        let mut item = key("route", required(route, "creatorId")?);
        let revision = route["routingRevision"]
            .as_u64()
            .ok_or("A route revision is required.")?;
        if previous.checked_add(1) != Some(revision) {
            return Err("A replacement route must advance routingRevision by exactly one.".into());
        }
        item.insert("route".into(), attribute(route));
        item.insert(
            "routingRevision".into(),
            AttributeValue::N(revision.to_string()),
        );
        self.replace(
            item,
            "routingRevision",
            AttributeValue::N(previous.to_string()),
        )
        .await
    }

    async fn replace(
        &self,
        item: HashMap<String, AttributeValue>,
        field: &str,
        previous: AttributeValue,
    ) -> Result<(), Failure> {
        self.client
            .put_item()
            .table_name(&self.table)
            .set_item(Some(item))
            .condition_expression("attribute_exists(pk) AND #current = :expected")
            .expression_attribute_names("#current", field)
            .expression_attribute_values(":expected", previous)
            .send()
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_the_json_attributes_in_existing_checkpoints() {
        let checkpoint = json!({
            "id":"migration", "state":"exported", "revision":2,
            "objectInventory":[{"versionId":null,"byteLength":9,"immutable":true}]
        });
        assert_eq!(document(attribute(&checkpoint)).unwrap(), checkpoint);
    }
}
