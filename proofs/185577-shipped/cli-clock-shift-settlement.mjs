// Preloaded into the real `openclaw gateway stop` CLI process
// (NODE_OPTIONS=--import) for PR #185577.
//
// Simulates the production incident: the host wall clock jumps (NTP resync /
// manual set / DST) while OpenClaw is waiting for the Windows Scheduled Task
// Gateway to settle. Only Date.now() is shifted; performance.now() stays
// monotonic, exactly like a real clock adjustment.
//
// PR #185577 moves the settlement deadline/remaining budget from Date.now()
// (wall clock) to performance.now() (monotonic). This preload steps the
// wall clock inside the settlement closure so that:
//
//   pre-fix  : deadline = Date.now()+budget ; remaining = deadline - Date.now()
//              -> a forward jump collapses the probe timeout (50s or 1ms),
//                 the PowerShell probe is killed / settlement mis-declares
//   post-fix : deadline = performance.now()+budget (Date.now inject is inert)
//              -> the settlement keeps its full 60s probe budget
//
// The shift is armed only when the call stack is inside the settlement owner
// (`prepareScheduledTaskSettlement` / its closure). The FIRST Date.now read
// inside the closure is treated as the deadline seed (returned real), and all
// subsequent Date.now reads are returned real+shift. On the fixed build the
// settlement never calls Date.now(), so this module is inert there (that is the
// proof's post-fix signal).
const realNow = Date.now;
const shiftMs = Number(process.env.PROOF_SHIFT_MS ?? "0");

const settlementPatterns = [
  "prepareScheduledTaskSettlement",
  "ScheduledTaskSettlement",
  "settlement",
];

let inside = false;
let seedSeen = false;
let applied = 0;

Date.now = function proofShiftedDateNow() {
  let stack = "";
  try {
    stack = new Error().stack ?? "";
  } catch {
    stack = "";
  }
  const inSettlement = settlementPatterns.some((needle) => stack.includes(needle));
  if (!inSettlement) {
    inside = false;
    seedSeen = false;
    return realNow();
  }
  if (!inside) {
    inside = true;
    seedSeen = false;
  }
  if (!seedSeen) {
    // First Date.now read inside the settlement closure = the deadline seed.
    seedSeen = true;
    return realNow();
  }
  if (applied < 12) {
    applied += 1;
    process.stderr.write(
      `[proof-inject] wall-clock step ${shiftMs >= 0 ? "+" : ""}${shiftMs}ms applied on settlement Date.now read\n`,
    );
  }
  return realNow() + shiftMs;
};

// Report how many reads the fixed (post-fix) build still routes through the
// stepped wall clock inside the settlement path -- expected 0 (inert).
process.on("exit", () => {
  process.stderr.write(`[proof-inject] settlement Date.now reads stepped: ${applied}\n`);
});
