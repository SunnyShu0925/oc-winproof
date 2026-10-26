// PR #184162 real Windows production-owner proof.
//
// Runs the SHIPPED readWindowsProcessStartTimeSync against a REAL running
// child process on a Windows runner. Native identity is made unavailable
// (PROC_SAFE_NATIVE=off, the same helper-absent state sealed updater helpers
// run in) so the PowerShell and WMIC FALLBACK execute real subprocesses — the
// path this PR repairs. A wall-clock
// jump (NTP correction) is injected on Date.now ONLY, leaving the monotonic
// clock intact, to show:
//   - post-fix (performance.now deadline): forward/backward jumps do not affect
//     the fallback budget; PowerShell/WMIC acquire the real creation time.
//   - pre-fix (Date.now deadline): a forward jump after seeding makes the
//     remaining budget <= 0, so the fallback is skipped and the healthy probe
//     returns null prematurely; a backward jump inflates the budget beyond the
//     caller's timeout.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Shipped reader resolved from the openclaw checkout root (cwd on the runner).
const { readWindowsProcessStartTimeSync } = await import(
  pathToFileURL(join(process.cwd(), "src/infra/windows-process-start.js")).href
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) A real long-lived Windows child as the target PID.
const child =
  process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], { stdio: "ignore" })
    : spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
const pid = child.pid;
console.log(`[proof] target PID=${pid} platform=${process.platform} arch=${process.arch} node=${process.version}`);
await sleep(800); // let the child fully start so its StartTime is stable

// 2) Wall-clock jump injection. readWindowsProcessStartTimeSync seeds its
//    deadline on the FIRST clock read (call 1), then reads the remaining budget
//    on LATER reads (calls >= 2). We shift Date.now on calls >= 2 only, so the
//    deadline is seeded from the pre-jump wall clock — exactly an NTP
//    correction landing mid-query. The monotonic clock is untouched.
function run(label, dirMs) {
  const realDateNow = Date.now;
  let calls = 0;
  Date.now = () => {
    calls++;
    return realDateNow() + (calls > 1 ? dirMs : 0);
  };
  const t0 = performance.now();
  let outcome;
  try {
    const start = readWindowsProcessStartTimeSync(pid, 5000);
    outcome =
      start === null
        ? "NO_IDENTITY (fallback skipped/failed)"
        : `IDENTITY acquired startTime=${start}`;
  } catch (e) {
    outcome = `THREW ${e.code ?? ""} ${e.message}`;
  } finally {
    Date.now = realDateNow;
  }
  const elapsed = Math.round((performance.now() - t0) * 100) / 100;
  console.log(`[proof] ${label} Date.now shift=${dirMs >= 0 ? "+" : ""}${dirMs}ms monotonicElapsed=${elapsed}ms -> ${outcome}`);
}

console.log("=== POST-FIX (performance.now monotonic deadline + Math.ceil) ===");
run("control  ", 0);
run("forward  ", 10000);
run("backward ", -10000);

child.kill();
process.exit(0);
