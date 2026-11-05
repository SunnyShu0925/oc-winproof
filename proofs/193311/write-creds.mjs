// Writes a synthetic Baileys multi-file auth state so the shipped WhatsApp
// channel starts as an already-linked account. No real device is paired and no
// real WhatsApp credentials are used: key material is generated locally.
import fs from "node:fs";
import path from "node:path";
import { BufferJSON, initAuthCreds } from "baileys";

const authDir = process.argv[2];
if (!authDir) {
  throw new Error("usage: write-creds.mjs <authDir>");
}
const selfJid = process.env.PROOF_SELF_JID ?? "15550000001@s.whatsapp.net";

const creds = initAuthCreds();
creds.registered = true;
creds.me = {
  id: selfJid,
  name: "Proof SUT",
  verifiedName: "Proof SUT",
};

fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
const target = path.join(authDir, "creds.json");
fs.writeFileSync(target, JSON.stringify(creds, BufferJSON.replacer), { mode: 0o600 });
process.stdout.write(`PROOF wrote synthetic Baileys creds ${target} me=${creds.me.id}\n`);
