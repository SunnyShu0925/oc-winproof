// ESM preload (node --import): forward-jump Date.now by PROOF_JUMP_MS once the
// process has been alive for PROOF_JUMP_AT_MS. Mirrors an NTP correction that
// lands while the SQLite lease-read retry loop is already running.
//
// Pre-fix retryScheduledTaskLeaseRead seeds its deadline from Date.now() and
// re-checks it with Date.now(); the jump therefore exhausts the remaining
// budget. Post-fix uses performance.now(), so the jump is ignored.
import { isMainThread } from "node:worker_threads";

const JUMP_MS = Number(process.env.PROOF_JUMP_MS || 0);
const AT_MS = Number(process.env.PROOF_JUMP_AT_MS || 0);

if (JUMP_MS > 0) {
  const realNow = Date.now.bind(Date);
  const t0 = realNow();
  let offset = 0;
  let calls = 0;

  Date.now = () => {
    calls += 1;
    const v = realNow();
    if (offset === 0 && v - t0 >= AT_MS) {
      offset = JUMP_MS;
      console.log(
        `[clock-inject] Date.now forward-jumped +${JUMP_MS}ms at t~${v - t0}ms ` +
          `(Date.now calls=${calls}, pid=${process.pid}, thread=${isMainThread ? "main" : "worker"})`,
      );
    }
    return v + offset;
  };

  console.log(
    `[clock-inject] armed: forward-jump +${JUMP_MS}ms at t~${AT_MS}ms ` +
      `(pid=${process.pid}, thread=${isMainThread ? "main" : "worker"})`,
  );
}
