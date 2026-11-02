// Real-behavior proof for PR 190359.
//
// Drives the shipped host-exec preparation path (prepareHostExecSpawn -> the
// snapshot capture/validation shells) and the shipped agent exec spawn owner
// (spawnProcess with executionIntent "agent-tool") inside a delegated systemd
// unit, then reads kernel cgroup membership for the *specific* capture and
// validation shell PIDs.
//
// Checks:
//   1. self (Gateway) is in the gateway leaf before and after the run
//   2. capture shell PID lands in agent-exec
//   3. validation shell PID lands in agent-exec
//   4. the wrapped command actually sourced the snapshot (marker function from
//      ~/.bashrc is only available if capture + validation + sourcing worked)
//   5. a Gateway-internal control child spawned through the same broker stays
//      in the gateway leaf

import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/tmp/oc-proof-state";
const PROOF_LOG = process.env.PROOF_LOG || "";
const HOME = process.env.HOME || "/tmp/oc-proof-home";
const GATEWAY_CONTROL_CMD = "sleep 0.8 # PROOF_GATEWAY_CONTROL";

const lines = [];
function log(message) {
  lines.push(message);
  console.log(message);
}
function flush() {
  if (!PROOF_LOG) return;
  try {
    fs.mkdirSync(path.dirname(PROOF_LOG), { recursive: true });
    fs.writeFileSync(PROOF_LOG, lines.join("\n") + "\n");
  } catch {
    // best effort only; stdout is the primary channel
  }
}
function finish(code) {
  flush();
  process.exit(code);
}

function cgroupV2Path(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const match = raw.match(/^0::(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}
function isGatewayLeaf(cg) {
  return Boolean(cg && /\/gateway$/.test(cg));
}
function isAgentExecLeaf(cg) {
  return Boolean(cg && /\/agent-exec$/.test(cg));
}
function cmdlineOf(pid) {
  try {
    return fs
      .readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .replace(/\0+/g, " ")
      .trim();
  } catch {
    return "";
  }
}
function classify(cmd) {
  if (!cmd) return "other";
  if (cmd.includes("snapshot.out")) return "capture";
  if (/shell-snapshots\/[0-9a-f]+\.\d+\.\d+\.tmp/.test(cmd)) return "validation";
  if (cmd.includes("PROOF_GATEWAY_CONTROL")) return "gateway-control";
  if (cmd.includes("proof_snapshot_marker")) return "exec";
  return "other";
}

async function main() {
  process.env.SHELL = process.env.SHELL || "/bin/bash";
  process.env.OPENCLAW_STATE_DIR = STATE_DIR;
  process.env.HOME = HOME;
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });

  // The snapshot capture shell runs `bash -i`, so this function is visible to it
  // and must survive capture + validation to be callable by the wrapped command.
  // The trailing sleep keeps the capture shell observable.
  fs.writeFileSync(
    path.join(HOME, ".bashrc"),
    "proof_snapshot_marker() { printf 'SNAPSHOT-WAS-SOURCED\\n'; }\nsleep 0.5\n",
  );

  const { spawnProcess } = await import("../../src/process/spawn-utils.js");
  const cgroupMod = await import("../../src/process/linux-exec-cgroup.js");
  const startupMod = await import("../../src/process/linux-exec-cgroup-startup.js");
  const brokerMod = await import("../../src/process/spawn-broker/context.js");
  const { prepareHostExecSpawn } = await import(
    "../../src/agents/bash-tools.exec-host-spawn.js"
  );

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
  log(`PROOF getAgentExecCgroup: ${agentExecDir ?? "(undefined)"}`);

  const serviceRoot = agentExecDir ? path.dirname(agentExecDir) : null;
  const gatewayDir = serviceRoot ? path.join(serviceRoot, "gateway") : null;
  log(`PROOF service cgroup root: ${serviceRoot ?? "(none)"}`);

  const observed = new Map();
  // Only the directory under test is polled: capture/validation shells are
  // short-lived, so every extra read per tick costs sampling resolution.
  let activeDirs = agentExecDir ? [[agentExecDir, "agent-exec"]] : [];
  function sample() {
    for (const [dir, label] of activeDirs) {
      let raw;
      try {
        raw = fs.readFileSync(path.join(dir, "cgroup.procs"), "utf8");
      } catch {
        continue;
      }
      for (const entry of raw.split("\n")) {
        const pid = Number(entry.trim());
        if (!pid || pid === selfPid || observed.has(pid)) continue;
        const cmd = cmdlineOf(pid);
        const kind = classify(cmd);
        observed.set(pid, {
          cgroup: label,
          kind,
          cmd: cmd.slice(0, 160),
          live: cgroupV2Path(pid),
        });
      }
    }
  }

  let broker = null;
  if (agentExecDir) {
    broker = await brokerMod.startGatewaySpawnBroker({
      onReady: (pid) => log(`PROOF broker ready pid=${pid}`),
      onStartupFailure: (message) => log(`PROOF broker startup failure: ${message}`),
    });
  }

  const poller = setInterval(sample, 1);
  let stdout = "";
  let exitCode = null;
  let wrappedArgv = [];

  try {
    const runRounds = broker
      ? () => brokerMod.runWithSpawnBroker(broker, round)
      : () => round();

    async function round() {
      // Distinct workdirs produce distinct snapshot keys, so a retry re-runs the
      // real capture + validation shells instead of reusing a cached snapshot.
      for (const index of [1, 2, 3, 4, 5]) {
        const workdir = `/tmp/proof-shell-snapshot-wd-${index}`;
        fs.mkdirSync(workdir, { recursive: true });
        const spawnSpec = await prepareHostExecSpawn({
          command: "proof_snapshot_marker",
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
            stdio: ["ignore", "pipe", "pipe"],
          },
          undefined,
          "agent-tool",
        );
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
          stdout += chunk;
        });
        const [code] = await once(child, "close");
        exitCode = code;
        sample();
        const seen = new Set([...observed.values()].map((entry) => entry.kind));
        if (seen.has("capture") && seen.has("validation")) break;
      }

      // Gateway-internal control: same broker, no agent intent.
      activeDirs = [
        [agentExecDir, "agent-exec"],
        [gatewayDir, "gateway"],
      ].filter(([dir]) => Boolean(dir));
      const control = spawnProcess(
        "/bin/bash",
        ["-c", GATEWAY_CONTROL_CMD],
        { stdio: "ignore" },
        undefined,
        "gateway-internal",
      );
      const controlPid = control.pid;
      // Read the control's own cgroup while it is alive: authoritative placement,
      // independent of any polling window.
      const controlLive = controlPid ? cgroupV2Path(controlPid) : null;
      await new Promise((resolve) => setTimeout(resolve, 250));
      sample();
      await once(control, "close");
      if (controlPid) {
        observed.set(controlPid, {
          cgroup: isAgentExecLeaf(controlLive) ? "agent-exec" : "gateway",
          kind: "gateway-control",
          cmd: GATEWAY_CONTROL_CMD,
          live: controlLive,
        });
      }
    }

    await runRounds();
  } catch (error) {
    log(`PROOF ERROR during run: ${error?.stack ?? error}`);
    clearInterval(poller);
    finish(2);
  }

  clearInterval(poller);
  try {
    await broker?.close?.();
  } catch {
    // ignore
  }

  const selfAfter = cgroupV2Path(selfPid);
  log(`PROOF self cgroup (after): ${selfAfter}`);
  log(`PROOF self remained in gateway leaf: ${isGatewayLeaf(selfAfter)}`);

  // Report every observed process so the classification is auditable.
  const byKind = new Map();
  for (const [pid, info] of [...observed.entries()].sort((a, b) => a[0] - b[0])) {
    const previous = byKind.get(info.kind) ?? [];
    previous.push({ pid, cgroup: info.cgroup, live: info.live });
    byKind.set(info.kind, previous);
    log(
      `PROOF observed pid=${pid} kind=${info.kind} cgroup=${info.cgroup} live=${info.live ?? "(gone)"} cmd=${info.cmd}`,
    );
  }
  log(`PROOF observed all pids: ${[...observed.keys()].join(",")}`);

  const capturePids = byKind.get("capture") ?? [];
  const validationPids = byKind.get("validation") ?? [];
  const execPids = byKind.get("exec") ?? [];
  const controlPids = byKind.get("gateway-control") ?? [];
  log(`PROOF capture shell pids: ${capturePids.map((e) => e.pid).join(",") || "(none)"}`);
  log(`PROOF validation shell pids: ${validationPids.map((e) => e.pid).join(",") || "(none)"}`);
  log(`PROOF exec shell pids: ${execPids.map((e) => e.pid).join(",") || "(none)"}`);
  log(`PROOF gateway control pids: ${controlPids.map((e) => e.pid).join(",") || "(none)"}`);

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
  const snapshotWithMarker = snapshotFiles.find((file) => {
    try {
      return fs.readFileSync(file, "utf8").includes("proof_snapshot_marker");
    } catch {
      return false;
    }
  });
  log(`PROOF snapshot files: ${snapshotFiles.map((f) => path.basename(f)).join(",") || "(none)"}`);
  log(`PROOF snapshot captures marker function: ${Boolean(snapshotWithMarker)}`);

  const wrappedUsesSnapshot = wrappedArgv.some((arg) => arg.includes("shell-snapshots"));
  const stdoutMarker = stdout.includes("SNAPSHOT-WAS-SOURCED");
  log(`PROOF wrapped argv sources snapshot: ${wrappedUsesSnapshot}`);
  log(`PROOF capture command exit code: ${exitCode}`);
  log(`PROOF capture stdout: ${JSON.stringify(stdout.trim())}`);
  log(`PROOF snapshot was used (marker printed): ${stdoutMarker}`);

  const checks = [
    ["self in gateway before", isGatewayLeaf(selfBefore)],
    ["agent-exec cgroup available", Boolean(agentExecDir)],
    ["capture shell PID in agent-exec", capturePids.some((e) => isAgentExecLeaf(e.live) || e.cgroup === "agent-exec")],
    ["validation shell PID in agent-exec", validationPids.some((e) => isAgentExecLeaf(e.live) || e.cgroup === "agent-exec")],
    ["snapshot captured marker function", Boolean(snapshotWithMarker)],
    ["wrapped command sourced snapshot", wrappedUsesSnapshot],
    ["snapshot actually used (marker printed)", stdoutMarker],
    ["gateway-internal control stayed in gateway", controlPids.some((e) => e.cgroup === "gateway" && !isAgentExecLeaf(e.live))],
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
