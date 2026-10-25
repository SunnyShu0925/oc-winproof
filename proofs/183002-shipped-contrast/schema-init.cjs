// Initialize the openclaw state sqlite db with the real state_leases schema.
// Usage: node schema-init.cjs <dbPath>
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2]);
db.exec(
  "PRAGMA journal_mode=DELETE;" +
    "CREATE TABLE IF NOT EXISTS state_leases (" +
    " scope TEXT NOT NULL," +
    " lease_key TEXT NOT NULL," +
    " owner TEXT NOT NULL," +
    " expires_at INTEGER," +
    " heartbeat_at INTEGER," +
    " payload_json TEXT," +
    " created_at INTEGER NOT NULL," +
    " updated_at INTEGER NOT NULL," +
    " PRIMARY KEY (scope, lease_key)" +
    ");"
);
console.log("[schema-init] state_leases ready at " + process.argv[2]);
db.close();
