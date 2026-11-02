// Independent observer for the shell snapshot subprocesses.
//
// The snapshot validation shell lives only a few milliseconds and sources a file
// it cannot instrument, so this process scans /proc in a tight synchronous loop
// and records every matching pid with the cgroup it actually ran in. It is
// started directly by the proof (inheriting the Gateway cgroup) and never goes
// through the spawn path it measures.
//
// A pid is recorded once and then followed: a shell that moves itself into the
// agent exec cgroup before it execs keeps its pid, so the first and last
// observation together show whether that move happened.
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
//   cgroup.procs     -> a launcher that moves itself into the agent exec cgroup
//   PROOF_CONTROL    -> the Gateway-internal control
//   PROOF_EXEC       -> the exec shell the Gateway runs for the requested command
const MATCH =
  /shell-snapshots\/|__OPENCLAW_SHELL_SNAPSHOT_CAPTURE__|cgroup\.procs|PROOF_CONTROL|PROOF_EXEC_|spawn-broker/;
const CMD_CHARS = 2_000;
// Walking the Gateway's own child list is far cheaper than re-reading every
// /proc entry, so short-lived shells are caught within their first millisecond.
const ROOTS = (process.env.SAMPLER_ROOTS ?? "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

if (ROOTS.length === 0) {
  console.error("SAMPLER_ROOTS is required");
  process.exit(2);
}

fs.writeFileSync(out, "");
fs.writeFileSync(ready, "1");

/** One record per pid; `last*` follows the process through its self-move and exec. */
const tracked = new Map();
const started = Date.now();
const deadline = started + 180_000;
let passes = 0;
let traversed = 0;

function readField(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readCgroup(pid) {
  const raw = readField(`/proc/${pid}/cgroup`);
  const match = raw?.match(/^0::(.+)$/mu);
  return match ? match[1].trim() : null;
}

function readCmdline(pid) {
  const raw = readField(`/proc/${pid}/cmdline`);
  return raw === undefined ? undefined : raw.split("\0").join(" ").trim();
}

function readPpid(pid) {
  const raw = readField(`/proc/${pid}/status`);
  const value = raw === undefined ? undefined : /^PPid:\s+(\d+)$/mu.exec(raw)?.[1];
  return value === undefined ? null : Number(value);
}

function readStartTime(pid) {
  const raw = readField(`/proc/${pid}/stat`);
  if (raw === undefined) {
    return undefined;
  }
  // Field 22 of /proc/<pid>/stat; the command name may contain spaces and ")".
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return fields[19];
}

function childPids(pid) {
  const children = [];
  let tids = [];
  try {
    tids = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  // Any thread can be the forking parent, so every task file is read.
  for (const tid of tids) {
    const raw = readField(`/proc/${pid}/task/${tid}/children`);
    if (!raw) continue;
    for (const token of raw.split(/\s+/u)) {
      const child = Number(token);
      if (Number.isInteger(child) && child > 0) children.push(child);
    }
  }
  return children;
}

/** Record a pid on first sight and follow it afterwards; returns its children. */
function observe(pid) {
  const atMs = Date.now() - started;
  const existing = tracked.get(pid);
  if (existing) {
    if (readStartTime(pid) !== existing.startTime) {
      // The pid was reused; the old process is gone and stays as recorded.
      tracked.delete(pid);
      return [];
    }
    const cg = readCgroup(pid);
    if (cg !== null && cg !== existing.lastCg) {
      existing.lastCg = cg;
      existing.lastAtMs = atMs;
    }
    const cmd = readCmdline(pid);
    if (cmd && cmd !== existing.lastCmd) {
      existing.lastCmd = cmd.slice(0, CMD_CHARS);
      existing.lastAtMs = atMs;
    }
    return childPids(pid);
  }

  const children = childPids(pid);
  const cmd = readCmdline(pid);
  if (!cmd || !MATCH.test(cmd)) {
    // A just-forked child can still have an empty cmdline; the next pass reads
    // it again because traversal restarts from the roots every time.
    return children;
  }
  const cg = readCgroup(pid);
  tracked.set(pid, {
    pid,
    ppid: readPpid(pid),
    startTime: readStartTime(pid),
    firstCg: cg,
    firstCmd: cmd.slice(0, CMD_CHARS),
    firstAtMs: atMs,
    lastCg: cg,
    lastCmd: cmd.slice(0, CMD_CHARS),
    lastAtMs: atMs,
  });
  return children;
}

while (Date.now() < deadline) {
  passes += 1;
  if ((passes & 31) === 0 && fs.existsSync(stop)) break;

  const queue = [...ROOTS];
  const seen = new Set(ROOTS);
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid) continue;
    traversed += 1;
    for (const child of observe(pid)) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
}

const records = [...tracked.values()].sort((left, right) => left.firstAtMs - right.firstAtMs);
for (const { startTime: _startTime, ...record } of records) {
  fs.appendFileSync(out, `${JSON.stringify(record)}\n`);
}

fs.writeFileSync(
  `${out}.stats`,
  JSON.stringify({
    passes,
    roots: ROOTS,
    traversed,
    recorded: records.length,
    elapsedMs: Date.now() - started,
  }),
);
fs.writeFileSync(`${stop}.done`, "1");
