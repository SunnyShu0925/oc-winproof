// Hold a real EXCLUSIVE write lock on the openclaw state sqlite db for N
// seconds, simulating a sibling daemon holding a write transaction.
// Usage: node hold-exclusive-lock.cjs <dbPath> <seconds>
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2];
const seconds = Number(process.argv[3] || 10);
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode=DELETE");
db.exec("BEGIN EXCLUSIVE");
console.log("[lock] EXCLUSIVE write lock acquired on " + dbPath + " for " + seconds + "s");

const end = Date.now() + seconds * 1000;
const wait = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < end) {
  Atomics.wait(wait, 0, 0, 100);
}

db.exec("ROLLBACK");
db.close();
console.log("[lock] released");
