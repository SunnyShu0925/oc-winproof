// Debug/standalone probe: real Baileys client against the local protocol peer.
// usage: node probe-socket.mjs <authDir> <wsUrl>
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.PROOF_REPO_ROOT ?? process.cwd();
const baileys = await import(
  pathToFileURL(path.join(ROOT, "node_modules/baileys/lib/index.js")).href
);

const [, , authDir, wsUrl] = process.argv;
if (!authDir || !wsUrl) {
  throw new Error("usage: probe-socket.mjs <authDir> <wsUrl>");
}

const GROUP_JID = process.env.PROOF_GROUP_JID ?? "120363000000000001@g.us";

const makeLogger = () => {
  const logger = {
    level: process.env.PROOF_LOG_LEVEL ?? "warn",
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
};

const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir);
const sock = baileys.makeWASocket({
  auth: { creds: state.creds, keys: baileys.makeCacheableSignalKeyStore(state.keys) },
  version: [2, 3000, 1043857760],
  logger: makeLogger(),
  printQRInTerminal: false,
  browser: ["openclaw", "cli", "proof"],
  syncFullHistory: false,
  markOnlineOnConnect: false,
  waWebSocketUrl: wsUrl,
});

sock.ev.on("creds.update", () => {
  void saveCreds();
});

const opened = new Promise((resolve) => {
  sock.ev.on("connection.update", (update) => {
    process.stdout.write(`PROBE connection.update ${JSON.stringify(update)}\n`);
    if (update.connection === "open") {
      resolve();
    }
  });
});

const timeout = new Promise((_, reject) =>
  setTimeout(() => reject(new Error("probe timed out waiting for connection open")), 60_000),
);

await Promise.race([opened, timeout]);
process.stdout.write("PROBE connected through the real Baileys client\n");

const started = Date.now();
const all = await sock.groupFetchAllParticipating();
process.stdout.write(
  `PROBE groupFetchAllParticipating ms=${Date.now() - started} groups=${Object.keys(all).length}\n`,
);
for (const [jid, meta] of Object.entries(all)) {
  process.stdout.write(
    `PROBE participating ${jid} subject=${JSON.stringify(meta.subject)} participants=${(meta.participants ?? []).map((p) => p.id).join(",")}\n`,
  );
}

const startedMeta = Date.now();
const meta = await sock.groupMetadata(GROUP_JID);
process.stdout.write(
  `PROBE groupMetadata ms=${Date.now() - startedMeta} jid=${meta.id} subject=${JSON.stringify(meta.subject)} participants=${meta.participants.map((p) => p.id).join(",")}\n`,
);

if (process.env.PROOF_SEND_TEXT) {
  const mentions = (process.env.PROOF_SEND_MENTIONS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  try {
    const sent = await sock.sendMessage(GROUP_JID, {
      text: process.env.PROOF_SEND_TEXT,
      ...(mentions.length ? { mentions } : {}),
    });
    process.stdout.write(
      `PROBE sendMessage ok id=${sent?.key?.id} remoteJid=${sent?.key?.remoteJid}\n`,
    );
  } catch (error) {
    process.stdout.write(`PROBE sendMessage failed: ${error?.message ?? error}\n`);
  }
}

await sock.end(undefined);
process.stdout.write("PROBE done\n");
process.exit(0);
