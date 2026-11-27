#[cfg(feature = "worker")]
mod export;
#[cfg(feature = "worker")]
mod import;
pub mod portability;
mod records;

pub use records::RegionalStore;

use crate::lifecycle::Failure;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionalOperation {
    SourceHold,
    SourceRelease,
    Export,
    Import,
    Enable,
    Rollback,
    Retire,
}

pub struct RegionalCommand {
    pub operation: RegionalOperation,
    pub checkpoint: Value,
    pub destination_bucket: Option<String>,
}

fn required<'a>(value: &'a Value, field: &str) -> Result<&'a str, Failure> {
    value[field]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| format!("Missing regional migration field {field}.").into())
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && !value.contains(['/', '\\'])
        && !value.chars().any(char::is_control)
        && value != "."
        && value != ".."
}

impl RegionalCommand {
    pub fn parse(input: Value, cell: &str, region: &str) -> Result<Self, Failure> {
        let (operation, source) = match input["operation"].as_str() {
            Some("source_hold") => (RegionalOperation::SourceHold, true),
            Some("source_release") => (RegionalOperation::SourceRelease, true),
            Some("export") => (RegionalOperation::Export, true),
            Some("import") => (RegionalOperation::Import, false),
            Some("enable") => (RegionalOperation::Enable, false),
            Some("rollback") => (RegionalOperation::Rollback, false),
            Some("retire") => (RegionalOperation::Retire, true),
            _ => return Err("Unknown regional migration command.".into()),
        };
        let checkpoint = &input["checkpoint"];
        if !identifier(required(checkpoint, "id")?)
            || !identifier(required(checkpoint, "creatorId")?)
        {
            return Err("Invalid migration checkpoint identity.".into());
        }
        let source_cell = required(&checkpoint["source"], "homeCellId")?;
        let destination_cell = required(&checkpoint["destination"], "cellId")?;
        if source_cell == destination_cell
            || (if source {
                source_cell
            } else {
                destination_cell
            }) != cell
            || required(
                if source {
                    &checkpoint["source"]
                } else {
                    &checkpoint["destination"]
                },
                if source { "homeRegion" } else { "region" },
            )? != region
        {
            return Err("Regional migration command targets another cell.".into());
        }
        if checkpoint["source"]["creatorId"].as_str() != Some(required(checkpoint, "creatorId")?) {
            return Err("Migration checkpoint conflicts with its source creator.".into());
        }
        let revision = checkpoint["source"]["routingRevision"]
            .as_u64()
            .ok_or("Missing source revision.")?;
        if !(1..9_007_199_254_740_991).contains(&revision) {
            return Err("Invalid source routing revision.".into());
        }
        let destination_bucket = input["destinationBucket"].as_str().map(str::to_owned);
        if operation == RegionalOperation::Export
            && destination_bucket.as_ref().is_none_or(String::is_empty)
        {
            return Err("Export requires the registered destination bucket.".into());
        }
        Ok(Self {
            operation,
            checkpoint: checkpoint.clone(),
            destination_bucket,
        })
    }

    pub fn id(&self) -> &str {
        self.checkpoint["id"]
            .as_str()
            .expect("validated migration ID")
    }

    pub fn creator(&self) -> &str {
        self.checkpoint["creatorId"]
            .as_str()
            .expect("validated creator ID")
    }

    pub fn hold_id(&self) -> String {
        format!("migration-hold:{}", self.id())
    }

    pub fn hold_reason(&self) -> String {
        format!("migration:{}", self.id())
    }

    pub fn destination_audit(&self, instance: &str) -> Result<Value, Failure> {
        let action = match self.operation {
            RegionalOperation::Enable => "regional_migration.destination_enabled",
            RegionalOperation::Rollback => "regional_migration.destination_rolled_back",
            _ => {
                return Err(
                    "Migration command does not produce destination audit evidence.".into(),
                );
            }
        };
        let destination = &self.checkpoint["destination"];
        let source_revision = self.checkpoint["source"]["routingRevision"]
            .as_u64()
            .ok_or("Missing source revision.")?;
        Ok(json!({
            "id":format!("{action}:{}", self.id()), "instanceId":instance,
            "homeCellId":destination["cellId"], "dataHomeRegion":destination["region"],
            "dataHomeAssignedAt":self.checkpoint["createdAt"], "routingRevision":source_revision + 1,
            "action":action, "subjectId":self.creator(), "payload":{"migrationId":self.id()},
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(operation: &str) -> Value {
        json!({"operation":operation,"checkpoint":{
            "id":"migration","creatorId":"creator","createdAt":"2026-11-26T00:00:00.000Z",
            "source":{"creatorId":"creator","homeCellId":"source","homeRegion":"us-east-2","routingRevision":1},
            "destination":{"cellId":"destination","region":"eu-central-1"}
        }})
    }

    #[test]
    fn binds_source_and_destination_commands_to_the_declared_cell() {
        assert!(RegionalCommand::parse(command("source_hold"), "source", "us-east-2").is_ok());
        assert!(
            RegionalCommand::parse(command("source_hold"), "destination", "eu-central-1").is_err()
        );
        assert!(RegionalCommand::parse(command("enable"), "destination", "us-east-2").is_err());
        assert!(RegionalCommand::parse(command("enable"), "destination", "eu-central-1").is_ok());
        assert!(RegionalCommand::parse(command("export"), "source", "us-east-2").is_err());
        assert!(RegionalCommand::parse(command("other"), "source", "us-east-2").is_err());
    }

    #[test]
    fn preserves_the_destination_audit_identity_and_routing_revision() {
        let request =
            RegionalCommand::parse(command("rollback"), "destination", "eu-central-1").unwrap();
        let record = request.destination_audit("instance").unwrap();
        assert_eq!(
            record["id"],
            "regional_migration.destination_rolled_back:migration"
        );
        assert_eq!(record["routingRevision"], 2);
        assert_eq!(record["subjectId"], "creator");
        assert_eq!(record["payload"], json!({"migrationId":"migration"}));
    }
}
