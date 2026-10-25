// ESM preload (loaded via node --import): forward-jumps global Date.now by
// PROOF_JUMP_MS the moment a "retry-loop cadence" is detected on either
// Date.now() (pre-fix deadline) or performance.now() (post-fix deadline).
//
// retryScheduledTaskLeaseRead loops roughly every ~100-550ms (read throws
// SQLITE_BUSY, then sleep(min(100, remaining)), then deadline re-check). That
// produces a steady clock-call cadence. We forward-jump Date.now as soon as we
// see >=3 consecutive clock reads spaced 50-900ms apart, guaranteeing the jump
// lands AFTER the deadline was seeded (so pre-fix abandons the retry while
// post-fix, which uses performance.now for its deadline, is unaffected).
const JUMP_MS = Number(process.env.PROOF_JUMP_MS || 0);
const START = Date.now();
let firstNow = null;
let jumped = false;
let nowCalls = 0;
let perfCalls = 0;

function maybeJump(kind, elapsedSincePrev, totalSinceStart) {
  if (jumped || JUMP_MS <= 0) return;
  if (elapsedSincePrev >= 50 && elapsedSincePrev <= 900) {
    jump(kind, totalSinceStart);
  }
}

function jump(kind, totalSinceStart) {
  jumped = true;
  const real = Date.now;
  Date.now = () => real() + JUMP_MS;
  console.log(
    "[clock-inject] Date.now forward-jumped +" +
      JUMP_MS +
      "ms on " +
      kind +
      " cadence at t~" +
      Math.round(totalSinceStart) +
      "ms (Date.now calls=" +
      nowCalls +
      ", performance.now calls=" +
      perfCalls +
      ", first Date.now at t+" +
      (firstNow === null ? "?" : firstNow - START) +
      "ms)"
  );
}

if (JUMP_MS > 0) {
  const realDateNow = Date.now.bind(Date);
  const realPerfNow = performance.now.bind(performance);
  let prevNow = null;
  let prevPerf = null;
  let nowStreak = 0;
  let perfStreak = 0;
  const t0 = realPerfNow();

  Date.now = () => {
    const v = realDateNow();
    nowCalls++;
    if (firstNow === null) {
      firstNow = v;
      console.log("[clock-inject] first Date.now at t+" + (v - START) + "ms");
    }
    if (prevNow !== null) {
      const dt = v - prevNow;
      nowStreak = dt >= 50 && dt <= 900 ? nowStreak + 1 : 0;
      if (nowStreak >= 3) {
        jump("Date.now", realPerfNow() - t0);
        return jumped ? v + JUMP_MS : v;
      }
    } else {
      nowStreak = 0;
    }
    prevNow = v;
    return jumped ? v + JUMP_MS : v;
  };

  performance.now = () => {
    const v = realPerfNow();
    perfCalls++;
    if (prevPerf !== null) {
      const dt = v - prevPerf;
      perfStreak = dt >= 50 && dt <= 900 ? perfStreak + 1 : 0;
      if (perfStreak >= 3) {
        jump("performance.now", v - t0);
        return v;
      }
    } else {
      perfStreak = 0;
    }
    prevPerf = v;
    return v;
  };

  console.log(
    "[clock-inject] armed: forward-jump +" +
      JUMP_MS +
      "ms on first retry-loop cadence (3 consecutive 50-900ms clock reads)"
  );
}
