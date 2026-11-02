// Drives a real agent shell-tool turn through an isolated Gateway using the
// repository's own e2e OpenAI-compatible mock provider, and records where the
// snapshot capture/validation subprocesses actually ran.
//
// Flow per round: shipped CLI (`openclaw agent`) -> Gateway RPC -> session ->
// agent loop -> `exec` tool -> host exec preparation -> spawn broker ->
// shell snapshot capture + validation + exec shell.
//
// The only synthetic part is inference: scripts/e2e/mock-openai-server.mjs
// returns a scripted exec tool call. Placement is decided by the exec tool and
// the broker, never by the model, so a scripted provider cannot change the
// observed cgroups.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const REPO = process.env.PROOF_REPO ?? process.cwd();
const HTTP = process.env.PROOF_HTTP ?? "http://127.0.0.1:18787";
const UNIT = process.env.PROOF_UNIT ?? "";
const STATE_DIR = process.env.PROOF_STATE_DIR ?? "";
const MOCK_PORT = process.env.PROOF_MOCK_PORT ?? "18789";
const CONTROL = process.env.PROOF_MOCK_CONTROL ?? "/tmp/proof-mock-control.json";
const ROUNDS = 3;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`PROOF check ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readCgroup(pid) {
  try {
    const line = fs
      .readFileSync(`/proc/${pid}/cgroup`, "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    return line ? line.slice(3) : undefined;
  } catch {
    return undefined;
  }
}

function short(cgroup) {
  if (!cgroup) {
    return "unknown";
  }
  return cgroup.split("/").filter(Boolean).slice(-3).join("/");
}

/**
 * Every process the proof can see inside the proof unit, with its parent, so a
 * capture shell that kept the Gateway cgroup can be told apart from one the
 * spawn broker placed: the broker is a separate child process of the Gateway.
 */
function dumpUnitProcesses() {
  const rows = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const cgroup = readCgroup(entry);
    if (!cgroup || !short(cgroup).includes(UNIT)) {
      continue;
    }
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").join(" ").trim();
    } catch {
      continue;
    }
    let ppid = "?";
    try {
      ppid = /^PPid:\s+(\d+)$/mu.exec(fs.readFileSync(`/proc/${entry}/status`, "utf8"))?.[1] ?? "?";
    } catch {
      // A process that exited between scans still reports its cgroup.
    }
    rows.push(`PROOF proc pid=${entry} ppid=${ppid} cgroup=${short(cgroup)} cmd=${cmd.slice(0, 80)}`);
  }
  for (const row of rows) {
    console.log(row);
  }
  const gwRoot = (() => {
    const pid = gatewayPid();
    const cgroup = pid ? readCgroup(pid) : undefined;
    return cgroup ? `/sys/fs/cgroup${cgroup.replace(/\/gateway$/u, "")}` : undefined;
  })();
  if (!gwRoot) {
    console.log("PROOF delegation root unresolved");
    return;
  }
  const read = (suffix) => {
    try {
      return fs.readFileSync(`${gwRoot}/${suffix}`, "utf8").trim().replace(/\n/gu, "|");
    } catch (error) {
      return `unreadable(${error.code ?? "error"})`;
    }
  };
  console.log(`PROOF delegation subtree_control=${read("cgroup.subtree_control")}`);
  console.log(`PROOF delegation controllers=${read("cgroup.controllers")}`);
  console.log(`PROOF delegation service procs=${read("cgroup.procs") || "empty"}`);
  console.log(`PROOF delegation agent-exec memory.high=${read("agent-exec/memory.high")}`);
  console.log(`PROOF delegation agent-exec subtree_control=${read("agent-exec/cgroup.subtree_control")}`);
  console.log(`PROOF delegation agent-exec procs=${read("agent-exec/cgroup.procs") || "empty"}`);
}

/** The Gateway node process: only one matching pid sits in the gateway leaf. */
function gatewayPid() {  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const cgroup = readCgroup(entry);
    if (!cgroup || !short(cgroup).endsWith("gateway")) {
      continue;
    }
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").replace(/\0/gu, " ");
      if (cmd.includes("gateway") && cmd.includes("node")) {
        return Number(entry);
      }
    } catch {
      // Process exited while scanning.
    }
  }
  return undefined;
}

async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (await httpOk(url)) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

function writeControl(round) {
  fs.writeFileSync(
    CONTROL,
    JSON.stringify({
      text: `round ${round} complete`,
      toolCall: {
        name: "exec",
        arguments: {
          // `proof_snapshot_marker` exists only in the interactive rc file, so a
          // marker file proves this shell sourced the published snapshot.
          command: `# PROOF_EXEC_${round}\nproof_snapshot_marker > /tmp/proof-round-${round}.out\n`,
          workdir: `/tmp/proof-agent-wd-${round}`,
          yieldMs: 30000,
          timeoutSeconds: 60,
        },
      },
    }),
  );
}

/**
 * The mock provider is scripted to call exec with `proof_snapshot_marker`, which
 * the published snapshot defines; sourcing that snapshot and running the helper
 * prints `SNAPSHOT-WAS-SOURCED`. A real model gets an explicit instruction to
 * run the same command so the proof no longer depends on a scripted provider.
 */
function agentMessage(round) {
  if (process.env.PROOF_REAL_MODEL === "1") {
    return [
      "Use the exec tool to run exactly this shell command, unchanged:",
      `proof_snapshot_marker > /tmp/proof-round-${round}.out ; echo PROOF_ROUND_${round}_DONE`,
      "Do not add quotes or other commands. Then report the DONE line you saw.",
    ].join(" ");
  }
  return `proof round ${round}`;
}

function runAgentTurn(round) {
  const started = Date.now();
  const result = spawnSync(
    "pnpm",
    ["openclaw", "agent", "--agent", "main", "--message", agentMessage(round), "--json"],
    { cwd: REPO, encoding: "utf8", timeout: 240000, env: process.env },
  );
  return { round, status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, ms: Date.now() - started };
}

function publishedSnapshots() {
  try {
    return fs.readdirSync(`${STATE_DIR}/cache/shell-snapshots`).filter((name) => name.endsWith(".sh"));
  } catch {
    return [];
  }
}

/**
 * The capture shell sources the interactive rc file, which appends the cgroup the
 * kernel put that shell in. Sampling a millisecond-lived process can miss it; the
 * shell's own report cannot.
 */
function captureSelfReports() {
  const tag = process.env.PROOF_TAG ?? "";
  try {
    return fs
      .readFileSync(`/tmp/proof-capture-cgroups${tag}.txt`, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [pid, cgroup] = line.trim().split(" ");
        return { pid: Number(pid), cgroup: cgroup ?? "" };
      });
  } catch {
    return [];
  }
}

async function main() {
  console.log(`PROOF gateway ${HTTP} unit=${UNIT} repo=${REPO}`);
  const realModel = process.env.PROOF_REAL_MODEL === "1";
  console.log(`PROOF mode=${realModel ? "real-model" : "mock-provider"}`);

  let mock;
  let mockLog = "";
  let mockReady = false;
  if (!realModel) {
    mock = spawn(process.execPath, [`${REPO}/scripts/e2e/mock-openai-server.mjs`], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MOCK_PORT, MOCK_RESPONSE_CONTROL: CONTROL, MOCK_REQUEST_LOG: "/tmp/proof-mock-requests.jsonl" },
    });
    mock.stdout.on("data", (chunk) => {
      mockLog += String(chunk);
    });
    mock.stderr.on("data", (chunk) => {
      mockLog += String(chunk);
    });
    mockReady = await waitFor(`http://127.0.0.1:${MOCK_PORT}/health`, 30_000);
    check("e2e mock provider answered /health", mockReady, `port=${MOCK_PORT}`);
  } else {
    check("real-model proof skips the scripted mock provider", true);
  }

  const ready = await waitFor(`${HTTP}/readyz`, 180_000);
  const gwPid = gatewayPid();
  const gwBefore = gwPid ? readCgroup(gwPid) : undefined;
  console.log(`PROOF gateway pid=${gwPid} cgroup=${short(gwBefore)}`);
  check("gateway answered /readyz", ready);
  check("gateway process runs in the service gateway leaf", short(gwBefore).endsWith("gateway"), short(gwBefore));

  // Every process in the gateway leaf is a root: whichever wrapper actually
  // forks the snapshot shells, its whole subtree stays visible to the sampler.
  const samplerRoots = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) {
      continue;
    }
    const cgroup = readCgroup(entry);
    if (cgroup && short(cgroup).endsWith("gateway")) {
      samplerRoots.push(entry);
    }
  }
  const sampler = spawn(process.execPath, [`${REPO}/proofs/190359/proof-cgroup-sampler.mjs`], {
    cwd: REPO,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, SAMPLER_ROOTS: samplerRoots.join(",") },
  });
  const readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline && !fs.existsSync(process.env.SAMPLER_READY ?? "")) {
    await sleep(100);
  }

  const rounds = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    fs.mkdirSync(`/tmp/proof-agent-wd-${round}`, { recursive: true });
    fs.rmSync(`/tmp/proof-round-${round}.out`, { force: true });
    writeControl(round);
    const result = runAgentTurn(round);
    rounds.push(result);
    console.log(`PROOF agent round=${round} cliStatus=${result.status} ms=${result.ms}`);
    console.log(`PROOF agent round=${round} output tail: ${result.out.slice(-600)}`);
  }

  dumpUnitProcesses();

  fs.writeFileSync(process.env.SAMPLER_STOP ?? "/tmp/proof-sampler.stop", "stop\n");
  const samplerExit = await new Promise((resolve) => {
    if (sampler.exitCode !== null) {
      resolve(sampler.exitCode);
      return;
    }
    const timer = setTimeout(() => resolve("timeout"), 30_000);
    sampler.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  console.log(`PROOF sampler exit=${samplerExit}`);

  const records = [];
  try {
    for (const line of fs.readFileSync(process.env.SAMPLER_OUT ?? "", "utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        // Ignore a partially flushed line.
      }
    }
  } catch {
    // Sampler never wrote; assertions below fail with evidence.
  }
  const kinds = { capture: [], validation: [], exec: [], launcher: [] };
  for (const record of records) {
    // A shell that places itself keeps its pid, so the settled identity is the
    // last cmdline observed for that pid.
    const cmd = record.lastCmd ?? "";
    if (!short(record.lastCg ?? record.firstCg).includes(UNIT)) {
      continue;
    }
    // Real-model exec commands do not carry the mock-only PROOF_EXEC_ marker;
    // the gateway launches them as `bash -c 'if [ -r .../shell-snapshots/... ]'`,
    // so match the snapshot cache path too. Exclude .tmp validation scripts and the
    // dedicated capture-shell marker so the mock-only capture/validation split still holds.
    if (cmd.includes("PROOF_EXEC_") || (cmd.includes("shell-snapshots/") && !cmd.includes(".tmp") && !cmd.includes("__OPENCLAW_SHELL_SNAPSHOT_CAPTURE__"))) {
      kinds.exec.push(record);
    } else if (cmd.includes("__OPENCLAW_SHELL_SNAPSHOT_CAPTURE__")) {
      kinds.capture.push(record);
    } else if (cmd.includes(".tmp")) {
      kinds.validation.push(record);
    } else if (cmd.includes("cgroup.procs")) {
      kinds.launcher.push(record);
    }
  }
  for (const kind of ["capture", "validation", "exec", "launcher"]) {
    for (const record of kinds[kind]) {
      console.log(
        `PROOF ${kind} pid=${record.pid} ppid=${record.ppid} first=${short(record.firstCg)} last=${short(record.lastCg)} cmd=${(record.lastCmd ?? "").slice(0, 90)}`,
      );
    }
  }
  try {
    console.log(`PROOF sampler stats ${fs.readFileSync(`${process.env.SAMPLER_OUT}.stats`, "utf8").trim()}`);
  } catch {
    console.log("PROOF sampler stats unavailable");
  }

  const endsInAgentExec = (record) => short(record.lastCg).endsWith("agent-exec");
  const startsInGateway = (record) => short(record.firstCg).endsWith("gateway");
  const markers = rounds.filter((round) => {
    try {
      return fs.readFileSync(`/tmp/proof-round-${round.round}.out`, "utf8").includes("SNAPSHOT-WAS-SOURCED");
    } catch {
      return false;
    }
  });
  const snapshots = publishedSnapshots();
  const reports = captureSelfReports();
  // A launcher starts in the Gateway leaf and moves itself into agent-exec before
  // it execs the shell, so a shell that kept the launcher pid legitimately has a
  // Gateway first observation. Everything else must never touch that leaf.
  const isLauncherOrigin = (record) =>
    (record.firstCmd ?? "").includes("cgroup.procs") &&
    (record.firstCmd ?? "").startsWith("/bin/sh -c printf");
  const placed = [...kinds.capture, ...kinds.validation, ...kinds.exec].filter(
    (record) => !isLauncherOrigin(record),
  );
  const launchers = records.filter(
    (record) => isLauncherOrigin(record) && short(record.lastCg ?? record.firstCg).includes(UNIT),
  );

  check("every agent turn finished through the CLI", rounds.every((round) => round.status === 0), rounds.map((r) => r.status).join(","));
  const snapshotCountOk = process.env.PROOF_REAL_MODEL === "1" ? snapshots.length >= 1 : snapshots.length === ROUNDS;
  check("snapshot published at least once (real model may reuse one workdir)", snapshotCountOk, `count=${snapshots.length}`);
  const markersOk = process.env.PROOF_REAL_MODEL === "1" ? markers.length >= 1 : markers.length === ROUNDS;
  check("snapshot sourced and used by an exec turn", markersOk, `${markers.length}/${ROUNDS}`);
  check("capture shells report agent-exec", reports.length >= (process.env.PROOF_REAL_MODEL === "1" ? 1 : ROUNDS) && reports.every((row) => short(row.cgroup).endsWith("agent-exec")), reports.map((row) => short(row.cgroup)).slice(0, 3).join(",") || "none");
  check("capture shells observed", kinds.capture.length >= (process.env.PROOF_REAL_MODEL === "1" ? 0 : 1), `n=${kinds.capture.length}`);
  check("capture shells all in agent-exec", kinds.capture.length > 0 && kinds.capture.every(endsInAgentExec), kinds.capture.map((r) => short(r.lastCg)).slice(0, 3).join(","));
  check("validation shells observed", kinds.validation.length >= (process.env.PROOF_REAL_MODEL === "1" ? 0 : 1), `n=${kinds.validation.length}`);
  check("validation shells all in agent-exec", kinds.validation.length > 0 && kinds.validation.every(endsInAgentExec), kinds.validation.map((r) => short(r.lastCg)).slice(0, 3).join(","));
  check("no placed shell ever ran in the gateway leaf", placed.every((record) => !startsInGateway(record) && !short(record.lastCg).endsWith("gateway")), `n=${placed.length}`);
  check("placing launchers observed", launchers.length >= (process.env.PROOF_REAL_MODEL === "1" ? 0 : 1), `n=${launchers.length}`);
  check("every placing launcher moved itself into agent-exec", launchers.length > 0 && launchers.every(endsInAgentExec), launchers.map((r) => short(r.lastCg)).slice(0, 3).join(","));
  check("exec shells all in agent-exec", kinds.exec.length > 0 && kinds.exec.every(endsInAgentExec), `n=${kinds.exec.length}`);

  const gwAfter = gatewayPid() ? readCgroup(gatewayPid()) : undefined;
  console.log(`PROOF gateway after cgroup=${short(gwAfter)}`);
  check("gateway process remained in the gateway leaf", short(gwAfter).endsWith("gateway"), short(gwAfter));

  if (mock) {
    mock.kill("SIGTERM");
    if (!mockReady) {
      console.log(`PROOF mock log: ${mockLog.slice(-800)}`);
    }
  }
  console.log(`PROOF mock requests: ${fs.existsSync("/tmp/proof-mock-requests.jsonl") ? fs.readFileSync("/tmp/proof-mock-requests.jsonl", "utf8").split("\n").filter(Boolean).length : 0}`);

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`PROOF VERDICT: ${failed.length === 0 ? "PASS" : "FAIL"}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`PROOF fatal: ${error?.stack ?? error}`);
  console.log("PROOF VERDICT: FAIL");
  process.exitCode = 1;
});
