// Real-behavior proof for PR 190359.
//
// Drives the shipped host-exec preparation path (prepareHostExecSpawn, which owns
// the snapshot capture and validation shells) and the shipped agent exec spawn
// owner (spawnProcess with executionIntent "agent-tool") inside a delegated
// systemd unit, then checks which cgroup each shell actually landed in.
//
// Placement comes from the shells themselves where they can report it:
//   * ~/.bashrc runs inside the interactive capture shell and records its own
//     /proc/self/cgroup plus its cmdline.
//   * the exec command and the Gateway-internal control record their own
//     /proc/<pid>/cgroup from inside the spawned shell.
//   * the snapshot validation shell sources a file it cannot instrument and
//     exits in a few milliseconds, so a dedicated sampler process reads every
//     cgroup member in a tight synchronous loop and records each new pid with
//     its cgroup and cmdline.
//
// Checks:
//   1. Gateway leaf membership before and after the run
//   2. capture shell reported agent-exec
//   3. validation shell observed in agent-exec
//   4. exec shell reported agent-exec
//   5. the snapshot was captured and published with the marker function
//   6. the exec shell actually sourced it (marker defined only in ~/.bashrc)
//   7. every exec round exited 0
//   8. a Gateway-internal control child through the same broker reported gateway

import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/tmp/oc-proof-state";
const PROOF_LOG = process.env.PROOF_LOG || "";
const HOME = process.env.HOME || "/tmp/oc-proof-home";
const CAPTURE_OBS_PATH = "/tmp/proof-capture-obs.txt";
const SAMPLER_SCRIPT = "/tmp/proof-cgroup-sampler.mjs";
const SAMPLER_READY = "/tmp/proof-sampler-ready";
const SAMPLER_STOP = "/tmp/proof-sampler-stop";
const SAMPLER_OUT = "/tmp/proof-sampler.jsonl";

const SAMPLER_SOURCE = `
import fs from "node:fs";
const dirs = process.env.SAMPLER_DIRS.split(",").filter(Boolean);
const out = process.env.SAMPLER_OUT;
const ready = process.env.SAMPLER_READY;
const stop = process.env.SAMPLER_STOP;
fs.writeFileSync(out, "");
fs.writeFileSync(ready, "1");
const seen = new Set();
const deadline = Date.now() + 180000;
let passes = 0;
let recorded = 0;
const started = Date.now();
while (Date.now() < deadline) {
  passes += 1;
  if ((passes & 31) === 0 && fs.existsSync(stop)) break;
  for (const dir of dirs) {
    let raw = "";
    try {
      raw = fs.readFileSync(dir + "/cgroup.procs", "utf8");
    } catch {
      continue;
    }
    let index = 0;
    while (index < raw.length) {
      let end = raw.indexOf("\\n", index);
      if (end === -1) end = raw.length;
      const pid = Number(raw.slice(index, end));
      index = end + 1;
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      let cmd = "";
      try {
        cmd = fs
          .readFileSync("/proc/" + pid + "/cmdline", "utf8")
          .replace(/\\0+$/, "")
          .split("\\0")
          .join(" ")
          .replace(/\\r?\\n/g, "\\\\n")
          .trim();
      } catch {
        cmd = "";
      }
      let cg = null;
      try {
        const match = fs.readFileSync("/proc/" + pid + "/cgroup", "utf8").match(/^0::(.+)$/m);
        cg = match ? match[1].trim() : null;
      } catch {
        cg = null;
      }
      fs.appendFileSync(out, JSON.stringify({ pid, cg, cmd: cmd.slice(0, 400) }) + "\\n");
      recorded += 1;
    }
  }
}
fs.writeFileSync(out + ".stats", JSON.stringify({ passes, recorded, elapsedMs: Date.now() - started }));
fs.writeFileSync(stop + ".done", "1");
`;

const lines = [];
function log(message) {
  lines.push(message);
  console.log(message);
}
function finish(code) {
  if (PROOF_LOG) {
    try {
      fs.mkdirSync(path.dirname(PROOF_LOG), { recursive: true });
      fs.writeFileSync(PROOF_LOG, lines.join("\n") + "\n");
    } catch {
      // stdout remains the primary channel
    }
  }
  process.exit(code);
}

function readKernelCgroup(pid) {
  try {
    const match = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").match(/^0::(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function shortCgroup(cg) {
  if (!cg) return "(gone)";
  const marker = "app.slice/";
  const at = cg.indexOf(marker);
  return at === -1 ? cg : cg.slice(at + marker.length);
}

const isGatewayLeaf = (cg) => Boolean(cg && /\/gateway$/.test(cg));
const isAgentExecLeaf = (cg) => Boolean(cg && /\/agent-exec$/.test(cg));

// `sed -n s/^0:://p` prints only the cgroup v2 line, and needs no quoting inside
// the single-quoted eval that the snapshot wrapper builds.
const SELF_CGROUP_CMD = "sed -n s/^0:://p /proc/$$/cgroup";

// Runs inside the interactive capture shell; records the shell's own placement.
const CAPTURE_NOTE = [
  "__proof_note() {",
  `  printf '%s|%s|%s\\n' "$$" "$(sed -n s/^0:://p /proc/$$/cgroup)" "$(tr '\\0\\n' '  ' < /proc/$$/cmdline | cut -c1-300)" >> ${CAPTURE_OBS_PATH}`,
  "}",
  "__proof_note",
].join("\n");

function readCaptureObservations() {
  const entries = [];
  let raw = "";
  try {
    raw = fs.readFileSync(CAPTURE_OBS_PATH, "utf8");
  } catch {
    return entries;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("|");
    if (parts.length < 3) continue;
    entries.push({ pid: Number(parts[0]), cgroup: parts[1] || null, cmd: parts.slice(2).join("|") });
  }
  return entries;
}

function readSelfCgroupFile(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function readSamplerRows() {
  let raw = "";
  try {
    raw = fs.readFileSync(SAMPLER_OUT, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore a partially written final line
    }
  }
  return rows;
}

async function main() {
  process.env.SHELL = "/bin/bash";
  process.env.OPENCLAW_STATE_DIR = STATE_DIR;
  process.env.HOME = HOME;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.rmSync(CAPTURE_OBS_PATH, { force: true });
  fs.rmSync(SAMPLER_READY, { force: true });
  fs.rmSync(SAMPLER_STOP, { force: true });
  fs.rmSync(`${SAMPLER_STOP}.done`, { force: true });

  // Only an interactive capture shell reads this. The marker function exists
  // nowhere else, so printing it proves the published snapshot was sourced.
  // The alias block is a realistic heavy startup file: it makes the snapshot big
  // enough that the short-lived validation shell stays observable. Placement does
  // not depend on snapshot size.
  const ALIAS_COUNT = 3000;
  const aliasLines = Array.from(
    { length: ALIAS_COUNT },
    (_, index) => `alias proof_alias_${index}='ls -l'`,
  );
  fs.writeFileSync(
    path.join(HOME, ".bashrc"),
    [
      CAPTURE_NOTE,
      "proof_snapshot_marker() { printf 'SNAPSHOT-WAS-SOURCED\\n'; }",
      ...aliasLines,
      "sleep 0.4",
      "",
    ].join("\n"),
  );
  log(`PROOF bashrc aliases: ${ALIAS_COUNT}`);

  const { spawnProcess } = await import("../../src/process/spawn-utils.js");
  const cgroupMod = await import("../../src/process/linux-exec-cgroup.js");
  const startupMod = await import("../../src/process/linux-exec-cgroup-startup.js");
  const brokerMod = await import("../../src/process/spawn-broker/context.js");
  const { prepareHostExecSpawn } = await import("../../src/agents/bash-tools.exec-host-spawn.js");

  const selfPid = process.pid;
  const selfBefore = readKernelCgroup(selfPid);
  log(`PROOF self cgroup (before): ${selfBefore}`);
  log(`PROOF self in gateway leaf (before): ${isGatewayLeaf(selfBefore)}`);

  let initMessage = "";
  try {
    initMessage = await startupMod.initializeGatewayExecCgroup(STATE_DIR);
  } catch (error) {
    initMessage = `threw: ${error?.message ?? error}`;
  }
  log(`PROOF initializeGatewayExecCgroup: ${initMessage}`);
  const agentExecDir = cgroupMod.getAgentExecCgroup();
  log(`PROOF getAgentExecCgroup: ${agentExecDir ?? "(undefined)"}`);
  const serviceRoot = agentExecDir ? path.dirname(agentExecDir) : null;
  log(`PROOF service cgroup root: ${serviceRoot ?? "(none)"}`);

  // The sampler is the only observer for the validation shell, which cannot
  // report itself. It runs as its own process in the Gateway cgroup with a tight
  // synchronous loop so the main flow cannot starve it.
  let sampler = null;
  if (serviceRoot) {
    fs.writeFileSync(SAMPLER_SCRIPT, SAMPLER_SOURCE);
    sampler = spawnProcess(
      process.execPath,
      [SAMPLER_SCRIPT],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          SAMPLER_DIRS: [agentExecDir, path.join(serviceRoot, "gateway"), serviceRoot].join(","),
          SAMPLER_OUT,
          SAMPLER_READY,
          SAMPLER_STOP,
        },
      },
      undefined,
      "gateway-internal",
    );
    const waitUntil = Date.now() + 15_000;
    while (!fs.existsSync(SAMPLER_READY) && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    log(`PROOF sampler ready: ${fs.existsSync(SAMPLER_READY)}`);
  }

  let broker = null;
  if (agentExecDir) {
    broker = await brokerMod.startGatewaySpawnBroker({
      onReady: (pid) => log(`PROOF broker ready pid=${pid}`),
      onStartupFailure: (message) => log(`PROOF broker startup failure: ${message}`),
    });
  }

  const markerPaths = [];
  const execCgroupPaths = [];
  const roundExitCodes = [];
  const controlCgroupPath = "/tmp/proof-control-cgroup.txt";
  let wrappedArgv = [];

  async function round() {
    // Distinct workdirs produce distinct snapshot keys, so each round re-runs the
    // real capture and validation shells instead of reusing a cached snapshot.
    for (const index of [1, 2, 3]) {
      const workdir = `/tmp/proof-shell-snapshot-wd-${index}`;
      fs.mkdirSync(workdir, { recursive: true });
      const markerPath = `/tmp/proof-exec-marker-${index}.txt`;
      const execCgroupPath = `/tmp/proof-exec-cgroup-${index}.txt`;
      markerPaths.push(markerPath);
      execCgroupPaths.push(execCgroupPath);
      fs.rmSync(markerPath, { force: true });
      fs.rmSync(execCgroupPath, { force: true });
      const spawnSpec = await prepareHostExecSpawn({
        command: `proof_snapshot_marker > ${markerPath}; ${SELF_CGROUP_CMD} > ${execCgroupPath}`,
        workdir,
        env: { ...process.env },
        usePty: false,
      });
      wrappedArgv = spawnSpec.argv;
      const child = spawnProcess(
        spawnSpec.argv[0],
        spawnSpec.argv.slice(1),
        {
          cwd: spawnSpec.cwd,
          env: spawnSpec.env,
          stdio: ["ignore", "ignore", "ignore"],
        },
        undefined,
        "agent-tool",
      );
      const [code] = await once(child, "close");
      roundExitCodes.push(code);
    }

    // Gateway-internal control: same broker, no agent intent.
    fs.rmSync(controlCgroupPath, { force: true });
    const control = spawnProcess(
      "/bin/bash",
      ["-c", `${SELF_CGROUP_CMD} > ${controlCgroupPath}; sleep 0.2`],
      { stdio: "ignore", env: { ...process.env } },
      undefined,
      "gateway-internal",
    );
    await once(control, "close");
  }

  try {
    if (broker) {
      await brokerMod.runWithSpawnBroker(broker, round);
    } else {
      await round();
    }
  } catch (error) {
    log(`PROOF ERROR during run: ${error?.stack ?? error}`);
    finish(2);
  }

  if (sampler) {
    fs.writeFileSync(SAMPLER_STOP, "1");
    const waitUntil = Date.now() + 20_000;
    while (!fs.existsSync(`${SAMPLER_STOP}.done`) && Date.now() < waitUntil) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await once(sampler, "close").catch(() => undefined);
  }
  try {
    await broker?.close?.();
  } catch {
    // ignore
  }

  const selfAfter = readKernelCgroup(selfPid);
  log(`PROOF self cgroup (after): ${selfAfter}`);
  log(`PROOF self remained in gateway leaf: ${isGatewayLeaf(selfAfter)}`);

  const captureNotes = readCaptureObservations();
  for (const note of captureNotes) {
    log(`PROOF capture pid=${note.pid} cgroup=${shortCgroup(note.cgroup)} cmd=${note.cmd}`);
  }

  const rows = readSamplerRows();
  const validationRows = rows.filter((row) =>
    /shell-snapshots\/[0-9a-f]+\.\d+\.\d+\.tmp/.test(row.cmd),
  );
  for (const row of validationRows) {
    log(`PROOF validation pid=${row.pid} cgroup=${shortCgroup(row.cg)} cmd=${row.cmd}`);
  }
  log(`PROOF sampled pids: ${rows.length}`);
  for (const row of rows) {
    log(`PROOF sample pid=${row.pid} cgroup=${shortCgroup(row.cg)} cmd=${row.cmd.slice(0, 200)}`);
  }

  const execPlacements = execCgroupPaths.map((file, index) => ({
    index: index + 1,
    cgroup: readSelfCgroupFile(file),
  }));
  for (const placement of execPlacements) {
    log(`PROOF exec round=${placement.index} cgroup=${shortCgroup(placement.cgroup)}`);
  }
  const controlCgroup = readSelfCgroupFile(controlCgroupPath);
  log(`PROOF gateway-control cgroup=${shortCgroup(controlCgroup)}`);

  log(`PROOF capture shell pids: ${captureNotes.map((e) => e.pid).join(",") || "(none)"}`);
  log(`PROOF validation shell pids: ${validationRows.map((e) => e.pid).join(",") || "(none)"}`);
  log(`PROOF exec self-reports: ${execPlacements.filter((e) => e.cgroup).length}/${execPlacements.length}`);

  const snapshotDir = path.join(STATE_DIR, "cache", "shell-snapshots");
  let snapshotFiles = [];
  try {
    snapshotFiles = fs
      .readdirSync(snapshotDir)
      .filter((name) => name.endsWith(".sh"))
      .map((name) => path.join(snapshotDir, name));
  } catch {
    // ignore
  }
  const snapshotWithMarker = snapshotFiles.some((file) => {
    try {
      return fs.readFileSync(file, "utf8").includes("proof_snapshot_marker");
    } catch {
      return false;
    }
  });
  log(`PROOF published snapshot count: ${snapshotFiles.length}`);
  log(`PROOF snapshot captures marker function: ${snapshotWithMarker}`);

  const markerOutputs = markerPaths.map((file) => {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  });
  const markersPrinted = markerOutputs.filter((value) => value.includes("SNAPSHOT-WAS-SOURCED"));
  const wrappedUsesSnapshot = wrappedArgv.some((arg) => arg.includes("shell-snapshots"));
  log(`PROOF exec exit codes: ${roundExitCodes.join(",")}`);
  log(`PROOF wrapped argv sources snapshot: ${wrappedUsesSnapshot}`);
  log(`PROOF marker file outputs: ${JSON.stringify(markerOutputs)}`);
  log(`PROOF snapshot was used (marker printed): ${markersPrinted.length === markerOutputs.length}`);

  const checks = [
    ["self in gateway before", isGatewayLeaf(selfBefore)],
    ["agent-exec cgroup available", Boolean(agentExecDir)],
    ["capture shell reported agent-exec", captureNotes.some((e) => isAgentExecLeaf(e.cgroup))],
    ["validation shell observed in agent-exec", validationRows.some((e) => isAgentExecLeaf(e.cg))],
    ["exec shell reported agent-exec", execPlacements.some((e) => isAgentExecLeaf(e.cgroup))],
    ["snapshot published with marker function", snapshotWithMarker],
    ["wrapped command sources snapshot", wrappedUsesSnapshot],
    [
      "snapshot used: marker printed by every round",
      markerOutputs.length > 0 && markersPrinted.length === markerOutputs.length,
    ],
    ["exec rounds exited 0", roundExitCodes.length > 0 && roundExitCodes.every((c) => c === 0)],
    ["gateway-internal control reported gateway", isGatewayLeaf(controlCgroup)],
    ["self remained in gateway after", isGatewayLeaf(selfAfter)],
  ];
  for (const [name, ok] of checks) {
    log(`PROOF check ${ok ? "PASS" : "FAIL"}: ${name}`);
  }
  const failed = checks.filter(([, ok]) => !ok);
  log(`PROOF VERDICT: ${failed.length === 0 ? "PASS" : "FAIL"}`);
  finish(failed.length === 0 ? 0 : 1);
}

await main();
