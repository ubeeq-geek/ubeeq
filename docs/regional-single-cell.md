# Regional single-cell deployment

Phase 1 makes every Ubeeq deployment declare one authoritative cell. A cell identifier is stable deployment identity; `region` is the operator's plain-language storage location. The operator and backup policy are shown by diagnostics and must not be inferred from a cloud SDK.

```json
{
  "cell": {
    "id": "community-eu-west",
    "region": "eu-west",
    "operator": "Example Community",
    "backupPolicy": "Encrypted daily backup retained for 30 days in eu-west"
  }
}
```

Creator creation assigns that cell and region with routing revision 1. Creator-owned writes and worker jobs fail closed when their `homeCellId`/`cellId` differs from the running cell. Outages therefore remain outages and never trigger an implicit remote write.

Object storage uses `cells/<cellId>/creators/<creatorId>/<kind>/<objectId>`. Buckets should also be dedicated to the cell. Normal uploads, processing, originals, and renditions use only this namespace; a CDN may cache public delivery but is not canonical storage.

Creator exports contain the creator's data-home fields on all exported aggregates, reject mixed-cell contents, exclude secrets, and require no cloud credentials or global database. Import into another cell explicitly rebinds imported records to the destination data home; this is portable import behavior, not automatic migration or replication.
