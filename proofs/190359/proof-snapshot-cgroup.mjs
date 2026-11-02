// Real-behavior proof for PR 190359.
//
// Drives the shipped host-exec preparation path (prepareHostExecSpawn, which owns
// the snapshot capture and validation shells) and the shipped agent exec spawn
// owner (spawnProcess with executionIntent "agent-tool") inside a delegated
// systemd unit, then reads kernel cgroup membership for the specific capture,
// validation and exec shell PIDs.
//
// Sampling runs in a separate tight-loop process: the shells under test live in
// other processes, so a timer-driven sampler in this process misses the
// short-lived validation shell.
//
// Checks:
//   1. Gateway leaf membership before and after the run
//   2. capture shell PID in agent-exec
//   3. validation shell PID in agent-exec
//   4. exec shell PID in agent-exec
//   5. the snapshot was captured, validated and actually sourced (marker function
//      defined only in ~/.bashrc becomes callable in the exec shell)
//   6. a Gateway-internal control child through the same broker stays in gateway

import { once } from "node:events";
import fs from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/tmp/oc-proof-state";
const PROOF_LOG = process.env.PROOF_LOG || "";
const HOME = process.env.HOME || "/tmp/oc-proof-home";
const GATEWAY_CONTROL_CMD = "sleep 0.8 # PROOF_GATEWAY_CONTROL";
const SAMPLER_LOG = path.join("/tmp", `proof-cgroup-sampler-${process.pid}.jsonl`);

// Tight-loop sampler. Runs as its own process so sampling continues while this
// process awaits snapshot creation and child spawns.
const SAMPLER_SOURCE = `
const fs = require("node:fs");
const args = process.argv.slice(1);
const out = args.pop();
const stop = out + ".stop";
const dirs = args;
const seen = new Set();
fs.writeFileSync(out, "");
while (!fs.existsSync(stop)) {
  for (const dir of dirs) {
    let raw;
    try {
      raw = fs.readFileSync(dir + "/cgroup.procs", "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\\n")) {
      const pid = Number(line.trim());
      if (!pid || seen.has(pid)) continue;
      seen.add(pid);
      let cg = null;
      let cmd = "";
      try {
        const match = fs.readFileSync("/proc/" + pid + "/cgroup", "utf8").match(/^0::(.+)$/m);
        cg = match ? match[1].trim() : null;
      } catch {}
      try {
        cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\\0+/g, " ").trim();
      } catch {}
      try {
        fs.appendFileSync(out, JSON.stringify({ pid, cg, cmd: cmd.slice(0, 4000) }) + "\\n");
      } catch {}
    }
  }
}
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

function cgroupV2Path(pid) {
  try {
    const match = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").match(/^0::(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}
const isGatewayLeaf = (cg) => Boolean(cg && /\/gateway$/.test(cg));
const isAgentExecLeaf = (cg) => Boolean(cg && /\/agent-exec$/.test(cg));

function classify(cmd) {
  if (!cmd) return "unknown";
  if (cmd.includes("proof-cgroup-sampler")) return "sampler";
  if (cmd.includes("snapshot.out")) return "capture";
  if (/shell-snapshots\/[0-9a-f]+\.\d+\.\d+\.tmp/.test(cmd)) return "validation";
  if (cmd.includes("PROOF_GATEWAY_CONTROL")) return "gateway-control";
  if (cmd.includes("proof_snapshot_marker")) return "exec";
  return "other";
}

function readSamplerLog() {
  const entries = [];
  let raw = "";
  try {
    raw = fs.readFileSync(SAMPLER_LOG, "utf8");
  } catch {
    return entries;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // ignore torn line
    }
  }
  return entries;
}

async function main() {
  process.env.SHELL = "/bin/bash";
  process.env.OPENCLAW_STATE_DIR = STATE_DIR;
  process.env.HOME = HOME;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });

  // Only an interactive capture shell sees this; the exec shell runs with
  // --norc, so the marker printing proves the snapshot was sourced.
  fs.writeFileSync(
    path.join(HOME, ".bashrc"),
    "proof_snapshot_marker() { printf 'SNAPSHOT-WAS-SOURCED\\n'; }\nsleep 0.4\n",
  );

  const { spawnProcess } = await import("../../src/process/spawn-utils.js");
  const cgroupMod = await import("../../src/process/linux-exec-cgroup.js");
  const startupMod = await import("../../src/process/linux-exec-cgroup-startup.js");
  const brokerMod = await import("../../src/process/spawn-broker/context.js");
  const { prepareHostExecSpawn } = await import("../../src/agents/bash-tools.exec-host-spawn.js");

  const selfPid = process.pid;
  const selfBefore = cgroupV2Path(selfPid);
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
  const serviceRoot = agentExecDir ? path.dirname(agentExecDir) : null;
  const gatewayDir = serviceRoot ? path.join(serviceRoot, "gateway") : null;
  log(`PROOF getAgentExecCgroup: ${agentExecDir ?? "(undefined)"}`);
  log(`PROOF service cgroup root: ${serviceRoot ?? "(none)"}`);

  let broker = null;
  if (agentExecDir) {
    broker = await brokerMod.startGatewaySpawnBroker({
      onReady: (pid) => log(`PROOF broker ready pid=${pid}`),
      onStartupFailure: (message) => log(`PROOF broker startup failure: ${message}`),
    });
  }

  // Start the sampler outside the broker context so it stays in the gateway leaf
  // and never confuses the placement it is observing.
  const samplerDirs = [agentExecDir, gatewayDir].filter(Boolean);
  const sampler = nodeSpawn(
    process.execPath,
    ["-e", SAMPLER_SOURCE, ...samplerDirs, SAMPLER_LOG],
    { stdio: "ignore" },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));

  const markerPaths = [];
  const roundExitCodes = [];
  let wrappedArgv = [];

  try {
    const runRounds = broker
      ? () => brokerMod.runWithSpawnBroker(broker, round)
      : () => round();

    async function round() {
      // Distinct workdirs produce distinct snapshot keys, so a retry re-runs the
      // real capture and validation shells instead of reusing a cached snapshot.
      for (const index of [1, 2, 3]) {
        const workdir = `/tmp/proof-shell-snapshot-wd-${index}`;
        fs.mkdirSync(workdir, { recursive: true });
        const markerPath = `/tmp/proof-exec-marker-${index}.txt`;
        markerPaths.push(markerPath);
        fs.rmSync(markerPath, { force: true });
        const spawnSpec = await prepareHostExecSpawn({
          command: `proof_snapshot_marker > ${markerPath}`,
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
      const control = spawnProcess(
        "/bin/bash",
        ["-c", GATEWAY_CONTROL_CMD],
        { stdio: "ignore" },
        undefined,
        "gateway-internal",
      );
      controlPid = control.pid ?? null;
      controlLive = controlPid ? cgroupV2Path(controlPid) : null;
      await once(control, "close");
    }

    await runRounds();
  } catch (error) {
    log(`PROOF ERROR during run: ${error?.stack ?? error}`);
    fs.writeFileSync(`${SAMPLER_LOG}.stop`, "");
    sampler.kill("SIGKILL");
    finish(2);
  }

  try {
    await broker?.close?.();
  } catch {
    // ignore
  }

  fs.writeFileSync(`${SAMPLER_LOG}.stop`, "");
  try {
    await once(sampler, "exit");
  } catch {
    sampler.kill("SIGKILL");
  }

  const selfAfter = cgroupV2Path(selfPid);
  log(`PROOF self cgroup (after): ${selfAfter}`);
  log(`PROOF self remained in gateway leaf: ${isGatewayLeaf(selfAfter)}`);

  const observed = new Map();
  for (const entry of readSamplerLog()) {
    if (entry.pid === selfPid || entry.pid === sampler.pid) continue;
    if (observed.has(entry.pid)) continue;
    observed.set(entry.pid, {
      cg: entry.cg,
      kind: classify(entry.cmd),
      cmd: entry.cmd,
    });
  }
  if (controlPid && !observed.has(controlPid)) {
    observed.set(controlPid, { cg: controlLive, kind: "gateway-control", cmd: GATEWAY_CONTROL_CMD });
  }

  for (const [pid, info] of [...observed.entries()].sort((a, b) => a[0] - b[0])) {
    log(`PROOF observed pid=${pid} kind=${info.kind} cgroup=${info.cg ?? "(gone)"} cmd=${info.cmd.slice(0, 140)}`);
  }

  const pick = (kind) => [...observed.entries()].filter(([, info]) => info.kind === kind);
  const inAgentExec = ([, info]) => isAgentExecLeaf(info.cg);
  const inGateway = ([, info]) => isGatewayLeaf(info.cg);

  const capture = pick("capture");
  const validation = pick("validation");
  const execShell = pick("exec");
  const control = pick("gateway-control");
  log(`PROOF capture shell pids: ${capture.map((e) => e[0]).join(",") || "(none)"}`);
  log(`PROOF validation shell pids: ${validation.map((e) => e[0]).join(",") || "(none)"}`);
  log(`PROOF exec shell pids: ${execShell.map((e) => e[0]).join(",") || "(none)"}`);
  log(`PROOF gateway control pids: ${control.map((e) => e[0]).join(",") || "(none)"}`);

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
  const publishedSnapshots = snapshotFiles.length;
  log(`PROOF published snapshot count: ${publishedSnapshots}`);
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
    ["capture shell PID in agent-exec", capture.some(inAgentExec)],
    ["validation shell PID in agent-exec", validation.some(inAgentExec)],
    ["exec shell PID in agent-exec", execShell.some(inAgentExec)],
    ["snapshot published with marker function", snapshotWithMarker],
    ["wrapped command sourced snapshot", wrappedUsesSnapshot],
    ["snapshot used: marker printed by every round", markersPrinted.length === markerOutputs.length && markerOutputs.length > 0],
    ["exec rounds exited 0", roundExitCodes.length > 0 && roundExitCodes.every((code) => code === 0)],
    ["gateway-internal control stayed in gateway", control.some(inGateway)],
    ["self remained in gateway after", isGatewayLeaf(selfAfter)],
  ];
  for (const [name, ok] of checks) {
    log(`PROOF check ${ok ? "PASS" : "FAIL"}: ${name}`);
  }
  const failed = checks.filter(([, ok]) => !ok);
  log(`PROOF VERDICT: ${failed.length === 0 ? "PASS" : "FAIL"}`);
  finish(failed.length === 0 ? 0 : 1);
}

let controlPid = null;
let controlLive = null;

await main();
