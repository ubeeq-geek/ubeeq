use serde_json::{Value, json};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

pub type Failure = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, Failure>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Resume,
    Rollback,
    Retire,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellCommand {
    SourceHold,
    SourceRelease,
    Export,
    Import,
    Enable,
    Rollback,
    Retire,
}

/// Stores keep their existing document shape and use conditional writes.
/// Cell and transfer effects must be retryable after a lost acknowledgement.
pub trait MigrationBackend {
    fn checkpoint(&mut self, id: &str) -> impl std::future::Future<Output = Result<Value>> + Send;
    fn route(&mut self, creator: &str) -> impl std::future::Future<Output = Result<Value>> + Send;
    fn save_checkpoint(
        &mut self,
        previous_updated_at: &str,
        next: &Value,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn save_route(
        &mut self,
        previous_revision: u64,
        next: &Value,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn cell(
        &mut self,
        command: CellCommand,
        checkpoint: &Value,
    ) -> impl std::future::Future<Output = Result<Value>> + Send;
    fn transfer(
        &mut self,
        checkpoint: &Value,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
    fn verify(
        &mut self,
        checkpoint: &Value,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Missing migration field {key}.").into())
}

fn instant(value: &str) -> Result<OffsetDateTime> {
    Ok(OffsetDateTime::parse(value, &Rfc3339)?)
}

// The existing DynamoDB contract uses millisecond UTC timestamps.
pub(crate) fn timestamp(value: OffsetDateTime) -> Result<String> {
    let value = value.to_offset(time::UtcOffset::UTC);
    let second = value.replace_nanosecond(0)?.format(&Rfc3339)?;
    Ok(format!(
        "{}.{:03}Z",
        second.trim_end_matches('Z'),
        value.millisecond()
    ))
}

fn revision(value: &Value) -> Result<u64> {
    value["routingRevision"]
        .as_u64()
        .filter(|number| (1..=9_007_199_254_740_991).contains(number))
        .ok_or_else(|| "Invalid migration routing revision.".into())
}

fn location_matches(route: &Value, cell: &Value, cell_key: &str, region_key: &str) -> bool {
    route["homeCellId"] == cell[cell_key]
        && route["homeRegion"] == cell[region_key]
        && route["endpoint"] == cell["endpoint"]
}

fn inventory(value: &Value) -> Result<&Vec<Value>> {
    let objects = value["objectInventory"]
        .as_array()
        .ok_or("Missing migration object inventory.")?;
    for object in objects {
        string(object, "id")?;
        for location in ["source", "destination"] {
            string(&object[location], "bucket")?;
            string(&object[location], "key")?;
        }
        let checksum = string(object, "checksum")?;
        if checksum.len() != 64
            || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !object["byteLength"]
                .as_u64()
                .is_some_and(|n| n <= 9_007_199_254_740_991)
        {
            return Err("Invalid migration object inventory.".into());
        }
    }
    Ok(objects)
}

struct Orchestrator<'a, B, C> {
    backend: &'a mut B,
    clock: C,
    last: Option<OffsetDateTime>,
}

impl<B: MigrationBackend, C: FnMut() -> OffsetDateTime> Orchestrator<'_, B, C> {
    fn now(&mut self) -> Result<OffsetDateTime> {
        let requested = (self.clock)();
        let requested = OffsetDateTime::from_unix_timestamp_nanos(
            requested.unix_timestamp_nanos().div_euclid(1_000_000) * 1_000_000,
        )?;
        let value = self.last.map_or(requested, |previous| {
            requested.max(previous + Duration::milliseconds(1))
        });
        self.last = Some(value);
        Ok(value)
    }

    async fn advance(&mut self, checkpoint: &mut Value, state: &str, fields: Value) -> Result<()> {
        let previous = string(checkpoint, "updatedAt")?;
        let mut next = checkpoint.clone();
        let target = next
            .as_object_mut()
            .ok_or("Invalid migration checkpoint.")?;
        target.remove("failureReason");
        if let Value::Object(fields) = fields {
            target.extend(fields);
        }
        target.insert("state".into(), json!(state));
        target.insert("updatedAt".into(), json!(timestamp(self.now()?)?));
        self.backend.save_checkpoint(previous, &next).await?;
        *checkpoint = next;
        Ok(())
    }

    async fn resume(&mut self, checkpoint: &mut Value, rollback_seconds: i64) -> Result<()> {
        loop {
            match string(checkpoint, "state")? {
                "requested" => {
                    self.backend
                        .cell(CellCommand::SourceHold, checkpoint)
                        .await?;
                    self.advance(checkpoint, "source_hold", Value::Null).await?;
                }
                "source_hold" => {
                    let result = self.backend.cell(CellCommand::Export, checkpoint).await?;
                    let checksum = string(&result, "manifestChecksum")?;
                    if checksum.len() != 64
                        || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit())
                    {
                        return Err("Invalid migration export checksum.".into());
                    }
                    let objects = inventory(&result)?;
                    self.advance(checkpoint, "exported", json!({
                        "manifestChecksum":checksum, "objectCount":objects.len(), "objectInventory":objects,
                    })).await?;
                }
                "exported" => {
                    inventory(checkpoint)?;
                    self.backend.transfer(checkpoint).await?;
                    self.advance(checkpoint, "transferred", Value::Null).await?;
                }
                "transferred" => {
                    let count = inventory(checkpoint)?.len();
                    self.backend.cell(CellCommand::Import, checkpoint).await?;
                    self.backend.verify(checkpoint).await?;
                    self.advance(
                        checkpoint,
                        "verified",
                        json!({"objectCount":count, "verifiedObjectCount":count}),
                    )
                    .await?;
                }
                "verified" => {
                    self.cutover(checkpoint, rollback_seconds).await?;
                }
                "cutover" | "rolled_back" | "retired" | "failed" => return Ok(()),
                _ => return Err("Unknown migration checkpoint state.".into()),
            }
        }
    }

    async fn cutover(&mut self, checkpoint: &mut Value, rollback_seconds: i64) -> Result<()> {
        let creator = string(checkpoint, "creatorId")?;
        let source = &checkpoint["source"];
        let destination = &checkpoint["destination"];
        let original = revision(source)?;
        let next_revision = original
            .checked_add(1)
            .filter(|rev| *rev <= 9_007_199_254_740_991)
            .ok_or("Routing revision cannot advance.")?;
        let route = self.backend.route(creator).await?;
        let current = revision(&route)?;
        let already_cut_over =
            current == next_revision && location_matches(&route, destination, "cellId", "region");
        if route["creatorId"].as_str() != Some(creator)
            || (!already_cut_over
                && (current != original || route["homeCellId"] != source["homeCellId"]))
        {
            return Err("Migration is not verified for this current route.".into());
        }
        let rollback_until = self
            .now()?
            .checked_add(Duration::seconds(rollback_seconds))
            .ok_or("Invalid rollback window.")?;
        let rollback_until = timestamp(rollback_until)?;
        self.backend.cell(CellCommand::Enable, checkpoint).await?;
        if !already_cut_over {
            let next = json!({
                "creatorId":creator, "homeCellId":destination["cellId"], "homeRegion":destination["region"],
                "endpoint":destination["endpoint"], "routingRevision":next_revision,
                "state":"rollback_available","updatedAt":timestamp(self.now()?)?,
            });
            self.backend.save_route(current, &next).await?;
        }
        self.advance(
            checkpoint,
            "cutover",
            json!({"rollbackUntil":rollback_until}),
        )
        .await
    }

    async fn rollback(&mut self, checkpoint: &mut Value) -> Result<()> {
        if checkpoint["state"] != "cutover" {
            return Err("Only a cut-over migration can roll back.".into());
        }
        let creator = string(checkpoint, "creatorId")?;
        let source = &checkpoint["source"];
        let route = self.backend.route(creator).await?;
        let original = revision(source)?;
        let current = revision(&route)?;
        let new_revision = original
            .checked_add(2)
            .filter(|rev| *rev <= 9_007_199_254_740_991)
            .ok_or("Routing revision cannot advance.")?;
        let restored = current == new_revision
            && route["state"] == "active"
            && location_matches(&route, source, "homeCellId", "homeRegion");
        if route["creatorId"].as_str() != Some(creator) {
            return Err("Migration is not eligible for rollback.".into());
        }
        if !restored {
            let deadline = instant(string(checkpoint, "rollbackUntil")?)?;
            if current != original + 1
                || route["homeCellId"] != checkpoint["destination"]["cellId"]
                || deadline < (self.clock)()
            {
                return Err("Migration is not eligible for rollback.".into());
            }
            self.backend.cell(CellCommand::Rollback, checkpoint).await?;
            let next = json!({
                "creatorId":creator, "homeCellId":source["homeCellId"], "homeRegion":source["homeRegion"],
                "endpoint":source["endpoint"], "routingRevision":new_revision, "state":"active",
                "updatedAt":timestamp(self.now()?)?,
            });
            self.backend.save_route(current, &next).await?;
        }
        self.backend
            .cell(CellCommand::SourceRelease, checkpoint)
            .await?;
        self.advance(checkpoint, "rolled_back", Value::Null).await
    }

    async fn retire(&mut self, checkpoint: &mut Value) -> Result<()> {
        if checkpoint["state"] != "cutover" {
            return Err("Only a cut-over migration can retire its source.".into());
        }
        let deadline = instant(string(checkpoint, "rollbackUntil")?)?;
        if deadline > (self.clock)() {
            return Err("The rollback retention window has not expired.".into());
        }
        self.backend.cell(CellCommand::Retire, checkpoint).await?;
        self.advance(checkpoint, "retired", Value::Null).await
    }
}

pub async fn execute(
    backend: &mut impl MigrationBackend,
    id: &str,
    operation: Operation,
    rollback_seconds: Option<i64>,
    clock: impl FnMut() -> OffsetDateTime,
) -> Result<Value> {
    let rollback_seconds = rollback_seconds.unwrap_or(86_400);
    if id.trim().is_empty() || !(1..=9_007_199_254_740_991).contains(&rollback_seconds) {
        return Err("Migration command is invalid.".into());
    }
    let mut checkpoint = backend.checkpoint(id).await?;
    if checkpoint["id"].as_str() != Some(id) {
        return Err("Migration checkpoint does not match the requested identity.".into());
    }
    let updated = instant(string(&checkpoint, "updatedAt")?)?;
    let mut orchestrator = Orchestrator {
        backend,
        clock,
        last: Some(updated),
    };
    match operation {
        Operation::Resume => {
            orchestrator
                .resume(&mut checkpoint, rollback_seconds)
                .await?
        }
        Operation::Rollback => orchestrator.rollback(&mut checkpoint).await?,
        Operation::Retire => orchestrator.retire(&mut checkpoint).await?,
    }
    Ok(checkpoint)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-11-26T00:00:00.000Z";

    struct Fixture {
        checkpoint: Value,
        route: Value,
        effects: Vec<String>,
        fail_checkpoint: Option<&'static str>,
        fail_release: bool,
    }

    impl Fixture {
        fn new() -> Self {
            let route = json!({
                "creatorId":"creator", "homeCellId":"source", "homeRegion":"us-east-2",
                "endpoint":"https://source.test/", "routingRevision":1,
                "state":"active", "updatedAt":NOW,
            });
            Self {
                checkpoint: json!({
                    "id":"migration", "creatorId":"creator", "source":route,
                    "destination":{"cellId":"destination","region":"eu-central-1","endpoint":"https://destination.test/"},
                    "state":"requested","createdAt":NOW,"updatedAt":NOW
                }),
                route,
                effects: Vec::new(),
                fail_checkpoint: None,
                fail_release: false,
            }
        }

        async fn run(&mut self, operation: Operation) -> Result<Value> {
            execute(self, "migration", operation, Some(60), || {
                instant(NOW).unwrap()
            })
            .await
        }
    }

    impl MigrationBackend for Fixture {
        async fn checkpoint(&mut self, _: &str) -> Result<Value> {
            Ok(self.checkpoint.clone())
        }

        async fn route(&mut self, _: &str) -> Result<Value> {
            Ok(self.route.clone())
        }

        async fn save_checkpoint(&mut self, previous_updated_at: &str, next: &Value) -> Result<()> {
            assert_eq!(self.checkpoint["updatedAt"], previous_updated_at);
            assert!(string(next, "updatedAt")? > previous_updated_at);
            if next["state"].as_str() == self.fail_checkpoint {
                self.fail_checkpoint = None;
                return Err("checkpoint write failed".into());
            }
            self.checkpoint = next.clone();
            Ok(())
        }

        async fn save_route(&mut self, previous_revision: u64, next: &Value) -> Result<()> {
            assert_eq!(revision(&self.route)?, previous_revision);
            assert_eq!(revision(next)?, previous_revision + 1);
            self.effects.push("route".into());
            self.route = next.clone();
            Ok(())
        }

        async fn cell(&mut self, command: CellCommand, _: &Value) -> Result<Value> {
            self.effects.push(format!("{command:?}"));
            if command == CellCommand::SourceRelease && self.fail_release {
                self.fail_release = false;
                return Err("source release failed".into());
            }
            Ok(match command {
                CellCommand::Export => {
                    json!({"manifestChecksum":"a".repeat(64),"objectInventory":[{
                        "id":"object","checksum":"c".repeat(64),"byteLength":7,
                        "source":{"bucket":"source","key":"object"},
                        "destination":{"bucket":"destination","key":"object"},
                    }]})
                }
                _ => json!({}),
            })
        }

        async fn transfer(&mut self, value: &Value) -> Result<()> {
            assert_eq!(inventory(value)?.len(), 1);
            self.effects.push("transfer".into());
            Ok(())
        }

        async fn verify(&mut self, value: &Value) -> Result<()> {
            assert_eq!(inventory(value)?.len(), 1);
            self.effects.push("verify".into());
            Ok(())
        }
    }

    #[tokio::test]
    async fn advances_from_source_hold_to_verified_cutover_with_durable_evidence() {
        let mut fixture = Fixture::new();
        let checkpoint = fixture.run(Operation::Resume).await.unwrap();
        assert_eq!(checkpoint["state"], "cutover");
        assert_eq!(checkpoint["verifiedObjectCount"], 1);
        assert_eq!(checkpoint["objectInventory"][0]["byteLength"], 7);
        assert_eq!(fixture.route["homeCellId"], "destination");
        assert_eq!(
            fixture.effects,
            [
                "SourceHold",
                "Export",
                "transfer",
                "Import",
                "verify",
                "Enable",
                "route"
            ]
        );
        assert!(fixture.run(Operation::Retire).await.is_err());
        assert!(!fixture.effects.iter().any(|effect| effect == "Retire"));
    }

    #[tokio::test]
    async fn resumes_after_route_commit_without_replacing_the_route_again() {
        let mut fixture = Fixture::new();
        fixture.fail_checkpoint = Some("cutover");
        assert!(fixture.run(Operation::Resume).await.is_err());
        assert_eq!(fixture.checkpoint["state"], "verified");
        assert_eq!(fixture.route["routingRevision"], 2);
        assert_eq!(
            fixture.run(Operation::Resume).await.unwrap()["state"],
            "cutover"
        );
        assert_eq!(fixture.route["routingRevision"], 2);
        assert_eq!(
            fixture
                .effects
                .iter()
                .filter(|effect| *effect == "route")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn rollback_restores_route_before_releasing_source_and_retries_release() {
        let mut fixture = Fixture::new();
        fixture.run(Operation::Resume).await.unwrap();
        fixture.effects.clear();
        fixture.fail_release = true;
        assert!(fixture.run(Operation::Rollback).await.is_err());
        assert_eq!(fixture.route["homeCellId"], "source");
        assert_eq!(fixture.checkpoint["state"], "cutover");
        assert_eq!(fixture.effects, ["Rollback", "route", "SourceRelease"]);
        assert_eq!(
            fixture.run(Operation::Rollback).await.unwrap()["state"],
            "rolled_back"
        );
        assert_eq!(
            fixture.effects,
            ["Rollback", "route", "SourceRelease", "SourceRelease"]
        );
        assert_eq!(fixture.route["routingRevision"], 3);
    }
}
