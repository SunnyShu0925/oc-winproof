// Preloaded into the real `openclaw gateway stop` CLI process
// (NODE_OPTIONS=--import) for PR #185577.
//
// Simulates the production incident: the host wall clock jumps (NTP resync /
// manual set / DST) while OpenClaw waits for the Windows Scheduled Task Gateway
// to settle. Only Date.now() is shifted; performance.now() stays monotonic,
// exactly like a real clock adjustment.
//
// PR #185577 moves the settlement deadline/remaining budget from Date.now()
// (wall clock) to performance.now() (monotonic). This preload:
//
//   1. Shifts Date.now() only while the call stack is inside the settlement
//      owner (src/daemon/schtasks-state-probe.ts). The FIRST Date.now read in
//      the owner is the deadline seed (returned real); every later read is
//      returned real+shift, collapsing the remaining-budget probe timeout.
//      On the fixed build the owner reads performance.now(), so Date.now() is
//      never reached -> inert.
//   2. Reports how many settlement Date.now reads were shifted to stderr so the
//      CLI log shows the jump was (pre-fix) / was not (post-fix) applied.
//
// Note: the settlement owner is a closure returned by prepareScheduledTaskSettlement,
// so that function is already off the stack when its body runs; the closure's
// frames carry their source location instead, so we match the source file.
const realNow = Date.now;
const shiftMs = Number(process.env.PROOF_SHIFT_MS ?? "0");

const settlementPatterns = [
  "schtasks-state-probe.ts",
  "prepareScheduledTaskSettlement",
  "ScheduledTaskSettlement",
];

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
  if (!settlementPatterns.some((needle) => stack.includes(needle))) {
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

process.on("exit", () => {
  process.stderr.write(
    `[proof-inject] settlement Date.now reads stepped: ${stepped}\n`,
  );
});
