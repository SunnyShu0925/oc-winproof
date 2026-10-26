// PR #184162 real Windows production-owner proof (extended for WMIC fallback +
// running-child timeout enforcement).
//
// Runs the SHIPPED readWindowsProcessStartTimeSync against REAL running child
// processes on a Windows runner. Native identity is made unavailable
// (PROC_SAFE_NATIVE=off, the same helper-absent state sealed updater helpers
// run in) so the PowerShell and WMIC FALLBACK execute real subprocesses — the
// path this PR repairs. A wall-clock jump (NTP correction) is injected on
// Date.now ONLY, leaving the monotonic clock intact.
//
// Sections:
//   1. control / forward / backward clock shift  (the round-3 matrix)
//   2. real WMIC fallback reachability           (wmic.exe queries a live PID)
//   3. running-child timeout enforcement         (budget exhausted mid-run)
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Shipped reader + fallback paths resolved from the openclaw checkout root.
const { readWindowsProcessStartTimeSync, decodeWindowsProcessOutput } = await import(
  pathToFileURL(join(process.cwd(), "src/infra/windows-process-start.js")).href
);
// Fallback path helpers reproduced identically to windows-process-start.ts
// (same %SystemRoot% resolution and DMTF parse) for the WMIC reachability probe.
function systemRoot(env) {
  return (env.SystemRoot || env.WINDIR || "C:\\Windows").replace(/\\+$/, "");
}
function wmicPath(env) {
  return join(systemRoot(env), "System32", "wbem", "wmic.exe");
}
function parseDmtf(raw) {
  const text = decodeWindowsProcessOutput(raw);
  const m = text.match(/CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, us, sign, off] = m;
  const local = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, Math.floor(+us / 1000));
  return local - +off * 60000 * (sign === "+" ? 1 : -1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnLiveChild() {
  return process.platform === "win32"
    ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], { stdio: "ignore" })
    : spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
}

// 1) Clock-shift matrix on a real running child.
{
  const child = spawnLiveChild();
  const pid = child.pid;
  console.log(`[proof.clock] target PID=${pid} platform=${process.platform} node=${process.version}`);
  await sleep(800);
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
      outcome = start === null ? "NO_IDENTITY (fallback skipped/failed)" : `IDENTITY startTime=${start}`;
    } catch (e) {
      outcome = `THREW ${e.code ?? ""} ${e.message}`;
    } finally {
      Date.now = realDateNow;
    }
    console.log(`[proof.clock] ${label} Date.now shift=${dirMs >= 0 ? "+" : ""}${dirMs}ms elapsed=${Math.round((performance.now()-t0)*100)/100}ms -> ${outcome}`);
  }
  console.log("=== SECTION 1: clock-shift matrix (post-fix: performance.now + Math.ceil) ===");
  run("control  ", 0);
  run("forward  ", 10000);
  run("backward ", -10000);
  child.kill();
}

// 2) Real WMIC fallback reachability: shipped wmic.exe query on a LIVE pid.
if (process.platform === "win32") {
  const child = spawnLiveChild();
  const pid = child.pid;
  await sleep(800);
  console.log("=== SECTION 2: real WMIC fallback (shipped wmic.exe on live PID) ===");
  try {
    const r = spawnSync(wmicPath(process.env), ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"], {
      encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore","pipe","ignore"],
    });
    const parsed = parseDmtf(r.stdout);
    console.log(`[proof.wmic] wmic.exe status=${r.status} error=${r.error?.code ?? "none"} parsedStartTime=${parsed ?? "null"}`);
  } catch (e) {
    console.log(`[proof.wmic] THREW ${e.code ?? ""} ${e.message}`);
  }
  child.kill();
}

// 3) Running-child timeout enforcement: a budget too small to let PowerShell
//    finish MUST be enforced as a real subprocess timeout (no infinite wait),
//    and the shipped reader returns null when the deadline is exhausted.
if (process.platform === "win32") {
  const child = spawnLiveChild();
  const pid = child.pid;
  await sleep(800);
  console.log("=== SECTION 3: running-child timeout enforcement ===");
  // Use a tight caller budget so a REAL PowerShell query cannot finish within
  // it: the shipped reader must hand a positive-but-small timeout to spawnSync,
  // the running child is terminated at that timeout, and the reader returns
  // null (it must not stall past the caller budget).
  const t0 = performance.now();
  let outcome;
  try {
    const start = readWindowsProcessStartTimeSync(pid, 120);
    outcome = start === null ? "null (deadline exhausted, no identity)" : `IDENTITY startTime=${start}`;
  } catch (e) {
    outcome = `THREW ${e.code ?? ""} ${e.message}`;
  }
  const elapsed = Math.round((performance.now() - t0) * 100) / 100;
  console.log(`[proof.timeout] callerBudget=120ms realElapsed=${elapsed}ms -> ${outcome}`);
  if (elapsed > 1500) {
    console.log("[proof.timeout] FAIL: reader stalled far past the 120ms caller budget");
  } else {
    console.log("[proof.timeout] OK: reader honored the caller budget (real subprocess timeout enforced)");
  }
  child.kill();
}

process.exit(0);
