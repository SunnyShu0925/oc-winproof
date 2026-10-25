// Hold an EXCLUSIVE write lock on the openclaw state sqlite db for N seconds,
// simulating a sibling daemon holding a write transaction (causes SQLITE_BUSY).
// Usage: node hold-exclusive-lock.cjs <dbPath> <seconds>
const { DatabaseSync } = require("node:sqlite");
const dbPath = process.argv[2];
const seconds = Number(process.argv[3] || 10);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=DELETE");
db.exec("BEGIN EXCLUSIVE");
console.log("[lock] EXCLUSIVE write lock acquired on " + dbPath + " for " + seconds + "s");
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  // keep the lock held; spin to avoid exit
  require("node:child_process").execSync("ping -n 1 127.0.0.1 >NUL", { stdio: "ignore" });
}
db.exec("ROLLBACK");
db.close();
console.log("[lock] released");
