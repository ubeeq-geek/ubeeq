#!/usr/bin/env sh
set -eu

archive=${1:?Usage: restore.sh /secure/backup/ubeeq-compact-YYYYMMDDTHHMMSSZ.tar.gz}
[ -f "$archive" ] || { echo "Backup archive not found: $archive" >&2; exit 1; }
if [ -f "$archive.sha256" ]; then (cd "$(dirname "$archive")" && sha256sum -c "$(basename "$archive").sha256"); fi

echo "Stopping Ubeeq services before restore. Existing volume contents will be replaced."
docker compose down
docker volume rm ubeeq-data 2>/dev/null || true
docker volume create ubeeq-data >/dev/null
docker run --rm -v ubeeq-data:/target -v "$(dirname "$archive")":/backup:ro alpine:3.20 sh -c "tar -C /target -xzf /backup/$(basename "$archive")"
echo "Restore complete. Run docker compose up -d and verify /health before accepting writes."
