// Print the current journal_mode of the openclaw state sqlite db.
// Usage: node journal-check.cjs <dbPath> [label]
const { DatabaseSync } = require("node:sqlite");
const path = process.argv[2];
const label = process.argv[3] || "";
try {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("PRAGMA journal_mode;").get();
  console.log(`[journal-check]${label ? " " + label : ""} journal_mode=${JSON.stringify(row)}`);
  db.close();
} catch (e) {
  console.log(`[journal-check]${label ? " " + label : ""} ERROR ${e.message}`);
}
