#!/usr/bin/env bash
# Fetch Chalk It Pro workout data using a browser session JWT.
#
# Setup (token lives OUTSIDE the repo, chmod 600, never in chat/git):
#   1. Log in at https://app.chalkitpro.com
#   2. DevTools -> Application -> Local Storage -> app.chalkitpro.com -> jwt_access_token
#   3. Copy the value, then:
#        mkdir -p ~/.config/chalkitpro
#        pbpaste > ~/.config/chalkitpro/token
#        chmod 600 ~/.config/chalkitpro/token
#
# Usage:
#   ./fetch-chalkitpro.sh probe            # discover which endpoints respond for this account
#   ./fetch-chalkitpro.sh get <path>       # GET one endpoint, pretty-print + save
#
# Output: JSON saved to ../workout-samples/api/ (gitignored personal notes area).

set -euo pipefail

TOKEN_FILE="${CHALKITPRO_TOKEN_FILE:-$HOME/.config/chalkitpro/token}"
API_BASE="https://api.chalkitpro.com/api"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/api"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "No token at $TOKEN_FILE. See setup comments at top of this script." >&2
  exit 1
fi
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"

# Warn on expired JWT (payload exp claim) without printing the token.
exp=$(printf '%s' "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | { p=$(cat); pad=$(( (4 - ${#p} % 4) % 4 )); printf '%s%s' "$p" "$(printf '=%.0s' $(seq 1 $pad) 2>/dev/null)"; } | base64 -d 2>/dev/null | grep -oE '"exp":[0-9]+' | grep -oE '[0-9]+' || true)
if [[ -n "${exp:-}" ]] && (( exp < $(date +%s) )); then
  echo "Token expired ($(date -r "$exp" 2>/dev/null || echo "epoch $exp")). Grab a fresh one from the browser." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

api_get() {
  local path="$1"
  curl -s --max-time 20 -w '\n%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Accept: application/json' \
    "$API_BASE/$path"
}

save_get() {
  local path="$1"
  local slug; slug=$(printf '%s' "$path" | tr '/?&=' '____')
  local resp code body
  resp=$(api_get "$path")
  code=$(printf '%s' "$resp" | tail -1)
  body=$(printf '%s' "$resp" | sed '$d')
  if [[ "$code" == 200 && -n "$body" ]]; then
    printf '%s' "$body" > "$OUT_DIR/$slug.json"
    echo "200 $path -> data/api/$slug.json ($(printf '%s' "$body" | wc -c | tr -d ' ') bytes)"
  else
    echo "$code $path"
  fi
}

case "${1:-probe}" in
  probe)
    # Candidate endpoints observed in the app bundle (main.372ab3b1.js).
    # Exact shapes unknown until first authenticated run; 404s are expected data.
    for p in \
      "auth/access-token" \
      "user" "users/me" "profile" \
      "wodresults" "wodresults/me" \
      "workouts" "trackworkouts" \
      "tracks" "tracksubscribers" \
      "wodmovements" "wodsharecodes" \
      "workoutprograms" "exports" \
      ; do
      save_get "$p"
    done
    echo
    echo "Next: inspect any 200s above, then use './fetch-chalkitpro.sh get <path>' to pull detail/paginated data."
    ;;
  get)
    [[ -n "${2:-}" ]] || { echo "usage: $0 get <path>" >&2; exit 1; }
    save_get "$2"
    ;;
  *)
    echo "usage: $0 [probe|get <path>]" >&2; exit 1;;
esac
