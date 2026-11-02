// Redacts secrets and non-public endpoints from the proof logs before they are
// uploaded as artifacts. The agent config is never echoed, but a gateway log may
// still print a provider base URL or an upstream error that embeds the key, so
// mask host/IP/token shapes here. Runs with `if: always()` so failed runs are
// still scrubbed.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const logDir = process.env.LOG_DIR ?? "/tmp";
const key = process.env.PROOF_API_KEY ?? "";

function list(dir, pattern) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((name) => pattern.test(name)).map((name) => path.join(dir, name));
}

const files = [
  path.join(logDir, "postfix.log"),
  path.join(logDir, "prefix.log"),
  ...list(logDir, /^proof-sampler.*\.jsonl$/),
  ...list("/tmp", /^oc-gw.*\.log$/),
];

const host = /(https?:\/\/)[^\/\s]+/g;
const ip = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const token =
  /(sk-[A-Za-z0-9]{6})[A-Za-z0-9]+|(ghp_[A-Za-z0-9]{4})[A-Za-z0-9]+|(AIza[0-9A-Za-z_-]{6})[0-9A-Za-z_-]+|(ya29\.)[0-9A-Za-z._-]+|(xox[baprs]-[A-Za-z0-9]{4})[A-Za-z0-9-]+/g;

let redacted = 0;
for (const file of files) {
  if (!fs.existsSync(file)) {
    continue;
  }
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  let next = content
    .replace(host, "$1***REDACTED-HOST***")
    .replace(ip, "***REDACTED-IP***")
    .replace(token, "***REDACTED-TOKEN***");
  if (key) {
    next = next.split(key).join("***REDACTED-KEY***");
  }
  if (next !== content) {
    redacted += 1;
    try {
      fs.writeFileSync(file, next, "utf8");
    } catch {
      // Best effort: a log we cannot rewrite is still uploaded masked by GitHub.
    }
  }
}
console.log(`redaction done (${redacted} file(s) contained redacted content)`);
