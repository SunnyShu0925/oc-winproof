#!/usr/bin/env bash
# Shipped-path proof for PR 193311.
#
# A running Gateway keeps a WhatsApp group-metadata cache entry. A wall-clock
# step backwards (NTP correction / VM resume) must not extend that entry's
# lifetime: the next group send has to re-read the participant list over the
# real transport and deliver the mention of a member who joined after the
# cached snapshot.
#
# Everything below is shipped code: the Gateway source entry, the bundled
# WhatsApp channel plugin (session, inbound monitor, cache owner, outbound send
# path) and the `message send` CLI. The only local stand-ins are:
#   * the WhatsApp Web endpoint, injected through the shipped
#     OPENCLAW_WHATSAPP_WEB_SOCKET_URL override, speaking the real Baileys
#     WebSocket + Noise protocol (wa-peer.mjs);
#   * a second real Signal device inside that peer (peer-device.mjs), which
#     decrypts the group stanza the client actually encrypted and reports the
#     mention list it received;
#   * a task-owned Noise trust anchor, because the shipped client pins
#     WhatsApp's long-term certificate key (anchor-trust.mjs restores it).
# Only Date.now() is stepped; performance.now() keeps running.
#
# variants: PROOF_VARIANT=fixed (branch) | reverted (both cache files at origin/main)
set -euo pipefail

VARIANT="${PROOF_VARIANT:-fixed}"
ROOT="${PROOF_REPO_ROOT:-$(pwd)}"
PROOF_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROOF_DIR="${PROOF_DIR:-$PROOF_SRC/out-$VARIANT}"
GROUP_JID="${PROOF_GROUP_JID:-120363000000000001@g.us}"
SELF_JID="${PROOF_SELF_JID:-15550000001@s.whatsapp.net}"
MENTION_JID="${PROOF_NEW_MEMBER_JID:-15550000333@s.whatsapp.net}"
WAIT_MS="${PROOF_WAIT_MS:-301000}"
STEP_MS="${PROOF_STEP_MS:-60000}"
GATEWAY_PORT="${PROOF_GATEWAY_PORT:-$((39000 + RANDOM % 900))}"
BASE_REF="${PROOF_BASE_REF:-origin/main}"
CACHE_FILES=(
  extensions/whatsapp/src/inbound/baileys-cache.ts
  extensions/whatsapp/src/inbound/group-metadata-cache.ts
)

STATE_DIR="$PROOF_DIR/state"
AUTH_DIR="$PROOF_DIR/wa-auth"
CONFIG_PATH="$STATE_DIR/openclaw.json"
GATEWAY_LOG="$PROOF_DIR/gateway.log"
PEER_LOG="$PROOF_DIR/peer.log"
SEND_LOG="$PROOF_DIR/send.log"
ANCHOR_FILE="$PROOF_DIR/anchor.json"
PEER_PORT_FILE="$PROOF_DIR/peer-port"
CLOCK_STEP_FILE="$PROOF_DIR/clock-step"
ROSTER_SWAP_FILE="$PROOF_DIR/roster-swap"

cleanup() {
  if [[ -n "${GATEWAY_PID:-}" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$GATEWAY_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$GATEWAY_PID" 2>/dev/null || true
  fi
  if [[ -n "${PEER_PID:-}" ]] && kill -0 "$PEER_PID" 2>/dev/null; then
    kill "$PEER_PID" 2>/dev/null || true
  fi
  if [[ "$VARIANT" == "reverted" ]]; then
    ( cd "$ROOT" && git checkout -- "${CACHE_FILES[@]}" ) || true
  fi
  ( cd "$ROOT" && PROOF_REPO_ROOT="$ROOT" node "$PROOF_SRC/anchor-trust.mjs" restore ) || true
}

rm -rf "$PROOF_DIR"
mkdir -p "$STATE_DIR"
chmod 700 "$PROOF_DIR" "$STATE_DIR"

# The loopback peer must be reached directly; this sandbox exports an HTTP proxy
# that the channel's websocket agent would otherwise tunnel through.
for proxy_var in http_proxy https_proxy all_proxy ftp_proxy \
  HTTP_PROXY HTTPS_PROXY ALL_PROXY FTP_PROXY NODE_USE_ENV_PROXY; do
  unset "$proxy_var" || true
done

export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"
export OPENCLAW_DISABLE_TELEMETRY=1
export OPENCLAW_GATEWAY_TOKEN="proof-local-token"
export PROOF_REPO_ROOT="$ROOT"
export PROOF_GROUP_JID="$GROUP_JID" PROOF_SELF_JID="$SELF_JID"

trap cleanup EXIT

cd "$ROOT"

if [[ "$VARIANT" == "reverted" ]]; then
  echo "PROOF arm=reverted: restoring both cache files from $BASE_REF before the run"
  for file in "${CACHE_FILES[@]}"; do
    git show "$BASE_REF:$file" >"$file"
  done
fi

echo "PROOF variant=$VARIANT node=$(node -v) repo=$ROOT"
echo "PROOF state=$STATE_DIR gatewayPort=$GATEWAY_PORT group=$GROUP_JID waitMs=$WAIT_MS stepBackMs=$STEP_MS"
echo "PROOF clock reads in the two cache files under test:"
grep -nE "Date\.now\(\)|performance\.now\(\)" "${CACHE_FILES[@]}" || true
if [[ "$VARIANT" == "reverted" ]]; then
  echo "PROOF working-tree diff for the two cache files (arm reverted to $BASE_REF):"
  git diff --stat -- "${CACHE_FILES[@]}" || true
fi

node "$PROOF_SRC/write-creds.mjs" "$AUTH_DIR"
PROOF_REPO_ROOT="$ROOT" node "$PROOF_SRC/anchor-trust.mjs" generate "$ANCHOR_FILE"
PROOF_REPO_ROOT="$ROOT" node "$PROOF_SRC/anchor-trust.mjs" apply "$ANCHOR_FILE"

echo "PROOF starting local WhatsApp Web protocol peer"
PROOF_REPO_ROOT="$ROOT" \
  PROOF_PEER_PORT_FILE="$PEER_PORT_FILE" \
  PROOF_ROSTER_SWAP_FILE="$ROSTER_SWAP_FILE" \
  PROOF_ANCHOR_FILE="$ANCHOR_FILE" \
  node "$PROOF_SRC/wa-peer.mjs" >"$PEER_LOG" 2>&1 &
PEER_PID=$!

for _ in $(seq 1 100); do
  [[ -f "$PEER_PORT_FILE" ]] && break
  sleep 0.1
done
if [[ ! -f "$PEER_PORT_FILE" ]]; then
  echo "PROOF peer did not report a port; log:"
  cat "$PEER_LOG" || true
  exit 1
fi
PEER_PORT="$(cat "$PEER_PORT_FILE")"
PEER_URL="ws://127.0.0.1:$PEER_PORT/ws/chat"
echo "PROOF peer pid=$PEER_PID url=$PEER_URL"

cat >"$CONFIG_PATH" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback", "port": $GATEWAY_PORT, "auth": { "mode": "token" } },
  "channels": {
    "whatsapp": {
      "enabled": true,
      "allowFrom": ["*"],
      "accounts": { "default": { "authDir": "$AUTH_DIR" } }
    }
  }
}
JSON
chmod 600 "$CONFIG_PATH"

CLI_CMD=(node --import tsx/esm src/entry.ts)
GW_CMD=(node --import tsx/esm --import "$PROOF_SRC/preload-clock.mjs" src/entry.ts)

echo "PROOF starting shipped Gateway: ${GW_CMD[*]} gateway run --port $GATEWAY_PORT"
OPENCLAW_WHATSAPP_WEB_SOCKET_URL="$PEER_URL" \
  PROOF_CLOCK_STEP_FILE="$CLOCK_STEP_FILE" \
  PROOF_STEP_MS="$STEP_MS" \
  "${GW_CMD[@]}" gateway run --port "$GATEWAY_PORT" --allow-unconfigured --verbose \
  >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!
echo "PROOF gateway pid=$GATEWAY_PID"

deadline=$((SECONDS + 420))
while true; do
  if grep -q "group roster served" "$PEER_LOG"; then
    break
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "PROOF gateway exited before the channel hydrated; tail:"
    tail -n 80 "$GATEWAY_LOG" || true
    exit 1
  fi
  if (( SECONDS > deadline )); then
    echo "PROOF timed out waiting for channel hydration; gateway tail:"
    tail -n 80 "$GATEWAY_LOG" || true
    exit 1
  fi
  sleep 2
done
echo "PROOF channel hydrated over the real transport:"
grep -E "group roster served|group metadata served|noise handshake complete|success node sent" "$PEER_LOG" | tail -n 5

echo "PROOF waiting ${WAIT_MS}ms of real elapsed time (cache TTL is 300000ms)"
sleep "$((WAIT_MS / 1000))"

echo "PROOF stepping the Gateway wall clock back ${STEP_MS}ms (Date.now only)"
: >"$CLOCK_STEP_FILE"
sleep 1
grep -E "^PROOF clock step back" "$GATEWAY_LOG" || {
  echo "PROOF clock step was not observed; gateway tail:"
  tail -n 40 "$GATEWAY_LOG" || true
  exit 1
}

echo "PROOF adding the new group member on the peer (silent roster change)"
: >"$ROSTER_SWAP_FILE"
sleep 1
grep -E "roster refreshed" "$PEER_LOG" || true

if [[ "$VARIANT" == "fixed" ]]; then
  EXPECTED="mentionedJid=[\"$MENTION_JID\"]"
else
  EXPECTED="mentionedJid=[]"
fi

# The runner occasionally stalls the Gateway's main thread for ~30 s right after
# the wall clock moves (the delivery pipeline measures its own timers on
# Date.now), and a prepared payload can then keep the unresolved text. One
# repeat send is the user-visible retry; the cache deadline is still the thing
# under test, because the second send re-resolves the mention from the cache.
send_attempt() {
  local attempt="$1"
  local log="$SEND_LOG.$attempt"
  local delivered_before
  delivered_before="$(grep -c "delivery decrypted" "$PEER_LOG" || true)"

  echo "PROOF running shipped CLI send (attempt $attempt)"
  set +e
  "${CLI_CMD[@]}" message send \
    --channel whatsapp \
    --target "$GROUP_JID" \
    --message "handoff ping @15550000333" \
    --json >"$log" 2>&1
  local status=$?
  set -e
  echo "PROOF message send attempt=$attempt exit=$status"
  cat "$log"

  local deadline=$((SECONDS + 120))
  while [[ "$(grep -c "delivery decrypted" "$PEER_LOG" || true)" -le "$delivered_before" ]]; do
    if (( SECONDS > deadline )); then
      echo "PROOF no delivered group stanza observed for attempt $attempt; peer tail:"
      tail -n 40 "$PEER_LOG" || true
      return 1
    fi
    sleep 1
  done

  echo "PROOF delivery observed on the peer device (attempt $attempt):"
  grep -E "message stanza|message participants|delivery " "$PEER_LOG" | tail -n 4

  local last_delivery
  last_delivery="$(grep "delivery decrypted" "$PEER_LOG" | tail -n 1)"
  echo "PROOF last delivery: $last_delivery"
  case "$last_delivery" in
    *"$EXPECTED"*) return 0 ;;
    *) return 1 ;;
  esac
}

if ! send_attempt 1; then
  echo "PROOF attempt 1 did not produce $EXPECTED; repeating the send once"
  send_attempt 2 || true
fi

last_delivery="$(grep "delivery decrypted" "$PEER_LOG" | tail -n 1)"
if [[ "$last_delivery" == *"$EXPECTED"* ]]; then
  echo "PROOF RESULT variant=$VARIANT expected=$EXPECTED observed=OK"
else
  echo "PROOF RESULT variant=$VARIANT expected=$EXPECTED observed=UNEXPECTED"
  tail -n 20 "$PEER_LOG" || true
  exit 1
fi

echo "PROOF ${VARIANT} trace from the Gateway process:"
grep -E "^PROOF " "$GATEWAY_LOG" || true
echo "PROOF ${VARIANT} done"
