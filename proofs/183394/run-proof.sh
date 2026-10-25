#!/usr/bin/env bash
# PR 183394 real-socket proof: shipped `openclaw gateway` + shipped
# `openclaw gateway call web.login.start/web.login.wait` against a REAL Baileys
# socket that receives REAL QR refs from WhatsApp servers, with a mid-wait
# wall-clock rewind applied to the Gateway process (Date.now only).
set -uo pipefail

PROOF_DIR="$PWD/proofs/183394"
STATE_DIR="$PWD/.proof-state"
TOKEN="proof-token-183394"
PORT="${PROOF_PORT:-19873}"
TRIGGER="/tmp/oc-jump-trigger-183394"

rm -rf "$STATE_DIR" "$TRIGGER"
mkdir -p "$STATE_DIR"
cat > "$STATE_DIR/openclaw.json" <<JSON
{"gateway":{"mode":"local","auth":{"mode":"token","token":"$TOKEN"}},"channels":{"whatsapp":{"enabled":true}}}
JSON

export OPENCLAW_STATE_DIR="$STATE_DIR"
export PROOF_PORT="$PORT" PROOF_TOKEN="$TOKEN"
export PROOF_JUMP_TRIGGER="$TRIGGER"
export PROOF_JUMP_MS="${PROOF_JUMP_MS:-60000}"
export PROOF_WAIT_TIMEOUT_MS="${PROOF_WAIT_TIMEOUT_MS:-90000}"
export PROOF_JUMP_AT_MS="${PROOF_JUMP_AT_MS:-30000}"

echo "PROOF variant=${PROOF_VARIANT:-unknown} head=$(git rev-parse HEAD)"
echo "PROOF cli=$(node openclaw.mjs --version 2>&1 | head -1)"
echo "PROOF login-qr clock reads:"
grep -nE "const deadline = |const remaining = " extensions/whatsapp/src/login-qr.ts

NODE_OPTIONS="--import $PROOF_DIR/clock-jump.mjs" \
  node openclaw.mjs gateway --dev --auth token --token "$TOKEN" \
  --bind loopback --port "$PORT" > gateway.log 2>&1 &
GW_PID=$!
echo "GATEWAY_PID=$GW_PID"

ready=0
for i in $(seq 1 150); do
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "GATEWAY_EXITED early"
    break
  fi
  if node openclaw.mjs gateway call health \
      --url "ws://127.0.0.1:$PORT" --token "$TOKEN" --json --timeout 5000 >/dev/null 2>&1; then
    echo "GATEWAY_READY after ${i}s"
    ready=1
    break
  fi
  sleep 1
done

if [ "$ready" != "1" ]; then
  echo "GATEWAY_NOT_READY"
  tail -80 gateway.log
  kill "$GW_PID" 2>/dev/null || true
  exit 1
fi

node "$PROOF_DIR/drive.mjs"
DRIVE_EXIT=$?

echo "=== gateway log (tail 160) ==="
tail -160 gateway.log
kill "$GW_PID" 2>/dev/null || true
wait "$GW_PID" 2>/dev/null || true
exit "$DRIVE_EXIT"
