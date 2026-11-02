// Independent observer for the shell snapshot subprocesses.
//
// The snapshot validation shell lives only a few milliseconds and sources a file
// it cannot instrument, so this process scans /proc in a tight synchronous loop
// and records every matching pid with the cgroup it actually ran in. It is
// started directly by the proof (inheriting the Gateway cgroup) and never goes
// through the spawn path it measures.
//
// Usage: SAMPLER_OUT=... SAMPLER_READY=... SAMPLER_STOP=... node proof-cgroup-sampler.mjs

import fs from "node:fs";

const out = process.env.SAMPLER_OUT;
const ready = process.env.SAMPLER_READY;
const stop = process.env.SAMPLER_STOP;

if (!out || !ready || !stop) {
  console.error("SAMPLER_OUT, SAMPLER_READY and SAMPLER_STOP are required");
  process.exit(2);
}

// Everything the snapshot path spawns mentions one of these:
//   shell-snapshots  -> validation (.tmp) and exec (.sh) shells
//   snapshot.out     -> the interactive capture shell
//   PROOF_CONTROL    -> the Gateway-internal control
//   PROOF_EXEC       -> the exec shell the Gateway runs for the requested command
const MATCH = /shell-snapshots\/|snapshot\.out|PROOF_CONTROL|PROOF_EXEC_/;
const MAX_MISSES = 1_000_000;

fs.writeFileSync(out, "");
fs.writeFileSync(ready, "1");

const seen = new Set();
const pending = new Map();
const started = Date.now();
const deadline = started + 180_000;
let passes = 0;
let recorded = 0;

while (Date.now() < deadline) {
  passes += 1;
  if ((passes & 31) === 0 && fs.existsSync(stop)) break;

  let names = [];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    continue;
  }

  for (const name of names) {
    const pid = Number(name);
    if (!pid || seen.has(pid)) continue;

    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    } catch {
      continue;
    }

    // A just-forked child can still have an empty cmdline. Leaving the pid
    // unsettled means the next pass reads it again instead of dropping it.
    // Kernel threads never get a cmdline, so they age out after MAX_MISSES.
    if (!cmd) {
      const misses = (pending.get(pid) ?? 0) + 1;
      if (misses < MAX_MISSES) {
        pending.set(pid, misses);
        continue;
      }
    }
    pending.delete(pid);
    seen.add(pid);
    if (!MATCH.test(cmd)) continue;

    let cg = null;
    try {
      const match = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").match(/^0::(.+)$/m);
      cg = match ? match[1].trim() : null;
    } catch {
      cg = null;
    }
    fs.appendFileSync(
      out,
      `${JSON.stringify({ pid, cg, cmd: cmd.slice(0, 400), atMs: Date.now() - started })}\n`,
    );
    recorded += 1;
  }
}

fs.writeFileSync(
  `${out}.stats`,
  JSON.stringify({ passes, scanned: seen.size, recorded, elapsedMs: Date.now() - started }),
);
fs.writeFileSync(`${stop}.done`, "1");
