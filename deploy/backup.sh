#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 2 || "$1" != /* || -z "$2" ]]; then
  echo "Usage: $0 /absolute/path/on-a-separate-backup-volume age1..." >&2
  exit 2
fi
if ! command -v age >/dev/null 2>&1; then
  echo "Install age on the backup host before creating encrypted backups." >&2
  exit 2
fi

backup_dir="$1"
age_recipient="$2"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
database_name="scholarship-${timestamp}.sqlite"
archive_path="${backup_dir}/scholarship-${timestamp}.tar.gz.age"
partial_archive="${archive_path}.partial"
staging_dir="$(mktemp -d "${backup_dir%/}/.staging.XXXXXX")"
chmod 700 "$staging_dir"

compose() {
  docker compose --env-file .env.production "$@"
}

cleanup() {
  compose exec -T ai-service python -c "from pathlib import Path; Path('/tmp/${database_name}').unlink(missing_ok=True)" >/dev/null 2>&1 || true
  rm -f "${backup_dir}/${database_name}"
  rm -f "$partial_archive"
  python3 -c "import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)" "$staging_dir"
}

trap cleanup EXIT

compose exec -T ai-service python -c \
  "import sqlite3,sys; source=sqlite3.connect('/data/db/scholarship.db'); target=sqlite3.connect(sys.argv[1]); source.backup(target); target.close(); source.close()" \
  "/tmp/${database_name}"
compose cp "ai-service:/tmp/${database_name}" "${backup_dir}/${database_name}"
compose cp "${backup_dir}/${database_name}" "${staging_dir}/${database_name}"
mkdir -m 700 "${staging_dir}/uploads-${timestamp}"
compose cp ai-service:/data/uploads/. "${staging_dir}/uploads-${timestamp}/"
tar -czf - -C "$staging_dir" . | age -r "$age_recipient" -o "$partial_archive"
chmod 600 "$partial_archive"
mv "$partial_archive" "$archive_path"
rm -f "${backup_dir}/${database_name}"

echo "Created an encrypted database and uploads backup at ${archive_path}. Copy it off-host and verify restore procedures regularly."
