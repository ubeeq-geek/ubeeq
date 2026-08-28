#!/usr/bin/env sh
set -eu

destination=${1:?Usage: backup.sh /secure/backup/directory}
mkdir -p "$destination"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$destination/ubeeq-compact-$timestamp.tar.gz"

# Stop writers briefly so SQLite and object files form one consistent backup.
docker compose stop reference-api reference-worker
trap 'docker compose start reference-api reference-worker >/dev/null' EXIT
docker run --rm -v ubeeq-data:/source:ro -v "$destination":/backup alpine:3.20 tar -C /source -czf "/backup/$(basename "$archive")" .
sha256sum "$archive" > "$archive.sha256"
echo "Created $archive and checksum. Copy both to encrypted off-site storage."
