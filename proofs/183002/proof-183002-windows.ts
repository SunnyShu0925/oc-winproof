// proof-183002-windows.ts — PR #183002 真实行为证明（Windows GHA runner）
//
// 场景：真实 Windows 上，scheduler 生命周期通过 retryScheduledTaskLeaseRead
// 读取真实状态 SQLite 库的 gateway-owner lease。此时一个兄弟进程对同一库
// 持有真实的 BEGIN EXCLUSIVE 写锁（Windows 上 scheduler 与 Gateway 共享状态库，
// 可能未映射共享内存 → 真实 SQLITE_BUSY / IOERR_TRUNCATE）。
//
// 步骤：
//   1) 用真实 schema 建一个状态 SQLite 库（journal_mode=DELETE，写锁会阻塞读）
//   2) 子进程对库持有 BEGIN EXCLUSIVE 写锁 ~8s（产生真实 SQLITE_BUSY）
//   3) 通过 shipped 的 retryScheduledTaskLeaseRead 包装 shipped 的
//      readGatewayOwnerLease 重试读取
//   4) 可选：PROOF_JUMP_MS>0 时仅把墙钟 Date.now 前跳（模拟 Windows NTP 校时），
//      单调钟 performance.now 不受影响
//
// 预期：
//   - post-fix（performance.now 单调 deadline）：锁在重试期间释放 → 重试成功，
//     墙钟前跳不影响 15s 单调预算
//   - pre-fix（Date.now 墙钟 deadline）：墙钟前跳使 Date.now()>=deadline →
//     第一次失败后立即放弃，健康 lease 被丢弃
//
// 用法（在 openclaw worktree 根目录，Windows runner）：
//   node --import tsx/esm proof-183002-windows.ts            # control
//   PROOF_JUMP_MS=20000 node --import tsx/esm proof-183002-windows.ts
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawStateSqlitePath } from "./src/state/openclaw-state-db.paths.js";
import { readGatewayOwnerLease } from "./src/infra/gateway-owner-lease.js";
import { retryScheduledTaskLeaseRead } from "./src/daemon/schtasks-sqlite.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stateDir = join(process.cwd(), ".proof-183002-state");
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });
const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
const dbPath = resolveOpenClawStateSqlitePath(env);
mkdirSync(join(stateDir, "state"), { recursive: true });

// 1) 真实 schema 状态库（DELETE journal：独占写锁会阻塞读 → 真实 SQLITE_BUSY）
{
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE state_leases (
      scope TEXT NOT NULL,
      lease_key TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at INTEGER,
      heartbeat_at INTEGER,
      payload_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, lease_key)
    );
  `);
  db.close();
}
console.log(`[proof] state db ready: ${dbPath} (journal_mode=DELETE)`);

// 2) 子进程持真实 EXCLUSIVE 写锁
const holderScript = fileURLToPath(new URL("./proof-183002-holder.ts", import.meta.url));
const holder = spawn(process.execPath, ["--import", "tsx/esm", holderScript, dbPath, String(8_000)], {
  stdio: "inherit",
  env,
});
await sleep(1_500);

// 3) 可选：模拟 Windows NTP 校时——在第一次 reader 尝试时把墙钟 Date.now 前跳。
//    retryScheduledTaskLeaseRead 的 deadline 在校时前已用原始墙钟算好，因此前跳只让
//    Date.now() 变大（不影响单调钟 performance.now()），正是真实校时触发的场景。
const jumpMs = Number(process.env.PROOF_JUMP_MS ?? 0);
const realDateNow = Date.now;
let jumped = false;
const reader = (): unknown => {
  if (jumpMs > 0 && !jumped) {
    jumped = true;
    Date.now = () => realDateNow() + jumpMs;
    console.log(`[proof] wall-clock jumped forward by +${jumpMs}ms during first reader attempt (Date.now only)`);
  }
  return readGatewayOwnerLease({ env });
};

// 本地验证开关（仅用于 Linux 开发机校验 win32 重试逻辑；Windows GHA 上不使用）。
if (process.env.PROOF_FORCE_WIN32 === "1") {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  console.log("[proof] NOTE: forced process.platform=win32 for local logic validation only");
}

// 4) shipped 重试包装 shipped 真实读取器
console.log("[proof] reading gateway-owner lease via retryScheduledTaskLeaseRead(readGatewayOwnerLease)...");
const t0 = performance.now();
let lease: unknown;
try {
  lease = await retryScheduledTaskLeaseRead(reader);
  const elapsed = Math.round(performance.now() - t0);
  console.log(`[proof] RESULT=SUCCESS lease=${lease === undefined ? "undefined" : JSON.stringify(lease)} monotonicElapsedMs=${elapsed}`);
} catch (error) {
  const elapsed = Math.round(performance.now() - t0);
  const err = error as Error & { errcode?: number };
  console.log(`[proof] RESULT=FAILED err=${err.message} errcode=${err.errcode ?? "n/a"} monotonicElapsedMs=${elapsed}`);
}

// 恢复墙钟（避免影响后续输出）
Date.now = realDateNow;

holder.kill();
process.exit(0);
