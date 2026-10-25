// proof-183002-holder.ts — 子进程：在真实状态 SQLite 库上持有 BEGIN EXCLUSIVE 写锁
// 供 proof-183002-windows.ts 触发真实的 SQLite 共享/写锁错误（SQLITE_BUSY）。
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];
const holdMs = Number(process.argv[3] ?? 8_000);
if (!dbPath) {
  console.error("usage: proof-183002-holder.ts <dbPath> [holdMs]");
  process.exit(2);
}

const db = new DatabaseSync(dbPath);
// 不自带 busy_timeout 等待：独占锁必须立刻拿到，否则证明脚本会等太久。
db.exec("PRAGMA busy_timeout=0;");
db.exec("BEGIN EXCLUSIVE");
console.log(`[holder] acquired EXCLUSIVE write lock on ${dbPath}, holding ${holdMs}ms...`);
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
  console.log("[holder] released lock");
  process.exit(0);
}, holdMs);
setTimeout(() => {
  console.error("[holder] timed out holding lock");
  process.exit(1);
}, holdMs + 5_000);
