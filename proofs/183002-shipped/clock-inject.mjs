// ESM preload (loaded via node --import): forward-jumps global Date.now by
// PROOF_JUMP_MS at PROOF_JUMP_AT_MS after process start. Simulates a wall-clock
// NTP correction occurring during a lease-read retry loop.
// - pre-fix (Date.now deadline): the forward jump pushes Date.now() past the
//   retry deadline, so the next loop iteration abandons the read (fail).
// - post-fix (performance.now deadline): the forward jump does NOT affect
//   performance.now(), so the retry loop continues until the sibling releases
//   the exclusive lock (success).
const JUMP_MS = Number(process.env.PROOF_JUMP_MS || 0);
const JUMP_AT_MS = Number(process.env.PROOF_JUMP_AT_MS || 3500);
const START = Date.now();
let firstNow = null;
let nowCalls = 0;
if (JUMP_MS > 0) {
  const realDateNow = Date.now.bind(Date);
  let jumped = false;
  Date.now = () => {
    const v = realDateNow();
    nowCalls++;
    if (firstNow === null) {
      firstNow = v;
      console.log("[clock-inject] first Date.now at t+" + (v - START) + "ms");
    }
    return jumped ? v + JUMP_MS : v;
  };
  setTimeout(() => {
    if (!jumped) {
      jumped = true;
      console.log(
        "[clock-inject] Date.now forward-jumped +" +
          JUMP_MS +
          "ms at t+" +
          (realDateNow() - START) +
          "ms (Date.now calls so far=" +
          nowCalls +
          ", first at t+" +
          (firstNow === null ? "?" : firstNow - START) +
          "ms)"
      );
    }
  }, JUMP_AT_MS);
  console.log(
    "[clock-inject] armed: forward-jump +" +
      JUMP_MS +
      "ms at t+" +
      JUMP_AT_MS +
      "ms (PROOF_JUMP_MS=" +
      JUMP_MS +
      ")"
  );
}
