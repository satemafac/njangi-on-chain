#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env.local"
APP=""
FRONTEND_APP=""
BOT_APP=""
DRY_RUN="false"
BASE_URL=""

usage() {
  cat <<'EOF'
Usage:
  scripts/heroku/sync-config.sh --app <heroku-app> [--env-file <path>] [--dry-run]
  scripts/heroku/sync-config.sh --frontend-app <frontend-app> --bot-app <bot-app> [--env-file <path>] [--dry-run]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      APP="$2"
      shift 2
      ;;
    --frontend-app)
      FRONTEND_APP="$2"
      shift 2
      ;;
    --bot-app)
      BOT_APP="$2"
      shift 2
      ;;
    --env-file)
      ENV_FILE="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

if [[ -n "$APP" && ( -n "$FRONTEND_APP" || -n "$BOT_APP" ) ]]; then
  echo "Choose either --app or --frontend-app/--bot-app." >&2
  exit 1
fi

if [[ -z "$APP" && ( -z "$FRONTEND_APP" || -z "$BOT_APP" ) ]]; then
  echo "Provide either --app or both --frontend-app and --bot-app." >&2
  exit 1
fi

ALL_LINES=()
while IFS= read -r line; do
  trimmed="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//')"
  ALL_LINES+=("$trimmed")
done < <(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$ENV_FILE")

for line in "${ALL_LINES[@]}"; do
  if [[ "${line%%=*}" == "NEXT_PUBLIC_BASE_URL" ]]; then
    BASE_URL="${line#*=}"
    break
  fi
done

FRONTEND_REGEX='^(NEXT_PUBLIC_|DATABASE_URL|BACKEND_AUTH_TOKEN|WHATSAPP_BACKEND_URL|CIRCLE_BACKEND_URL|ANALYTICS_URL|REDIS_URL|LOG_LEVEL|LOG_FILE|ENABLE_EVENT_LISTENER|ENABLE_MESSAGE_SENDER|ENABLE_ON_CHAIN_LOGGING|WHATSAPP_|MOONPAY_|CDP_|COINBASE_|FRONTEND_URL)='
BOT_REGEX='^(NEXT_PUBLIC_SUI_NETWORK|NEXT_PUBLIC_TESTNET_RPC_URL|NEXT_PUBLIC_MAINNET_RPC_URL|NEXT_PUBLIC_TESTNET_RPC_ALT|NEXT_PUBLIC_MAINNET_RPC_ALT|NEXT_PUBLIC_TESTNET_GRAPHQL_URL|NEXT_PUBLIC_MAINNET_GRAPHQL_URL|NEXT_PUBLIC_TESTNET_PACKAGE_ID|NEXT_PUBLIC_MAINNET_PACKAGE_ID|NEXT_PUBLIC_TESTNET_WHATSAPP_PACKAGE_ID|NEXT_PUBLIC_MAINNET_WHATSAPP_PACKAGE_ID|NEXT_PUBLIC_TESTNET_WHATSAPP_REGISTRY_ID|NEXT_PUBLIC_MAINNET_WHATSAPP_REGISTRY_ID|NEXT_PUBLIC_ENOKI_TESTNET|NEXT_PUBLIC_ENOKI_MAINNET|WHATSAPP_|FRONTEND_URL|REDIS_URL|LOG_LEVEL|LOG_FILE|ENABLE_EVENT_LISTENER|ENABLE_MESSAGE_SENDER|ENABLE_ON_CHAIN_LOGGING)='

sync_app() {
  local app_name="$1"
  local mode="$2"
  local regex="$3"
  local -a kv_pairs=()

  for line in "${ALL_LINES[@]}"; do
    if [[ "$line" =~ $regex ]]; then
      key="${line%%=*}"
      value="${line#*=}"
      value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//')"

      case "$key" in
        REACT_EDITOR|NEXT_PUBLIC_HOST_IP)
          echo "Skipping ${key}: local-only key"
          continue
          ;;
      esac

      if [[ "$key" == "NEXT_PUBLIC_REDIRECT_URI" && "$value" == *"localhost"* && -n "$BASE_URL" ]]; then
        value="${BASE_URL%/}/auth/callback"
      fi

      if [[ -z "$value" ]]; then
        echo "Skipping ${key}: empty value"
        continue
      fi

      if [[ "$value" == *"<"* || "$value" == *"["* || "$value" == *"placeholder"* ]]; then
        echo "Skipping ${key}: placeholder value"
        continue
      fi

      kv_pairs+=("${key}=${value}")
    fi
  done

  if [[ "${#kv_pairs[@]}" -eq 0 ]]; then
    echo "No matching keys found for ${mode} app ${app_name}" >&2
    exit 1
  fi

  echo "Syncing ${#kv_pairs[@]} keys to ${mode} app ${app_name}"

  if [[ "$DRY_RUN" == "true" ]]; then
    printf '  %s\n' "${kv_pairs[@]}"
    return
  fi

  heroku config:set --app "$app_name" "${kv_pairs[@]}"
}

if [[ -n "$APP" ]]; then
  sync_app "$APP" "shared" '^[A-Za-z_][A-Za-z0-9_]*='
else
  sync_app "$FRONTEND_APP" "frontend" "$FRONTEND_REGEX"
  sync_app "$BOT_APP" "bot" "$BOT_REGEX"
fi
