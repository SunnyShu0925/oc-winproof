// ESM preload for the PR 183394 real-socket proof.
//
// Rewinds ONLY the process wall clock (`Date.now`) by PROOF_JUMP_MS when the
// trigger file appears. `performance.now()` and the real timers are untouched,
// which is exactly the wall-clock-vs-monotonic split the PR fixes. The same
// technique (Date.now preload on a shipped process) was accepted for #183002.
import fs from "node:fs";

const jumpMs = Number(process.env.PROOF_JUMP_MS ?? "60000");
const triggerPath = process.env.PROOF_JUMP_TRIGGER ?? "";
const startedAt = performance.now();
const realNow = Date.now.bind(Date);
let offset = 0;

Date.now = () => realNow() + offset;

if (triggerPath && jumpMs > 0) {
  const timer = setInterval(() => {
    if (offset !== 0 || !fs.existsSync(triggerPath)) {
      return;
    }
    offset = -jumpMs;
    console.log(
      `[clock-jump] Date.now rewound -${jumpMs}ms at mono=${Math.round(
        performance.now() - startedAt,
      )}ms (performance.now untouched)`,
    );
  }, 200);
  timer.unref?.();
}
