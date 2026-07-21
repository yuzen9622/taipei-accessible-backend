#!/usr/bin/env bash
set -Eeuo pipefail

# Produce a portable, lossless backup bundle of the only data that cannot
# simply be re-fetched or rebuilt on a fresh host:
#   1. MongoDB   — user accounts, hazard reports, reviews + all imported data
#   2. Chroma    — RAG vector embeddings (costly to regenerate via Gemini)
#   3. .env      — config + the GCS service-account key it points at
#
# Redis is an ephemeral cache (no persistent volume) and is deliberately
# skipped. The large rebuildable dirs (data/ otp-data/ valhalla-data/) are NOT
# in the bundle — copy them with the rsync line printed at the end, or rebuild
# them on the new host (build-otp-graph.sh / build-valhalla-tiles.sh).
#
#   src/scripts/backup-data.sh            # writes ./migrate-bundle-<ts>/

cd "$(dirname "$0")/../.."

fail() { printf 'backup-data: %s\n' "$*" >&2; exit 1; }

[ -f .env ] || fail ".env not found — run from a configured checkout"
set -a; source .env; set +a

: "${MONGO_ROOT_USER:?MONGO_ROOT_USER missing in .env}"
: "${MONGO_ROOT_PASSWORD:?MONGO_ROOT_PASSWORD missing in .env}"

# The Chroma named volume is prefixed with the compose project name, which
# defaults to the project directory name.
PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
CHROMA_VOLUME="${PROJECT}_chroma-data"

OUT="migrate-bundle-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

echo "==> 1/3 MongoDB logical dump (version-safe archive)"
docker exec mongo mongodump \
  --username "$MONGO_ROOT_USER" --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin --db accessible_map \
  --archive --gzip > "$OUT/mongo.archive.gz"

echo "==> 2/3 Chroma vector store (packing volume $CHROMA_VOLUME)"
if docker volume inspect "$CHROMA_VOLUME" >/dev/null 2>&1; then
  docker run --rm \
    -v "$CHROMA_VOLUME":/vol:ro \
    -v "$PWD/$OUT":/backup alpine \
    tar czf /backup/chroma-data.tar.gz -C /vol .
else
  echo "    (skipped: volume $CHROMA_VOLUME not found)"
fi

echo "==> 3/3 Config + secrets"
cp .env "$OUT/.env"
GCS=$(grep -E '^GCS_KEY_FILE=' .env | cut -d= -f2- || true)
if [ -n "${GCS:-}" ] && [ -f "$GCS" ]; then
  cp "$GCS" "$OUT/gcs-key.json"
else
  echo "    (no GCS key file to copy)"
fi

echo
echo "OK  core bundle ready: $OUT/  (Mongo + Chroma + config)"
echo "    to also move the large rebuildable dirs and skip re-import/rebuild:"
echo "    rsync -avz data otp-data valhalla-data USER@NEW_HOST:$(basename "$PWD")/"
