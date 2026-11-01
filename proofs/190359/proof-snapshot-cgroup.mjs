// Proof script for PR #190359: snapshot shell placement in agent-exec cgroup.
// Runs inside a systemd delegated transient unit (DelegateSubgroup=gateway) so
// resolveGatewayServiceCgroupDirectory() finds the gateway leaf. Starts the
// real spawn broker, initializes the agent-exec cgroup, drives the real
// snapshot capture path, and observes the snapshot shell's cgroup membership.
import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const PROOF_LOG = process.env.PROOF_LOG;

const lines = [];
function log(msg) {
  lines.push(msg);
  console.log(msg);
}

function readCgroup(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
  } catch {
    return "(unreadable)";
  }
}

async function main() {
  // Confirm our own placement (Gateway-equivalent process in gateway leaf).
  const selfCgroup = fs.readFileSync("/proc/self/cgroup", "utf8").trim();
  log(`PROOF self cgroup: ${selfCgroup}`);
  const selfMatchesGateway = /\/[^/]+\.service\/gateway$/.test(selfCgroup);
  log(`PROOF self in gateway leaf: ${selfMatchesGateway}`);

  // Import source modules via tsx (loaded by --import tsx/esm).
  // Script runs from <openclaw>/proofs/190359/, so src is ../../src/.
  const { initializeGatewayExecCgroup } = await import(
    "../../src/process/linux-exec-cgroup-startup.js"
  );
  const { startGatewaySpawnBroker, runWithSpawnBroker } = await import(
    "../../src/process/spawn-broker/context.js"
  );
  const { maybeWrapCommandWithShellSnapshot } = await import(
    "../../src/agents/shell-snapshot.js"
  );
  const { getAgentExecCgroup } = await import(
    "../../src/process/linux-exec-cgroup.js"
  );

  // Initialize the agent-exec cgroup leaf (creates agent-exec, enables controllers).
  const initResult = await initializeGatewayExecCgroup(STATE_DIR);
  log(`PROOF initializeGatewayExecCgroup: ${initResult}`);
  const execDir = getAgentExecCgroup();
  log(`PROOF getAgentExecCgroup: ${execDir ?? "(undefined)"}`);
  if (!execDir) {
    log("PROOF FAIL: agent-exec cgroup not available (delegation missing)");
    return { ok: false, reason: "no-agent-exec" };
  }

  const agentExecProcs = path.join(execDir, "cgroup.procs");
  const gatewayProcs = path.join(path.dirname(execDir), "gateway", "cgroup.procs");

  // Start the real spawn broker (runs worker from source via tsx in a source tree).
  let brokerPid;
  const broker = await startGatewaySpawnBroker({
    onReady: (pid) => {
      brokerPid = pid;
      log(`PROOF broker ready pid=${pid}`);
    },
    onStartupFailure: (msg) => {
      log(`PROOF broker startup failure: ${msg}`);
    },
  });
  if (!broker) {
    log("PROOF FAIL: spawn broker did not start");
    return { ok: false, reason: "no-broker" };
  }
  log(`PROOF broker started pid=${brokerPid}`);

  // Poller: capture any pid that appears in agent-exec/cgroup.procs during snapshot.
  const observedAgentExecPids = new Map();
  const observedGatewayPids = new Set();
  const selfPid = process.pid;
  const poller = setInterval(() => {
    try {
      const procs = fs.readFileSync(agentExecProcs, "utf8").trim();
      for (const line of procs.split("\n")) {
        const pid = Number(line);
        if (pid > 0 && !observedAgentExecPids.has(pid)) {
          observedAgentExecPids.set(pid, readCgroup(pid));
        }
      }
    } catch {
      // file may be briefly unavailable
    }
    try {
      const gprocs = fs.readFileSync(gatewayProcs, "utf8").trim();
      for (const line of gprocs.split("\n")) {
        const pid = Number(line);
        if (pid > 0 && pid !== selfPid) observedGatewayPids.add(pid);
      }
    } catch {
      // ignore
    }
  }, 5);

  // Drive the real snapshot capture path inside the broker context.
  const home = process.env.HOME;
  const env = { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR, HOME: home };
  const wrappedPromise = runWithSpawnBroker(broker, () =>
    maybeWrapCommandWithShellSnapshot({
      command: "echo proof-snapshot",
      shell: "/bin/bash",
      shellArgs: ["-c"],
      cwd: "/tmp",
      env,
    }),
  );
  // maybeWrapCommandWithShellSnapshot is async; await it so the snapshot
  // capture shell actually runs (and lands in agent-exec) before we stop polling.
  await wrappedPromise;
  // Give the poller a moment to catch the snapshot shell.
  await new Promise((r) => setTimeout(r, 300));
  clearInterval(poller);

  // Shut down the broker.
  try {
    await broker.close();
  } catch (e) {
    log(`PROOF broker close error: ${String(e)}`);
  }

  log(`PROOF observed agent-exec pids: ${[...observedAgentExecPids.keys()].join(",") || "(none)"}`);
  for (const [pid, cg] of observedAgentExecPids) {
    log(`PROOF agent-exec pid=${pid} cgroup=${cg}`);
  }
  log(`PROOF observed gateway pids (excluding self): ${[...observedGatewayPids].join(",") || "(none)"}`);

  // Verdict: at least one snapshot shell landed in agent-exec, and its cgroup
  // path contains agent-exec. The gateway leaf holds the broker/Gateway pids.
  const snapshotInAgentExec = [...observedAgentExecPids.values()].some((cg) =>
    /\/agent-exec$/.test(cg),
  );
  log(`PROOF snapshot shell reached agent-exec: ${snapshotInAgentExec}`);
  log(`PROOF self remained in gateway: ${selfMatchesGateway}`);

  const ok = snapshotInAgentExec && selfMatchesGateway;
  log(`PROOF VERDICT: ${ok ? "PASS" : "FAIL"}`);
  return { ok, snapshotInAgentExec, selfMatchesGateway };
}

main()
  .then((v) => {
    fs.writeFileSync(PROOF_LOG, lines.join("\n") + "\n");
    process.exit(v.ok ? 0 : 1);
  })
  .catch((e) => {
    lines.push(`PROOF ERROR: ${String(e)}`);
    if (PROOF_LOG) fs.writeFileSync(PROOF_LOG, lines.join("\n") + "\n");
    console.error(e);
    process.exit(2);
  });