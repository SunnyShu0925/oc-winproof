// Mirrors the PR #201707 production diff (src/plugins/plugin-peer-link.ts) into the
// published openclaw dist chunk, then recomputes the dist content inventory entry.
// Usage: node mirror-patch.mjs <packageDir>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const packageDir = process.argv[2];
if (!packageDir) {
  console.error("usage: node mirror-patch.mjs <packageDir>");
  process.exit(2);
}
const distDir = path.join(packageDir, "dist");

function findChunk(prefix) {
  const hits = readdirSync(distDir).filter((f) => f.startsWith(prefix) && f.endsWith(".mjs"));
  if (hits.length !== 1) throw new Error(`expected exactly one ${prefix}*.mjs chunk, got ${hits.length}`);
  return path.join(distDir, hits[0]);
}

function replaceOnce(text, anchor, replacement, label) {
  const first = text.indexOf(anchor);
  if (first === -1) throw new Error(`anchor not found: ${label}`);
  if (text.indexOf(anchor, first + 1) !== -1) throw new Error(`anchor not unique: ${label}`);
  return text.slice(0, first) + replacement + text.slice(first + anchor.length);
}

const peerChunk = findChunk("plugin-peer-link-");
const caseChunk = findChunk("path-case-");
const caseChunkName = path.basename(caseChunk);

// Confirm the case chunk exports sameFsObject and resolve its minified alias.
const caseSrc = readFileSync(caseChunk, "utf8");
if (!/function sameFsObject\(/.test(caseSrc)) throw new Error("sameFsObject not present in path-case chunk");
const exportMatch = caseSrc.match(/export\s*\{([^}]+)\}/);
if (!exportMatch) throw new Error("no export statement in path-case chunk");
let alias = null;
for (const part of exportMatch[1].split(",")) {
  const m = part.trim().match(/^sameFsObject\s+as\s+([A-Za-z0-9_$]+)$/);
  if (m) alias = m[1];
  if (part.trim() === "sameFsObject") alias = "sameFsObject";
}
if (!alias) throw new Error("sameFsObject is not exported from path-case chunk");
console.log(`[mirror] path-case chunk: ${caseChunkName}, sameFsObject alias: ${alias}`);

let src = readFileSync(peerChunk, "utf8");
const before = createHash("sha256").update(src).digest("hex");

// Edit 1: add statSync to the node:fs import (anchor on the exact published import line).
const fsImport = src.match(/^import \{([^}]*)\} from "node:fs";$/m);
if (!fsImport) throw new Error("node:fs import line not found");
if (/\bstatSync\b/.test(fsImport[1])) throw new Error("statSync already imported");
src = replaceOnce(
  src,
  fsImport[0],
  `import {${fsImport[1].trimEnd()}, statSync } from "node:fs";`,
  "node:fs import",
);

// Edit 2: import sameFsObject from the sibling path-case chunk.
const importAnchor = 'import path from "node:path";';
src = replaceOnce(
  src,
  importAnchor,
  `import { ${alias} as sameFsObject } from "./${caseChunkName}";\n${importAnchor}`,
  "path-case import insertion point",
);

// Edit 3: identity check at the top of the try block inside openClawHostRootsMatch only.
const fnAnchor = "function openClawHostRootsMatch(e, t) {";
const fnStart = src.indexOf(fnAnchor);
if (fnStart === -1) throw new Error("openClawHostRootsMatch(e, t) not found");
if (src.indexOf(fnAnchor, fnStart + 1) !== -1) throw new Error("openClawHostRootsMatch not unique");
const fnEnd = src.indexOf("\nfunction ", fnStart + fnAnchor.length);
const region = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
const tryAnchor = "\ttry {\n";
const tryPos = region.indexOf(tryAnchor);
if (tryPos === -1) throw new Error("try block not found inside openClawHostRootsMatch");
if (region.indexOf(tryAnchor, tryPos + 1) !== -1) throw new Error("multiple try blocks in function region");
const patchedRegion =
  region.slice(0, tryPos + tryAnchor.length) +
  "\t\tif (sameFsObject(statSync(n), statSync(r))) return true;\n" +
  region.slice(tryPos + tryAnchor.length);
src = src.slice(0, fnStart) + patchedRegion + src.slice(fnStart + region.length);

writeFileSync(peerChunk, src);
const check = spawnSync(process.execPath, ["--check", peerChunk], { encoding: "utf8" });
if (check.status !== 0) {
  console.error(check.stderr);
  throw new Error("node --check failed on patched chunk");
}
const after = createHash("sha256").update(readFileSync(peerChunk)).digest("hex");
console.log(`[mirror] patched ${path.basename(peerChunk)}`);
console.log(`[mirror] sha256 before: ${before}`);
console.log(`[mirror] sha256 after:  ${after}`);

// Recompute the inventory entry for the patched chunk (self-excluding manifest, path-sorted list).
const inventoryPath = path.join(distDir, "postinstall-content-inventory.json");
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
const relPath = `dist/${path.basename(peerChunk)}`;
const entries = inventory.filter((e) => e.path === relPath);
if (entries.length !== 1) throw new Error(`expected one inventory entry for ${relPath}, got ${entries.length}`);
const st = statSync(peerChunk);
entries[0].sha256 = after;
entries[0].size = st.size;
entries[0].mode = st.mode & 0o7777;
writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`[mirror] inventory entry updated: ${relPath} size=${st.size} mode=${entries[0].mode}`);
console.log("[mirror] patched function region:");
console.log(patchedRegion);