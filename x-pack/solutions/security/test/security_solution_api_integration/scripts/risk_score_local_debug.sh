#!/usr/bin/env bash

set -euo pipefail

KIBANA_URL="${KIBANA_URL:-http://localhost:5601/mark}"
ES_URL="${ES_URL:-http://localhost:9200}"
USERNAME="${USERNAME:-elastic}"
PASSWORD="${PASSWORD:-changeme}"
SPACE_ID="${SPACE_ID:-default}"

GENERATE_DATA=1
RUN_MAINTAINER=1
MAINTAINER_RUNS=1

EVENTS="${EVENTS:-40}"
HOSTS="${HOSTS:-1}"
USERS="${USERS:-1}"
EPISODES="${EPISODES:-ep1}"
START_DATE="${START_DATE:-2h}"
END_DATE="${END_DATE:-now}"

usage() {
  cat <<'EOF'
Usage:
  risk_score_local_debug.sh [options]

Options:
  --no-generate-data       Skip Security data generator step
  --prepare-only           Prepare entity store/maintainer but do not run maintainer
  --runs <n>               Number of manual maintainer runs (default: 1)
  --space <space_id>       Kibana space id (default: default)
  --help                   Show this help

Environment overrides:
  KIBANA_URL               Kibana URL (default: http://localhost:5601/mark)
  ES_URL                   Elasticsearch URL (default: http://localhost:9200)
  USERNAME                 Basic auth username (default: elastic)
  PASSWORD                 Basic auth password (default: changeme)
  EVENTS                   Generator events count (default: 40)
  HOSTS                    Generator host count (default: 1)
  USERS                    Generator user count (default: 1)
  EPISODES                 Generator episodes (default: ep1)
  START_DATE               Generator start date math (default: 2h)
  END_DATE                 Generator end date math (default: now)

Examples:
  KIBANA_URL=http://localhost:5601/mark ./risk_score_local_debug.sh
  ./risk_score_local_debug.sh --prepare-only
  ./risk_score_local_debug.sh --runs 3 --space default
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-generate-data)
      GENERATE_DATA=0
      shift
      ;;
    --prepare-only)
      RUN_MAINTAINER=0
      shift
      ;;
    --runs)
      MAINTAINER_RUNS="$2"
      shift 2
      ;;
    --space)
      SPACE_ID="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! [[ "$MAINTAINER_RUNS" =~ ^[0-9]+$ ]]; then
  echo "--runs must be a non-negative integer, got: $MAINTAINER_RUNS" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../../.." && pwd)"
GENERATOR_SCRIPT="$REPO_ROOT/x-pack/solutions/security/plugins/security_solution/scripts/data/generate_cli.js"

API_ROOT="${KIBANA_URL%/}"
if [[ "$SPACE_ID" != "default" ]]; then
  API_ROOT="${API_ROOT}/s/${SPACE_ID}"
fi

request_kibana() {
  local method="$1"
  local path="$2"
  local payload="${3:-}"
  local api_version="${4:-}"

  local args=(
    -sS
    -u "${USERNAME}:${PASSWORD}"
    -X "$method"
    "${API_ROOT}${path}"
    -H "kbn-xsrf: true"
    -H "x-elastic-internal-origin: Kibana"
    -H "content-type: application/json"
  )

  if [[ -n "$api_version" ]]; then
    args+=(-H "elastic-api-version: ${api_version}")
  fi

  if [[ -n "$payload" ]]; then
    args+=(-d "$payload")
  fi

  curl "${args[@]}"
}

print_json_field() {
  local program="$1"
  node -e "$program"
}

echo "==> Using Kibana: ${KIBANA_URL}"
echo "==> Using Elasticsearch: ${ES_URL}"
echo "==> Space: ${SPACE_ID}"

if [[ "$GENERATE_DATA" -eq 1 ]]; then
  echo "==> Generating local Security data (events + alerts)"
  node "$GENERATOR_SCRIPT" \
    --clean \
    -n "$EVENTS" \
    -h "$HOSTS" \
    -u "$USERS" \
    --episodes "$EPISODES" \
    --start-date "$START_DATE" \
    --end-date "$END_DATE" \
    --kibanaUrl "$KIBANA_URL" \
    --elasticsearchUrl "$ES_URL" \
    --username "$USERNAME" \
    --password "$PASSWORD"
else
  echo "==> Skipping data generation"
fi

echo "==> Enabling Entity Store V2 setting"
request_kibana \
  POST \
  "/internal/kibana/settings" \
  '{"changes":{"securitySolution:entityStoreEnableV2":true}}' >/dev/null

echo "==> Installing Entity Store V2"
request_kibana \
  POST \
  "/internal/security/entity_store/install?apiVersion=2" \
  '{"entityTypes":["host","user"]}' \
  "2" >/dev/null

FROM_DATE="$(node -e "console.log(new Date(Date.now() - 24*60*60*1000).toISOString())")"
TO_DATE="$(node -e "console.log(new Date(Date.now() + 60*60*1000).toISOString())")"

echo "==> Force extracting host/user entities"
request_kibana \
  POST \
  "/internal/security/entity_store/host/force_log_extraction" \
  "{\"fromDateISO\":\"${FROM_DATE}\",\"toDateISO\":\"${TO_DATE}\"}" \
  "2" >/dev/null
request_kibana \
  POST \
  "/internal/security/entity_store/user/force_log_extraction" \
  "{\"fromDateISO\":\"${FROM_DATE}\",\"toDateISO\":\"${TO_DATE}\"}" \
  "2" >/dev/null

echo "==> Initializing entity maintainers"
request_kibana \
  POST \
  "/internal/security/entity_store/entity_maintainers/init?apiVersion=2" \
  "{}" \
  "2" >/dev/null

if [[ "$RUN_MAINTAINER" -eq 1 ]]; then
  if [[ "$MAINTAINER_RUNS" -gt 0 ]]; then
    echo "==> Running risk-score maintainer ${MAINTAINER_RUNS} time(s)"
    for i in $(seq 1 "$MAINTAINER_RUNS"); do
      echo "  -> run $i"
      request_kibana \
        POST \
        "/internal/security/entity_store/entity_maintainers/run/risk-score" \
        "{}" \
        "2" >/dev/null
    done
  fi
else
  echo "==> Prepare-only mode: maintainer was NOT run"
fi

echo "==> Maintainer status snapshot"
MAINTAINERS_JSON="$(request_kibana GET "/internal/security/entity_store/entity_maintainers" "" "2")"
echo "$MAINTAINERS_JSON" | print_json_field '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(0, "utf8"));
const m = (data.maintainers || []).find((x) => x.id === "risk-score");
if (!m) {
  console.log("risk-score maintainer not found");
  process.exit(0);
}
console.log(JSON.stringify({
  id: m.id,
  taskStatus: m.taskStatus,
  runs: m.runs,
  lastSuccessTimestamp: m.lastSuccessTimestamp,
  lastErrorTimestamp: m.lastErrorTimestamp
}, null, 2));
'

echo "==> Risk score document count"
curl -sS -u "${USERNAME}:${PASSWORD}" \
  "${ES_URL%/}/risk-score.risk-score-${SPACE_ID}/_count" | \
  print_json_field '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8");
try {
  const data = JSON.parse(raw);
  if (data.error) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`count=${data.count}`);
  }
} catch {
  console.log(raw);
}
'

cat <<EOF

Done. Useful manual commands:

1) Run maintainer once:
curl -sS -u "${USERNAME}:${PASSWORD}" -X POST "${API_ROOT}/internal/security/entity_store/entity_maintainers/run/risk-score" \\
  -H "kbn-xsrf: true" -H "elastic-api-version: 2" -H "x-elastic-internal-origin: Kibana"

2) Check maintainer status:
curl -sS -u "${USERNAME}:${PASSWORD}" "${API_ROOT}/internal/security/entity_store/entity_maintainers" \\
  -H "kbn-xsrf: true" -H "elastic-api-version: 2" -H "x-elastic-internal-origin: Kibana"

3) Inspect risk scores:
curl -sS -u "${USERNAME}:${PASSWORD}" "${ES_URL%/}/risk-score.risk-score-${SPACE_ID}/_search?size=5&pretty"

EOF
