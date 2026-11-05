#!/usr/bin/env bash
# Shipped-path proof for PR 193311: a process-local wall-clock step must not
# extend the WhatsApp group metadata cache lifetime, and a later group send must
# resolve a refreshed participant mention.
#
# Runs the shipped Gateway (source entry) and the shipped `message send` CLI with
# the bundled WhatsApp channel plugin. Only the WhatsApp Web socket is local
# (no paired device available); the group metadata cache owners, inbound monitor,
# and outbound send path are the shipped ones. Only Date.now() is stepped.
set -euo pipefail

VARIANT="${PROOF_VARIANT:-fixed}"
ROOT="${PROOF_REPO_ROOT:-$(pwd)}"
PROOF_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROOF_DIR="${PROOF_DIR:-$ROOT/proofs/193311/out-$VARIANT}"
GROUP_JID="${PROOF_GROUP_JID:-120363000000000001@g.us}"
SELF_JID="${PROOF_SELF_JID:-15550000001@s.whatsapp.net}"
WAIT_MS="${PROOF_WAIT_MS:-301000}"
STEP_MS="${PROOF_STEP_MS:-60000}"
PORT="${PROOF_GATEWAY_PORT:-$((39000 + RANDOM % 900))}"
PROOF_ENTRY="${PROOF_ENTRY:-source}"

STATE_DIR="$PROOF_DIR/state"
AUTH_DIR="$PROOF_DIR/wa-auth"
CONFIG_PATH="$STATE_DIR/openclaw.json"
GATEWAY_LOG="$PROOF_DIR/gateway.log"
SEND_LOG="$PROOF_DIR/send.log"

rm -rf "$PROOF_DIR"
mkdir -p "$STATE_DIR" "$PROOF_DIR"
chmod 700 "$PROOF_DIR" "$STATE_DIR"

export OPENCLAW_STATE_DIR="$STATE_DIR"
export OPENCLAW_CONFIG_PATH="$CONFIG_PATH"
export PROOF_REPO_ROOT="$ROOT"
export PROOF_DIR PROOF_GROUP_JID="$GROUP_JID" PROOF_SELF_JID="$SELF_JID" PROOF_WAIT_MS="$WAIT_MS" PROOF_STEP_MS="$STEP_MS"
export OPENCLAW_DISABLE_TELEMETRY=1
# Local loopback gateway auth: the shipped CLI authenticates with the same env token.
export OPENCLAW_GATEWAY_TOKEN="proof-local-token"

cat >"$CONFIG_PATH" <<JSON
{
  "gateway": { "mode": "local", "bind": "loopback", "port": $PORT, "auth": { "mode": "token" } },
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

if [[ "$PROOF_ENTRY" == "dist" ]]; then
  CLI_CMD=(node openclaw.mjs)
  GW_CMD=(node --import "$PROOF_SRC/preload-clock.mjs" --import "$PROOF_SRC/preload-socket.mjs" openclaw.mjs)
else
  CLI_CMD=(node --import tsx/esm src/entry.ts)
  GW_CMD=(node --import tsx/esm --import "$PROOF_SRC/preload-clock.mjs" --import "$PROOF_SRC/preload-socket.mjs" src/entry.ts)
fi

echo "PROOF variant=$VARIANT node=$(node -v) repo=$ROOT entry=$PROOF_ENTRY"
echo "PROOF cli=$("${CLI_CMD[@]}" --version 2>&1 | head -1)"
echo "PROOF state=$STATE_DIR port=$PORT group=$GROUP_JID waitMs=$WAIT_MS stepBackMs=$STEP_MS"

# No paired WhatsApp device is available on the runner, so the single Baileys
# socket factory call in the channel's session module is pointed at the local
# peer. The two cache files under test are untouched.
sed -i 's/const sock = makeWASocket({/const sock = globalThis.__proofMakeWASocket({/' extensions/whatsapp/src/session.ts
echo "PROOF clock reads in the two cache files under test:"
grep -nE "Date\.now\(\)|performance\.now\(\)" \
  extensions/whatsapp/src/inbound/baileys-cache.ts \
  extensions/whatsapp/src/inbound/group-metadata-cache.ts || true
echo "PROOF socket factory call site after patch:"
grep -n "__proofMakeWASocket" extensions/whatsapp/src/session.ts || true
echo "PROOF patched diff (socket factory only):"
git diff -U0 -- extensions/whatsapp/src/session.ts | grep -E "^[+-][^+-]" || true

node "$PROOF_SRC/write-creds.mjs" "$AUTH_DIR"

GATEWAY_PID=""
cleanup() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$GATEWAY_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$GATEWAY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "PROOF starting shipped Gateway: ${GW_CMD[*]} gateway run --port $PORT"
"${GW_CMD[@]}" gateway run --port "$PORT" --allow-unconfigured --verbose \
  >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!
echo "PROOF gateway pid=$GATEWAY_PID"

deadline=$((SECONDS + 600))
while [[ ! -f "$PROOF_DIR/send-ready" ]]; do
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    echo "PROOF gateway exited before probe; tail:"
    tail -n 60 "$GATEWAY_LOG" || true
    exit 1
  fi
  if (( SECONDS > deadline )); then
    echo "PROOF timed out waiting for cache probe; tail:"
    tail -n 80 "$GATEWAY_LOG" || true
    exit 1
  fi
  sleep 2
done

echo "PROOF probe reached; running shipped CLI send"

send_once() {
  local attempt="$1"
  set +e
  "${CLI_CMD[@]}" message send \
    --channel whatsapp \
    --target "$GROUP_JID" \
    --message "handoff ping @15550000333" \
    --json >"$SEND_LOG.$attempt" 2>&1
  local status=$?
  set -e
  echo "PROOF message send attempt=$attempt exit=$status"
  cat "$SEND_LOG.$attempt"
}

wait_for_socket_send() {
  local i
  for i in $(seq 1 60); do
    if grep -q "fixture socket.sendMessage" "$GATEWAY_LOG"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

send_once 1
if ! wait_for_socket_send; then
  echo "PROOF first send reached no socket delivery; retrying through the same CLI"
  send_once 2
  if ! wait_for_socket_send; then
    echo "PROOF no socket sendMessage observed; see $SEND_LOG.1 and $SEND_LOG.2"
  fi
fi

sleep 3
cleanup
GATEWAY_PID=""

echo "PROOF ${VARIANT} trace from Gateway process:"
grep -E "^PROOF " "$GATEWAY_LOG" || true
echo "PROOF ${VARIANT} done"
