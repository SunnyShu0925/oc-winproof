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
//      owner (bundled: the service-state chunk; source: schtasks-state-probe.ts).
//      Within a SINGLE function invocation the FIRST Date.now read is the
//      deadline seed (returned real); every later read in that same invocation
//      is returned real+shift, collapsing the remaining-budget probe timeout.
//      On the fixed build the owner reads performance.now(), so Date.now() is
//      never reached -> inert.
//   2. Reports how many settlement Date.now reads were shifted to stderr so the
//      CLI log shows the jump was (pre-fix) / was not (post-fix) applied.
//
// The settlement owner is a closure returned by prepareScheduledTaskSettlement,
// so that function is already off the stack when its body runs; the closure's
// frames carry their source location instead, so we match the file/chunk. To
// reset the seed at the boundary of each function INVOCATION (and not on every
// line of the long-running for(;;) settlement loop), we key the seed on the
// frame of the CALLER of the innermost matching frame. During the whole
// settlement loop the caller (terminate at its `await settle(...)` call site)
// is constant, so all reads after the seed are stepped; sibling helpers in the
// same chunk (waitForProcessExit) have a different caller line, so they get
// their own seed and do not corrupt the settlement seed.
const realNow = Date.now;
const shiftMs = Number(process.env.PROOF_SHIFT_MS ?? "0");

const settlementPatterns = [
  // Bundled runtime: settlement owner + terminate/waitForProcessExit all live in
  // the service-state chunk. Match the stable filename prefix (trailing hash
  // varies between builds).
  "service-state-",
  // Source / tsx mode fallback:
  "schtasks-state-probe.ts",
  "prepareScheduledTaskSettlement",
  "ScheduledTaskSettlement",
];

// Frames: [0]="Error", [1]=this preload's own frame, [2]=innermost caller,
// [3]=its caller, ... Return the caller-of-innermost frame ([3]) as the
// invocation identity, falling back to [2] on shallow stacks.
function invocationIdentity(stack) {
  const lines = stack.split("\n");
  for (let i = 2; i < lines.length && i < 8; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.includes("cli-clock-shift-settlement.mjs")) continue;
    if (i === 2) continue; // skip the innermost caller; use its caller
    return line;
  }
  // Fallback: use the innermost caller.
  for (let i = 2; i < lines.length && i < 4; i++) {
    const line = lines[i].trim();
    if (line && !line.includes("cli-clock-shift-settlement.mjs")) return line;
  }
  return "";
}

let lastIdentity = "";
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
    lastIdentity = "";
    seedSeen = false;
    return realNow();
  }
  const identity = invocationIdentity(stack);
  if (identity !== lastIdentity) {
    // New invocation entered the matching region -> this read is the seed.
    lastIdentity = identity;
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
