// ESM preload (loaded via node --import): forward-jumps global Date.now by
// PROOF_JUMP_MS the moment a "retry-loop cadence" is detected on Date.now()
// reads AFTER t>5s (skipping daemon-init performance-monitor cadence).
//
// Pre-fix retryScheduledTaskLeaseRead seeds its deadline from Date.now() and
// re-checks it with Date.now() every ~100-550ms. Once we see >=3 consecutive
// Date.now reads 50-900ms apart at t>5s, the retry loop is definitely active
// (deadline already seeded), so forward-jumping Date.now makes pre-fix abandon
// the retry. Post-fix uses performance.now() for its deadline, so the jump does
// not disturb it and it retries through to lock release (SUCCESS).
const JUMP_MS = Number(process.env.PROOF_JUMP_MS || 0);
const START = Date.now();
let firstNow = null;
let jumped = false;
let nowCalls = 0;

function jump(reason, t) {
  jumped = true;
  const real = Date.now;
  Date.now = () => real() + JUMP_MS;
  console.log(
    "[clock-inject] Date.now forward-jumped +" +
      JUMP_MS +
      "ms (" +
      reason +
      ") at t~" +
      Math.round(t) +
      "ms (Date.now calls=" +
      nowCalls +
      ", first Date.now at t+" +
      (firstNow === null ? "?" : firstNow - START) +
      "ms)"
  );
}

if (JUMP_MS > 0) {
  const realDateNow = Date.now.bind(Date);
  let prevNow = null;
  let nowStreak = 0;
  const t0 = Date.now();

  Date.now = () => {
    const v = realDateNow();
    nowCalls++;
    const elapsed = v - t0;
    if (firstNow === null) {
      firstNow = v;
      console.log("[clock-inject] first Date.now at t+" + elapsed + "ms");
    }
    if (!jumped && elapsed > 5000) {
      if (prevNow !== null) {
        const dt = v - prevNow;
        nowStreak = dt >= 50 && dt <= 900 ? nowStreak + 1 : 0;
        if (nowStreak >= 3) {
          jump("Date.now cadence t>5s", elapsed);
          return jumped ? v + JUMP_MS : v;
        }
      } else {
        nowStreak = 0;
      }
    }
    prevNow = v;
    return jumped ? v + JUMP_MS : v;
  };

  console.log(
    "[clock-inject] armed: forward-jump +" +
      JUMP_MS +
      "ms on Date.now cadence (>=3 consecutive 50-900ms reads) after t>5s"
  );
}
