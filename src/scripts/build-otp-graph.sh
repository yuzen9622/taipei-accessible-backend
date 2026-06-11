#!/usr/bin/env bash
#
# Phase 16 OTP2 graph build pipeline (spec §5) — cron-driven, weekly:
#   1. fetch the TDX GTFS static feed(s)        (every run)
#   2. refresh + clip the Taiwan OSM extract    (only when older than 30 days)
#   3. gate on gtfs-validator errors            (abort keeps the old graph)
#   4. otp --build --save (offline, in a temp dir — serving is untouched)
#   5. atomic swap of graph.obj + container restart + healthcheck
#
# Required env:
#   TDX_CLIENT_ID / TDX_CLIENT_SECRET   TDX OAuth2 client credentials
#   OTP_GTFS_URLS                       space-separated GTFS zip URLs (TDX)
# Optional env:
#   OTP_DATA_DIR     (default /var/otp)
#   OTP_OSM_PBF_URL  (default Geofabrik Taiwan)
#   OTP_OSM_BBOX     osmium extract bbox "minLng,minLat,maxLng,maxLat".
#                    UNSET (default) = no clipping, full Taiwan coverage.
#                    Taichung-only example: 120.40,23.95,121.05,24.45
#   OTP_JAVA_XMX     build heap (default 12g — national feed + full Taiwan OSM;
#                    a single-city clip builds fine with 8g)
#
# Suggested cron (spec §9):  0 4 * * 0  /path/to/build-otp-graph.sh
set -euo pipefail

OTP_DATA_DIR="${OTP_DATA_DIR:-/var/otp}"
OTP_OSM_PBF_URL="${OTP_OSM_PBF_URL:-https://download.geofabrik.de/asia/taiwan-latest.osm.pbf}"
OTP_OSM_BBOX="${OTP_OSM_BBOX:-}" # empty = full Taiwan (no clipping)
OTP_JAVA_XMX="${OTP_JAVA_XMX:-12g}"
OTP_IMAGE="opentripplanner/opentripplanner:2.5.0"
OSM_MAX_AGE_DAYS=30

WORK_DIR="$(mktemp -d /tmp/otp-build.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

log() { echo "[build-otp-graph] $(date '+%F %T') $*"; }
die() { log "FATAL: $*"; exit 1; }

[ -n "${TDX_CLIENT_ID:-}" ] || die "TDX_CLIENT_ID not set"
[ -n "${TDX_CLIENT_SECRET:-}" ] || die "TDX_CLIENT_SECRET not set"
[ -n "${OTP_GTFS_URLS:-}" ] || die "OTP_GTFS_URLS not set"
[ -d "$OTP_DATA_DIR" ] || die "OTP_DATA_DIR $OTP_DATA_DIR does not exist"

# ── 1. GTFS feeds (TDX OAuth2 client_credentials, same flow as TdxTokenManger) ──
log "fetching TDX access token"
TOKEN=$(curl -fsS -X POST \
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${TDX_CLIENT_ID}&client_secret=${TDX_CLIENT_SECRET}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])") \
  || die "TDX token acquisition failed"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
i=0
for url in $OTP_GTFS_URLS; do
  i=$((i + 1))
  out="$WORK_DIR/feed-${i}.gtfs.zip"
  log "downloading GTFS feed $i: $url"
  curl -fsSL -H "Authorization: Bearer $TOKEN" -o "$out" "$url" \
    || die "GTFS download failed: $url"
  unzip -l "$out" >/dev/null 2>&1 || die "GTFS feed $i is not a valid zip"
  # TDX feed quality fixes (duplicate ids, broken refs, self-loop pathways —
  # the latter build a graph that NPEs on load). See clean-gtfs-feed.py.
  log "cleaning feed $i"
  python3 "$SCRIPT_DIR/clean-gtfs-feed.py" "$out" || die "feed cleaning failed: $out"
done

# ── 2. OSM extract (monthly refresh, spec §5) ──
OSM_CACHE="$OTP_DATA_DIR/taiwan-latest.osm.pbf"
OSM_CLIPPED="$WORK_DIR/taiwan-clipped.osm.pbf"
if [ ! -f "$OSM_CACHE" ] || [ -n "$(find "$OSM_CACHE" -mtime +$OSM_MAX_AGE_DAYS 2>/dev/null)" ]; then
  log "refreshing OSM pbf from Geofabrik"
  curl -fsSL -o "$OSM_CACHE.tmp" "$OTP_OSM_PBF_URL" || die "OSM download failed"
  mv "$OSM_CACHE.tmp" "$OSM_CACHE"
else
  log "OSM pbf is fresh (< ${OSM_MAX_AGE_DAYS}d), skipping download"
fi
if [ -z "$OTP_OSM_BBOX" ]; then
  log "no OTP_OSM_BBOX set — building with the full Taiwan pbf"
  cp "$OSM_CACHE" "$OSM_CLIPPED"
elif command -v osmium >/dev/null 2>&1; then
  log "clipping OSM to bbox $OTP_OSM_BBOX"
  osmium extract -b "$OTP_OSM_BBOX" -o "$OSM_CLIPPED" --overwrite "$OSM_CACHE" \
    || die "osmium extract failed"
else
  log "WARN: osmium not installed — building with the full Taiwan pbf"
  cp "$OSM_CACHE" "$OSM_CLIPPED"
fi

# ── 3. Feed validation gate (red light = abort, old graph keeps serving) ──
if command -v gtfs-validator >/dev/null 2>&1; then
  for zip in "$WORK_DIR"/feed-*.gtfs.zip; do
    log "validating $(basename "$zip")"
    gtfs-validator -i "$zip" -o "$WORK_DIR/validation-$(basename "$zip" .zip)" \
      || die "gtfs-validator reported errors for $zip — keeping old graph"
  done
else
  log "WARN: gtfs-validator not installed — skipping validation gate"
fi

# ── 4. Offline build in the temp dir (serving container is untouched) ──
cp "$OTP_DATA_DIR"/otp-config.json "$OTP_DATA_DIR"/build-config.json \
  "$OTP_DATA_DIR"/router-config.json "$WORK_DIR/" 2>/dev/null \
  || die "OTP config files missing in $OTP_DATA_DIR"
mv "$OSM_CLIPPED" "$WORK_DIR/taiwan-otp.osm.pbf"

# The official image's entrypoint hardcodes /var/opentripplanner as the data
# directory — mount there and pass flags only, never a path.
log "building graph (this takes a while; heap ${OTP_JAVA_XMX})"
docker run --rm \
  -e JAVA_TOOL_OPTIONS="-Xmx${OTP_JAVA_XMX}" \
  -v "$WORK_DIR:/var/opentripplanner" \
  "$OTP_IMAGE" --build --save \
  || die "otp --build failed — keeping old graph"
[ -f "$WORK_DIR/graph.obj" ] || die "build produced no graph.obj — keeping old graph"

# ── 5. Atomic swap + restart + healthcheck before declaring success ──
log "swapping graph.obj into $OTP_DATA_DIR"
cp "$WORK_DIR"/feed-*.gtfs.zip "$OTP_DATA_DIR/" 2>/dev/null || true
cp "$WORK_DIR/taiwan-otp.osm.pbf" "$OTP_DATA_DIR/" 2>/dev/null || true
[ -f "$OTP_DATA_DIR/graph.obj" ] && cp "$OTP_DATA_DIR/graph.obj" "$OTP_DATA_DIR/graph.obj.prev"
mv "$WORK_DIR/graph.obj" "$OTP_DATA_DIR/graph.obj.new"
mv "$OTP_DATA_DIR/graph.obj.new" "$OTP_DATA_DIR/graph.obj"

log "restarting otp container"
docker compose restart otp || docker restart otp || die "container restart failed"

log "waiting for healthcheck"
for attempt in $(seq 1 30); do
  if curl -fsS "http://localhost:8080/otp/actuators/health" >/dev/null 2>&1; then
    log "OTP healthy — build complete"
    rm -f "$OTP_DATA_DIR/graph.obj.prev"
    exit 0
  fi
  sleep 10
done

# Health never came up: roll back to the previous graph.
log "healthcheck failed after restart — rolling back to previous graph"
if [ -f "$OTP_DATA_DIR/graph.obj.prev" ]; then
  mv "$OTP_DATA_DIR/graph.obj.prev" "$OTP_DATA_DIR/graph.obj"
  docker compose restart otp || docker restart otp || true
fi
die "new graph failed healthcheck (rolled back)"
