// Drives the SHIPPED `openclaw gateway call` CLI against a running Gateway:
//   web.login.start -> real Baileys socket -> real QR from WhatsApp servers
//   web.login.wait  -> shipped RPC -> real waitForWebLogin
// and writes the clock-jump trigger mid-wait so the Gateway process sees a
// wall-clock rewind while the monotonic budget must keep the wait bounded.
//
// Elapsed time is measured with performance.now() on the client (never the
// warped Date.now), so the reported REAL_ELAPSED is true elapsed time.
import { spawn } from "node:child_process";
import fs from "node:fs";

const port = process.env.PROOF_PORT ?? "19873";
const token = process.env.PROOF_TOKEN ?? "";
const waitTimeoutMs = Number(process.env.PROOF_WAIT_TIMEOUT_MS ?? "90000");
const jumpAtMs = Number(process.env.PROOF_JUMP_AT_MS ?? "30000");
const triggerPath = process.env.PROOF_JUMP_TRIGGER ?? "/tmp/oc-jump-trigger";

const base = ["openclaw.mjs", "gateway", "call"];
const target = ["--url", `ws://127.0.0.1:${port}`, "--token", token, "--json"];

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({
        ms: Math.round(performance.now() - t0),
        code,
        signal,
        out: out.trim(),
        err: err.trim(),
      });
    });
  });
}

function summarize(text, max = 420) {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const started = await run(
  [...base, "web.login.start", ...target, "--params", JSON.stringify({ channel: "whatsapp" }),
   "--timeout", "180000"],
  200_000,
);
console.log(`PROOF start status=${started.code} elapsedMs=${started.ms} out=${summarize(started.out)}`);
if (started.code !== 0) {
  console.log(`PROOF start stderr=${summarize(started.err)}`);
  process.exit(1);
}

if (fs.existsSync(triggerPath)) fs.rmSync(triggerPath);

const waitStartedAt = performance.now();
const jumpTimer = setTimeout(() => {
  fs.writeFileSync(triggerPath, String(Date.now()));
  console.log(
    `PROOF jump-trigger written at waitElapsed=${Math.round(performance.now() - waitStartedAt)}ms`,
  );
}, jumpAtMs);

const waited = await run(
  [...base, "web.login.wait", ...target, "--params",
   JSON.stringify({ channel: "whatsapp", timeoutMs: waitTimeoutMs }), "--timeout", "300000"],
  320_000,
);
clearTimeout(jumpTimer);

console.log(
  `PROOF wait status=${waited.code} REAL_ELAPSED=${waited.ms}ms configuredTimeoutMs=${waitTimeoutMs} out=${summarize(waited.out)}`,
);
if (waited.err) console.log(`PROOF wait stderr=${summarize(waited.err)}`);
