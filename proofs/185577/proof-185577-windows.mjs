// PR #185577 real Windows settlement-clock proof.
//
// Drives the SHIPPED `prepareScheduledTaskSettlement` owner against a REAL
// Scheduled Task and REAL PowerShell subprocess probes, and applies a wall-clock
// forward jump on Date.now() between the settlement deadline seed and the
// remaining-budget read. Because the shipped owner's deadline lives on the
// monotonic clock (performance.now) after this PR, the injected Date.now jump
// is inert and the probe keeps its full budget; on the pre-fix build (deadline
// on Date.now) the jump collapses the probe timeout exactly as the incident
// described.
//
//   pre-fix  : deadline = Date.now()+budget ; remaining = deadline - Date.now()
//              -> +280s jump collapses 60s probe to 50s; +380s to 1ms
//   post-fix : deadline = performance.now()+budget (Date.now inject is inert)
//              -> probe keeps 60s under the same jumps
//
// The proof captures the `timeout` actually handed to the real PowerShell
// subprocess (the "spawnSync" options) for the first settlement probe.

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const cp = require("node:child_process");

const root = process.cwd();
const taskName = "OpenClaw Proof Settlement";
const shiftMs = Number(process.env.PROOF_SHIFT_MS ?? "280000");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Capture the timeout handed to the REAL PowerShell probe ----
const probeTimeouts = [];
const realSpawnSync = cp.spawnSync;
cp.spawnSync = function (...args) {
  const opts = args[2] || {};
  if (typeof opts.timeout === "number" && opts.timeout > 0) {
    probeTimeouts.push(opts.timeout);
  }
  return realSpawnSync.apply(this, args);
};

// ---- Import the shipped settlement owner (source) AFTER patching spawnSync ----
// Run with `node --import tsx/esm` so the .ts source is loaded directly (the
// pre/post builds differ only in the clock substitution inside this file).
const probeMod = await import(
  pathToFileURL(join(root, "src/daemon/schtasks-state-probe.ts")).href,
);
const { prepareScheduledTaskSettlement } = probeMod;

// ---- Ensure a REAL Scheduled Task exists (state=Ready, non-empty LastTaskResult) ----
function ensureTask() {
  const r = cp.spawnSync(
    "schtasks.exe",
    [
      "/Create",
      "/TN",
      taskName,
      "/TR",
      "powershell.exe -NoProfile -Command exit 0",
      "/SC",
      "ONCE",
      "/ST",
      "00:00",
      "/F",
    ],
    { encoding: "utf8", timeout: 30000, windowsHide: false },
  );
  console.log(`[task.create] exit=${r.status} out=${(r.stdout || "").trim() || r.stderr || ""}`);
  // Force a non-empty LastTaskResult so the settlement owner can reach "settled".
  const run = cp.spawnSync("schtasks.exe", ["/Run", "/TN", taskName], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: false,
  });
  console.log(`[task.run] exit=${run.status} out=${(run.stdout || "").trim() || run.stderr || ""}`);
  // Wait for the /Run to finish: state returns to Ready and LastTaskResult is
  // written, so the settlement owner reaches "settled" on its first budgeted probe.
  await sleep(4000);
}

function armClockShift() {
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => {
    calls += 1;
    // First Date.now read inside the settlement closure is the deadline seed.
    return calls === 1 ? realNow() : realNow() + shiftMs;
  };
  console.log(
    `[clock] armed Date.now forward jump +${shiftMs}ms (seed=real, reads=real+${shiftMs}ms)`,
  );
}

// ---- Run one settlement under the current (source) build ----
async function runScenario(label) {
  probeTimeouts.length = 0;
  ensureTask();
  await sleep(1500);

  console.log("");
  console.log(`=== ${label}: prepareScheduledTaskSettlement (seed probe, real clock) ===`);
  const settle = prepareScheduledTaskSettlement(taskName);

  console.log(`=== ${label}: arm clock jump, run settlement closure ===`);
  armClockShift();
  let result;
  try {
    result = await settle(
      () => {},
      async () => {},
    );
    console.log(`[settlement] status=${result.status} ended=${result.ended}`);
  } catch (e) {
    console.log(`[settlement] THREW ${e.message}`);
  }

  // The seed probe (run before the clock arm) captures 60000ms. The closure's
  // first budgeted probe runs AFTER the clock arm and is the last positive
  // timeout captured: its value is what the incident collapses.
  const positive = probeTimeouts.filter((t) => t > 0);
  const budgetProbe = positive[positive.length - 1];
  console.log(`[probe] captured spawnSync timeouts: [${probeTimeouts.join(", ")}]`);
  console.log(
    `[probe] last positive-budget probe timeout (after clock arm) = ${budgetProbe === undefined ? "NONE" : budgetProbe}ms`,
  );
  return budgetProbe;
}

const p1 = await runScenario("SCENARIO settlement");
console.log("");
console.log(`VERDICT: last positive-budget settlement probe timeout = ${p1 === undefined ? "NONE" : p1}ms (target 60000 for post-fix, ${Math.max(1, 60000 - shiftMs)} for pre-fix at +${shiftMs}ms)`);

// Cleanup
cp.spawnSync("schtasks.exe", ["/End", "/TN", taskName], { encoding: "utf8", timeout: 15000, windowsHide: false });
cp.spawnSync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"], { encoding: "utf8", timeout: 15000, windowsHide: false });
