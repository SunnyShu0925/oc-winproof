// Task-owned trust anchor for the local WhatsApp Web protocol peer (PR 193311).
//
// The shipped Baileys client verifies the peer's Noise certificate chain against
// WhatsApp's pinned long-term key (node_modules/baileys/lib/Utils/noise-handler.js
// -> WA_CERT_DETAILS.PUBLIC_KEY). No local peer can present a chain signed by
// that key, so the proof swaps the pinned trust anchor for a task-owned one in
// the local node_modules copy, exactly like pointing an HTTPS client at a
// task-owned CA. No shipped source is modified; `restore` puts WhatsApp's pinned
// key back.
//
// usage: node anchor-trust.mjs generate <anchorFile>
//        node anchor-trust.mjs apply <anchorFile>
//        node anchor-trust.mjs restore
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.PROOF_REPO_ROOT ?? process.cwd();
const DEFAULTS = path.join(ROOT, "node_modules/baileys/lib/Defaults/index.js");
const STALE_BACKUP = `${DEFAULTS}.pr193311.bak`;
const WHATSAPP_PINNED_PUBLIC_KEY =
  "142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b";
const KEY_PATTERN = /PUBLIC_KEY: Buffer\.from\('[0-9a-f]{64}', 'hex'\)/;
const mod = (rel) =>
  import(pathToFileURL(path.join(ROOT, "node_modules/baileys", rel)).href);

const [, , command, arg] = process.argv;

if (command === "generate") {
  const { Curve } = await mod("lib/Utils/crypto.js");
  const anchor = Curve.generateKeyPair();
  const intermediate = Curve.generateKeyPair();
  fs.writeFileSync(
    arg,
    JSON.stringify(
      {
        note: "task-owned trust anchor for the local WhatsApp Web protocol peer",
        anchorPublic: anchor.public.toString("base64"),
        anchorPrivate: anchor.private.toString("base64"),
        intermediatePublic: intermediate.public.toString("base64"),
        intermediatePrivate: intermediate.private.toString("base64"),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  process.stdout.write(`PROOF anchor generated -> ${arg}\n`);
} else if (command === "apply") {
  const anchor = JSON.parse(fs.readFileSync(arg, "utf8"));
  const anchorPublicHex = Buffer.from(anchor.anchorPublic, "base64").toString("hex");
  const source = fs.readFileSync(DEFAULTS, "utf8");
  if (!KEY_PATTERN.test(source)) {
    throw new Error("pinned trust anchor not found in Defaults/index.js");
  }
  const patched = source.replace(
    KEY_PATTERN,
    `PUBLIC_KEY: Buffer.from('${anchorPublicHex}', 'hex')`,
  );
  fs.writeFileSync(DEFAULTS, patched);
  fs.rmSync(STALE_BACKUP, { force: true });
  process.stdout.write(`PROOF trust anchor applied ${anchorPublicHex}\n`);
} else if (command === "restore") {
  const source = fs.readFileSync(DEFAULTS, "utf8");
  const restored = source.replace(
    KEY_PATTERN,
    `PUBLIC_KEY: Buffer.from('${WHATSAPP_PINNED_PUBLIC_KEY}', 'hex')`,
  );
  fs.writeFileSync(DEFAULTS, restored);
  fs.rmSync(STALE_BACKUP, { force: true });
  process.stdout.write("PROOF trust anchor restored\n");
} else {
  throw new Error("usage: anchor-trust.mjs generate|apply|restore [anchorFile]");
}
