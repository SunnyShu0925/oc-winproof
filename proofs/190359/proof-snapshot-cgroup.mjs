// Real-behavior proof for PR 190359.
//
// Drives the shipped host-exec preparation path (prepareHostExecSpawn, which owns
// the snapshot capture and validation shells) and the shipped agent exec spawn
// owner (spawnProcess with executionIntent "agent-tool") inside a delegated
// systemd unit, then checks which cgroup each shell actually landed in.
//
// Placement is reported by the shells themselves wherever possible, because the
// exec and validation shells live only 1-3ms:
//   * ~/.bashrc runs inside the interactive capture shell and records its own
//     /proc/self/cgroup.
//   * the exec command and the Gateway-internal control record their own
//     /proc/<pid>/cgroup from inside the spawned shell.
//   * only the snapshot validation shell cannot report itself (its environment is
//     the filtered capture env and it exits immediately), so a tight polling loop
//     reads the agent-exec leaf and samples its cmdline.
//
// Checks:
//   1. Gateway leaf membership before and after the run
//   2. capture shell reported agent-exec
//   3. validation shell reported agent-exec
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
const isGatewayLeaf = (cg) => Boolean(cg && /\/gateway$/.test(cg));
const isAgentExecLeaf = (cg) => Boolean(cg && /\/agent-exec$/.test(cg));

// `sed -n s/^0:://p` returns the v2 leaf from /proc/<pid>/cgroup without quoting
// problems inside the single-quoted eval the snapshot wrapper builds.
const SELF_CGROUP_CMD = "sed -n s/^0:://p /proc/$$/cgroup";

// Runs inside the interactive capture shell; records the shell's own placement.
const CAPTURE_NOTE = [
  "__proof_note() {",
  `  printf '%s|%s|%s|%s\\n' "$$" "$(sed -n s/^0:://p /proc/$$/cgroup)" "$(tr '\\0\\n' '  ' < /proc/$$/cmdline | cut -c1-300)" "capture" >> ${CAPTURE_OBS_PATH}`,
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
    if (parts.length < 4) continue;
    entries.push({ pid: Number(parts[0]), cgroup: parts[1] || null, cmd: parts[2], kind: parts[3] });
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

async function main() {
  process.env.SHELL = "/bin/bash";
  process.env.OPENCLAW_STATE_DIR = STATE_DIR;
  process.env.HOME = HOME;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.rmSync(CAPTURE_OBS_PATH, { force: true });

  // Only an interactive capture shell reads this. The marker function exists
  // nowhere else, so printing it proves the published snapshot was sourced.
  fs.writeFileSync(
    path.join(HOME, ".bashrc"),
    [
      CAPTURE_NOTE,
      "proof_snapshot_marker() { printf 'SNAPSHOT-WAS-SOURCED\\n'; }",
      "sleep 0.4",
      "",
    ].join("\n"),
  );

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
  log(`PROOF service cgroup root: ${agentExecDir ? path.dirname(agentExecDir) : "(none)"}`);

  let broker = null;
  if (agentExecDir) {
    broker = await brokerMod.startGatewaySpawnBroker({
      onReady: (pid) => log(`PROOF broker ready pid=${pid}`),
      onStartupFailure: (message) => log(`PROOF broker startup failure: ${message}`),
    });
  }

  // Only the validation shell needs sampling: one small file read per iteration
  // keeps the sampling interval well below its 1-3ms lifetime.
  const samples = new Map();
  let sampling = Boolean(agentExecDir);
  const samplingDone = (async () => {
    while (sampling) {
      let raw = "";
      try {
        raw = fs.readFileSync(path.join(agentExecDir, "cgroup.procs"), "utf8");
      } catch {
        raw = "";
      }
      for (const line of raw.split("\n")) {
        const pid = Number(line.trim());
        if (!pid || samples.has(pid)) continue;
        let cmd = "";
        try {
          cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
        } catch {
          cmd = "";
        }
        samples.set(pid, { pid, cmd, cgroup: readKernelCgroup(pid) });
      }
      for (const entry of samples.values()) {
        if (entry.cmd) continue;
        // Late cmdline read for a pid first seen mid-spawn.
        try {
          const cmd = fs
            .readFileSync(`/proc/${entry.pid}/cmdline`, "utf8")
            .replace(/\0+/g, " ")
            .trim();
          if (cmd) entry.cmd = cmd;
        } catch {
          // still gone
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();

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
    sampling = false;
    await samplingDone;
    log(`PROOF ERROR during run: ${error?.stack ?? error}`);
    finish(2);
  }

  sampling = false;
  await samplingDone;
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
    log(
      `PROOF observed capture pid=${note.pid} cgroup=${note.cgroup ?? "(unreadable)"} cmd=${note.cmd}`,
    );
  }

  const validationSamples = [...samples.values()].filter((entry) =>
    /shell-snapshots\/[0-9a-f]+\.\d+\.\d+\.tmp/.test(entry.cmd),
  );
  for (const sample of validationSamples) {
    log(
      `PROOF observed validation pid=${sample.pid} cgroup=${sample.cgroup ?? "(unreadable)"} cmd=${sample.cmd}`,
    );
  }
  log(`PROOF sampled agent-exec pids: ${samples.size}`);

  const execPlacements = execCgroupPaths.map((file, index) => ({
    index: index + 1,
    cgroup: readSelfCgroupFile(file),
  }));
  for (const placement of execPlacements) {
    log(
      `PROOF observed exec round=${placement.index} cgroup=${placement.cgroup ?? "(no self-report)"}`,
    );
  }
  const controlCgroup = readSelfCgroupFile(controlCgroupPath);
  log(`PROOF observed gateway-control cgroup=${controlCgroup ?? "(no self-report)"}`);

  log(`PROOF capture shell pids: ${captureNotes.map((e) => e.pid).join(",") || "(none)"}`);
  log(`PROOF validation shell pids: ${validationSamples.map((e) => e.pid).join(",") || "(none)"}`);
  log(
    `PROOF exec self-reports: ${execPlacements.filter((e) => e.cgroup).length}/${execPlacements.length}`,
  );

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
    [
      "validation shell reported agent-exec",
      validationSamples.some((e) => isAgentExecLeaf(e.cgroup)),
    ],
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
