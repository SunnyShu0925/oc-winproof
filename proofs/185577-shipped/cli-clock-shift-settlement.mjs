// Preloaded into the real `openclaw gateway stop` CLI process
// (NODE_OPTIONS=--import) for PR #185577.
//
// Simulates the production incident: the host wall clock jumps (NTP resync /
// manual set / DST) while OpenClaw is waiting for the Windows Scheduled Task
// Gateway to settle. Only Date.now() is shifted; performance.now() stays
// monotonic, exactly like a real clock adjustment.
//
// PR #185577 moves the settlement deadline/remaining budget from Date.now()
// (wall clock) to performance.now() (monotonic). This preload does two things
// that are INERT on the fixed build and collapse the probe budget on the
// pre-fix build:
//
//   1. Date.now step inside the settlement owner
//      pre-fix  : deadline = Date.now()+330s ; remaining = deadline - Date.now()
//                 -> a +280s jump collapses the 60s probe to 50s; +380s to 1ms
//                 -> a -280s jump grows remaining and can leave the loop
//                    waiting on a deadline that never arrives
//      post-fix : deadline/remaining read performance.now (Date.now is inert)
//
//   2. spawnSync timeout capture
//      The settlement hands Math.min(60000, remaining) to the REAL PowerShell
//      probe as its spawnSync timeout. We record every such positive timeout so
//      the shipped CLI log shows the actual budget the probe got.
//
// The shift is armed only when the call stack is inside the settlement owner
// (`prepareScheduledTaskSettlement` / `ScheduledTaskSettlement`). The FIRST
// Date.now read inside the owner is treated as the deadline seed (returned
// real), and all subsequent reads are returned real+shift.
const realNow = Date.now;
const shiftMs = Number(process.env.PROOF_SHIFT_MS ?? "0");

const settlementPatterns = [
  "prepareScheduledTaskSettlement",
  "ScheduledTaskSettlement",
  "settlement-owner",
];

function inSettlementStack(stack) {
  return settlementPatterns.some((needle) => stack.includes(needle));
}

let inside = false;
let seedSeen = false;
let stepped = 0;

Date.now = function proofShiftedDateNow() {
  let stack = "";
  try {
    stack = new Error().stack ?? "";
  } catch {
    stack = "";
  }
  if (!inSettlementStack(stack)) {
    inside = false;
    seedSeen = false;
    return realNow();
  }
  if (!inside) {
    inside = true;
    seedSeen = false;
  }
  if (!seedSeen) {
    seedSeen = true;
    return realNow();
  }
  stepped += 1;
  return realNow() + shiftMs;
};

// Capture the real PowerShell probe budget the settlement hands to spawnSync.
const cp = await import("node:child_process");
const realSpawnSync = cp.spawnSync;
const probeTimeouts = [];
cp.spawnSync = function (...args) {
  const opts = args[2] || {};
  if (typeof opts.timeout === "number" && opts.timeout > 0) {
    probeTimeouts.push(opts.timeout);
    if (probeTimeouts.length <= 24) {
      process.stderr.write(
        `[proof-inject] settlement probe spawnSync timeout=${opts.timeout}ms\n`,
      );
    }
  }
  return realSpawnSync.apply(this, args);
};
process.on("exit", () => {
  process.stderr.write(
    `[proof-inject] settlement Date.now reads stepped: ${stepped}\n`,
  );
  process.stderr.write(
    `[proof-inject] settlement probe timeouts observed: [${probeTimeouts.join(", ")}]\n`,
  );
});
