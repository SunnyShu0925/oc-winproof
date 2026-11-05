// Process-local wall-clock control for the PR 193311 proof.
// Only Date.now() is stepped. performance.now(), timers, and the OS clock stay
// untouched, so the cache deadline measured on elapsed time keeps running.
//
// The step is triggered by the harness creating PROOF_CLOCK_STEP_FILE, which
// mirrors an NTP correction / VM resume moving the wall clock backwards while
// the Gateway keeps running.
import fs from "node:fs";

// The Gateway loads its entry twice (tsx transform + native ESM), so this module
// can be evaluated twice in one process. Install once, or the offsets compose.
if (globalThis.__proofClockArmed) {
  process.stdout.write(`PROOF preload clock already armed; duplicate install skipped pid=${process.pid}\n`);
} else {
  globalThis.__proofClockArmed = true;

  const realDateNow = Date.now.bind(Date);
  const stepFile = process.env.PROOF_CLOCK_STEP_FILE;
  const stepMs = Number(process.env.PROOF_STEP_MS ?? "60000");

  let offsetMs = 0;
  let stepped = false;

  function wallIso(ms) {
    return new Date(ms).toISOString();
  }

  function stepBack(ms) {
    const before = realDateNow();
    offsetMs -= ms;
    const after = realDateNow() + offsetMs;
    process.stdout.write(
      `PROOF clock step back ${ms}ms (Date.now only): wall ${wallIso(before)} -> ${wallIso(after)} performance.now=${performance.now().toFixed(0)}ms\n`,
    );
    return offsetMs;
  }

  globalThis.__proofWallClock = {
    stepBack,
    offsetMs: () => offsetMs,
    realNowMs: () => realDateNow(),
  };

  Date.now = () => realDateNow() + offsetMs;

  if (stepFile) {
    setInterval(() => {
      if (stepped || !fs.existsSync(stepFile)) {
        return;
      }
      stepped = true;
      stepBack(stepMs);
    }, 100).unref();
  }

  process.stdout.write(
    `PROOF preload clock armed pid=${process.pid} offsetMs=${offsetMs} stepFile=${stepFile ?? "-"} performance.now=${performance.now().toFixed(0)}ms\n`,
  );
}
