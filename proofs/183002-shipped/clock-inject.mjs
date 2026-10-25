// ESM preload (loaded via node --import): forward-jumps global Date.now by
// PROOF_JUMP_MS at PROOF_JUMP_AT_MS after process start. Simulates a wall-clock
// NTP correction occurring during a lease-read retry loop.
// Also counts performance.now() calls to detect retry-loop activity (post-fix
// retry uses performance.now every ~100ms; pre-fix retry uses Date.now).
const JUMP_MS = Number(process.env.PROOF_JUMP_MS || 0);
const JUMP_AT_MS = Number(process.env.PROOF_JUMP_AT_MS || 8000);
const START = Date.now();
let firstNow = null;
let nowCalls = 0;
let perfCalls = 0;
if (JUMP_MS > 0) {
  const realDateNow = Date.now.bind(Date);
  const realPerfNow = performance.now.bind(performance);
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
  performance.now = () => {
    perfCalls++;
    return realPerfNow();
  };
  const t0 = realPerfNow();
  const iv = setInterval(() => {
    if (jumped) {
      clearInterval(iv);
      return;
    }
    const elapsed = realPerfNow() - t0;
    if (elapsed >= JUMP_AT_MS) {
      jumped = true;
      clearInterval(iv);
      console.log(
        "[clock-inject] Date.now forward-jumped +" +
          JUMP_MS +
          "ms at t~" +
          Math.round(elapsed) +
          "ms (Date.now calls=" +
          nowCalls +
          ", performance.now calls=" +
          perfCalls +
          ", first Date.now at t+" +
          (firstNow === null ? "?" : firstNow - START) +
          "ms)"
      );
    }
  }, 50);
  console.log(
    "[clock-inject] armed: forward-jump +" +
      JUMP_MS +
      "ms at t~" +
      JUMP_AT_MS +
      "ms (PROOF_JUMP_MS=" +
      JUMP_MS +
      ")"
  );
}
