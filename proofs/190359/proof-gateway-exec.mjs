// Proves shell-snapshot placement through the shipped Gateway + shipped CLI path.
//
// A real `openclaw gateway run` process owns the delegated systemd unit (service
// leaf `gateway`, sibling `agent-exec`). Every exec below is a shipped CLI
// request: `openclaw gateway call tools.invoke` -> Gateway RPC -> the real `exec`
// tool -> host exec preparation -> snapshot capture/validation + exec shell.
//
// Nothing here imports product internals; the shells' own /proc/<pid>/cgroup is
// observed by an independent sampler process, and the Gateway process itself is
// the Gateway-internal control.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const HTTP = process.env.PROOF_HTTP ?? "http://127.0.0.1:18787";
const WS = process.env.PROOF_WS ?? "ws://127.0.0.1:18787";
const TOKEN = process.env.PROOF_TOKEN ?? "";
const REPO = process.env.PROOF_REPO ?? process.cwd();
const STATE_DIR = process.env.PROOF_STATE_DIR ?? "";
const UNIT = process.env.PROOF_UNIT ?? "";
const ROUNDS = 3;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`PROOF check ${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  const parts = cgroup.split("/").filter(Boolean);
  return parts.slice(-3).join("/");
}

/** The Gateway node process: only one matching pid sits in the gateway leaf. */
function mainPid() {
  if (process.env.PROOF_GATEWAY_PID) {
    return Number(process.env.PROOF_GATEWAY_PID);
  }
  for (const entry of fs.readdirSync("/proc")) {
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

async function waitReady(deadlineMs) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(`${HTTP}/readyz`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        return true;
      }
    } catch {
      // Gateway is still starting.
    }
    await sleep(1000);
  }
  return false;
}

/** The shipped CLI is the only thing we drive; it speaks the Gateway RPC. */
function callExec(round, workdir) {
  const params = {
    tool: "exec",
    args: {
      // The marker function exists only in ~/.bashrc, so printing it proves the
      // published snapshot was sourced by this exec shell.
      command: `# PROOF_EXEC_${round}\nproof_snapshot_marker\n`,
      workdir,
      yieldMs: 20000,
      timeoutSeconds: 60,
    },
  };
  const started = Date.now();
  const result = spawnSync(
    "pnpm",
    [
      "openclaw",
      "gateway",
      "call",
      "tools.invoke",
      "--json",
      "--url",
      WS,
      "--token",
      TOKEN,
      "--timeout",
      "120000",
      "--params",
      JSON.stringify(params),
    ],
    { cwd: REPO, encoding: "utf8", timeout: 240000, env: process.env },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let parsed;
  for (const line of stdout.trim().split("\n").reverse()) {
    const text = line.trim();
    if (!text.startsWith("{")) {
      continue;
    }
    try {
      parsed = JSON.parse(text);
      break;
    } catch {
      // Keep scanning older lines for the JSON payload.
    }
  }
  return { round, status: result.status, stdout, stderr, parsed, ms: Date.now() - started };
}

function publishedSnapshots() {
  const dir = `${STATE_DIR}/cache/shell-snapshots`;
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".sh"));
  } catch {
    return [];
  }
}

async function main() {
  console.log(`PROOF gateway ${HTTP} unit=${UNIT} repo=${REPO}`);
  const ready = await waitReady(180_000);
  const gwPid = mainPid();
  const gwCgroupBefore = gwPid ? readCgroup(gwPid) : undefined;
  console.log(`PROOF gateway pid=${gwPid} cgroup=${short(gwCgroupBefore)}`);
  check("gateway answered /readyz", ready);
  check("gateway process runs in the service gateway leaf", short(gwCgroupBefore).endsWith("gateway"), short(gwCgroupBefore));

  const sampler = spawn(process.execPath, [`${REPO}/proofs/190359/proof-cgroup-sampler.mjs`], {
    cwd: REPO,
    stdio: ["ignore", "ignore", "inherit"],
    env: process.env,
  });
  const samplerReadyFile = process.env.SAMPLER_READY;
  const readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline && !fs.existsSync(samplerReadyFile ?? "")) {
    await sleep(100);
  }

  const rounds = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const workdir = `/tmp/proof-gw-wd-${round}`;
    fs.mkdirSync(workdir, { recursive: true });
    const result = callExec(round, workdir);
    const payload = JSON.stringify(result.parsed ?? null);
    rounds.push(result);
    console.log(
      `PROOF exec round=${round} cliStatus=${result.status} ms=${result.ms} payload=${payload.slice(0, 400)}`,
    );
    if (!result.parsed) {
      console.log(`PROOF exec round=${round} stdout tail: ${result.stdout.slice(-800)}`);
      console.log(`PROOF exec round=${round} stderr tail: ${result.stderr.slice(-800)}`);
    }
  }

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
  const kinds = { capture: [], validation: [], exec: [], other: [] };
  for (const record of records) {
    const cmd = record.cmd ?? "";
    if (cmd.includes("PROOF_EXEC_")) {
      kinds.exec.push(record);
    } else if (cmd.includes(".tmp")) {
      kinds.validation.push(record);
    } else if (cmd.includes("snapshot.out")) {
      kinds.capture.push(record);
    } else {
      kinds.other.push(record);
    }
  }
  for (const kind of ["capture", "validation", "exec"]) {
    for (const record of kinds[kind]) {
      console.log(`PROOF ${kind} pid=${record.pid} cgroup=${short(record.cg)} cmd=${(record.cmd ?? "").slice(0, 120)}`);
    }
  }
  console.log(`PROOF sampler stats ${fs.readFileSync(`${process.env.SAMPLER_OUT}.stats`, "utf8").trim()}`);

  const inAgentExec = (record) => short(record.cg).endsWith("agent-exec");
  const inGateway = (record) => short(record.cg).endsWith("gateway");
  const markerPrinted = rounds.filter((round) => (round.stdout ?? "").includes("SNAPSHOT-WAS-SOURCED"));
  const snapshots = publishedSnapshots();

  check("shipped CLI exec requests returned a result", rounds.every((round) => round.parsed !== undefined), `${rounds.filter((r) => r.parsed).length}/${ROUNDS}`);
  check("snapshot published once per distinct workdir", snapshots.length === ROUNDS, `count=${snapshots.length}`);
  check("every round printed the snapshot-only marker", markerPrinted.length === ROUNDS, `${markerPrinted.length}/${ROUNDS}`);
  check("capture shells observed", kinds.capture.length >= ROUNDS, `n=${kinds.capture.length}`);
  check("capture shells all in agent-exec", kinds.capture.length > 0 && kinds.capture.every(inAgentExec), kinds.capture.map((r) => short(r.cg)).join(","));
  check("validation shells observed", kinds.validation.length >= ROUNDS, `n=${kinds.validation.length}`);
  check("validation shells all in agent-exec", kinds.validation.length > 0 && kinds.validation.every(inAgentExec), kinds.validation.map((r) => short(r.cg)).join(","));
  check("validation shells never seen in gateway", kinds.validation.every((r) => !inGateway(r)));
  check("exec shells all in agent-exec", kinds.exec.length > 0 && kinds.exec.every(inAgentExec));

  const gwPidAfter = mainPid();
  const gwCgroupAfter = gwPidAfter ? readCgroup(gwPidAfter) : undefined;
  console.log(`PROOF gateway after cgroup=${short(gwCgroupAfter)}`);
  check("gateway process remained in the gateway leaf", short(gwCgroupAfter).endsWith("gateway"), short(gwCgroupAfter));

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`PROOF VERDICT: ${failed.length === 0 ? "PASS" : "FAIL"}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`PROOF fatal: ${error?.stack ?? error}`);
  console.log("PROOF VERDICT: FAIL");
  process.exitCode = 1;
});
