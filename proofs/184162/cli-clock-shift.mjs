// Preloaded into the real `openclaw gateway stop` CLI process (NODE_OPTIONS=--import).
//
// Simulates the production incident: the host wall clock jumps forward while
// OpenClaw is reading a Windows process-start identity (NTP correction). Only
// Date.now() is shifted; performance.now() stays monotonic, exactly like a real
// clock adjustment.
//
// The shift is applied on the SECOND Date.now() read inside one
// readWindowsProcessStartTimeSync invocation -- the read that subtracts the
// deadline from "now" after the seed. On the fixed build that reader never
// calls Date.now(), so this module is inert.
const realNow = Date.now;
const shiftMs = Number(process.env.PROOF_SHIFT_MS ?? "10000");
const patterns = [
  "readWindowsProcessStartTimeSync",
  "WindowsProcessStartTime",
  "assertOwnerCurrent",
  "acquireTerminationExclusion",
];

let callsInInvocation = 0;
let inside = false;
let reported = 0;

Date.now = function proofShiftedDateNow() {
  let stack = "";
  try {
    stack = new Error().stack ?? "";
  } catch {
    stack = "";
  }
  const inTarget = patterns.some((needle) => stack.includes(needle));
  if (!inTarget) {
    inside = false;
    callsInInvocation = 0;
    return realNow();
  }
  callsInInvocation = inside ? callsInInvocation + 1 : 1;
  inside = true;
  if (callsInInvocation < 2) {
    return realNow();
  }
  if (reported < 6) {
    reported += 1;
    process.stderr.write(
      `[proof-inject] wall-clock step +${shiftMs}ms applied on Date.now read #${callsInInvocation}\n`,
    );
  }
  return realNow() + shiftMs;
};
