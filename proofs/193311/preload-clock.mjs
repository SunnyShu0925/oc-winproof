// Process-local wall-clock control for the PR 193311 proof.
// Only Date.now() is stepped. performance.now(), timers, and the OS clock stay
// untouched, so the Gateway's elapsed-time deadline keeps running on real time.
const realDateNow = Date.now.bind(Date);

let offsetMs = 0;

function wallIso(ms) {
  return new Date(ms).toISOString();
}

globalThis.__proofWallClock = {
  stepBack(ms) {
    const before = realDateNow();
    offsetMs -= ms;
    const after = realDateNow() + offsetMs;
    process.stdout.write(
      `PROOF clock step back ${ms}ms (Date.now only): wall ${wallIso(before)} -> ${wallIso(after)} performance.now=${performance.now().toFixed(0)}ms\n`,
    );
    return offsetMs;
  },
  offsetMs: () => offsetMs,
  realNowMs: () => realDateNow(),
};

Date.now = () => realDateNow() + offsetMs;

process.stdout.write(
  `PROOF preload clock armed pid=${process.pid} offsetMs=${offsetMs} performance.now=${performance.now().toFixed(0)}ms\n`,
);
