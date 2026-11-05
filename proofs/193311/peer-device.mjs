// A second, independent WhatsApp device that lives inside the local protocol
// peer (PR 193311). It owns real Signal state (identity key, signed prekey, one
// time prekey, session + sender-key stores) and decrypts the stanzas the client
// actually encrypted, using Baileys' own receive-side decryption code.
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.PROOF_REPO_ROOT ?? process.cwd();
const BAILEYS_LIB = path.join(ROOT, "node_modules/baileys/lib");
const mod = (rel) => import(pathToFileURL(path.join(BAILEYS_LIB, rel)).href);

const { initAuthCreds } = await mod("index.js");
// The repository factory is not a named export; Baileys injects it through
// DEFAULT_CONNECTION_CONFIG.makeSignalRepository, which is the same function.
const { DEFAULT_CONNECTION_CONFIG } = await mod("Defaults/index.js");
const makeLibSignalRepository = DEFAULT_CONNECTION_CONFIG.makeSignalRepository;
const { Curve } = await mod("Utils/crypto.js");
const { decryptMessageNode } = await mod("Utils/decode-wa-message.js");

const quietLogger = {
  level: "silent",
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quietLogger;
  },
};

// Baileys' key store contract: get(type, ids) -> { id: value }, set({ type: { id: value } })
// with null meaning delete, plus transaction(fn) for atomic read-modify-write.
function makeMemoryKeyStore() {
  const entries = new Map();
  const keyOf = (type, id) => `${type}:${id}`;
  return {
    async get(type, ids) {
      const out = {};
      for (const id of ids) {
        const value = entries.get(keyOf(type, id));
        if (value !== undefined) out[id] = value;
      }
      return out;
    },
    async set(payload) {
      for (const [type, values] of Object.entries(payload)) {
        for (const [id, value] of Object.entries(values)) {
          if (value === null) entries.delete(keyOf(type, id));
          else entries.set(keyOf(type, id), value);
        }
      }
    },
    async transaction(fn) {
      return fn();
    },
  };
}

const uintNode = (tag, value, byteLength) => {
  const buffer = Buffer.alloc(byteLength);
  if (byteLength === 4) buffer.writeUInt32BE(value >>> 0);
  else buffer.writeUIntBE(value >>> 0, 0, byteLength);
  return { tag, attrs: {}, content: buffer };
};

export async function makePeerDevice({ meJid, log }) {
  const creds = initAuthCreds();
  creds.me = { id: meJid, name: "proof peer device" };
  creds.registered = true;
  const keys = makeMemoryKeyStore();
  const repository = makeLibSignalRepository({ creds, keys }, quietLogger, async () => []);

  // One-time prekey advertised in the bundle the client fetches.
  const oneTimePreKeyId = 1;
  const oneTimePreKey = Curve.generateKeyPair();
  await keys.set({
    "pre-key": {
      [oneTimePreKeyId]: { private: oneTimePreKey.private, public: oneTimePreKey.public },
    },
  });

  return {
    meJid,
    repository,
    // <list><user jid=...> bundle the client's assertSessions() expects.
    preKeyBundleNode(jid) {
      const { signedIdentityKey, signedPreKey, registrationId } = creds;
      return {
        tag: "user",
        attrs: { jid },
        content: [
          { tag: "registration", attrs: {}, content: uintNode("v", registrationId, 4).content },
          { tag: "identity", attrs: {}, content: signedIdentityKey.public },
          {
            tag: "skey",
            attrs: {},
            content: [
              uintNode("id", signedPreKey.keyId, 3),
              { tag: "value", attrs: {}, content: signedPreKey.keyPair.public },
              { tag: "signature", attrs: {}, content: signedPreKey.signature },
            ],
          },
          {
            tag: "key",
            attrs: {},
            content: [
              uintNode("id", oneTimePreKeyId, 3),
              { tag: "value", attrs: {}, content: oneTimePreKey.public },
            ],
          },
        ],
      };
    },
    // The server rewrites an outgoing group stanza into the form each recipient
    // receives: from=group, participant=sender, and the per-device <to> node's
    // enc children promoted to the top level next to the group skmsg.
    async decryptDelivered(stanza, { fromJid, participantJid }) {
      const content = Array.isArray(stanza.content) ? stanza.content : [];
      const participants = content.find((child) => child?.tag === "participants");
      const toNode = (participants?.content ?? []).find(
        (child) => child?.tag === "to" && child.attrs?.jid === meJid,
      );
      const deliveredEnc = (toNode?.content ?? []).filter((child) => child?.tag === "enc");
      const groupEnc = content.filter((child) => child?.tag === "enc");
      // A device that already holds the group sender key receives only the group
      // skmsg; WhatsApp stops fanning out a pkmsg per device once the sender key
      // is distributed, so an skmsg alone is a complete delivery.
      const hasGroupSenderKey = groupEnc.some((child) => child?.attrs?.type === "skmsg");
      if (!deliveredEnc.length && !hasGroupSenderKey) {
        return { ok: false, reason: `no enc node addressed to ${meJid} and no group sender key message` };
      }
      const delivered = {
        tag: "message",
        attrs: {
          id: stanza.attrs.id,
          type: stanza.attrs.type ?? "text",
          from: fromJid,
          participant: participantJid,
          to: meJid,
          t: stanza.attrs.t ?? String(Math.floor(Date.now() / 1000)),
        },
        content: [...deliveredEnc, ...groupEnc],
      };
      const decoded = decryptMessageNode(delivered, meJid, undefined, repository, quietLogger);
      await decoded.decrypt();
      const message = decoded.fullMessage.message;
      if (!message) {
        return {
          ok: false,
          reason: `decrypt produced no message (stub ${decoded.fullMessage.messageStubType ?? "none"}: ${
            decoded.fullMessage.messageStubParameters?.join(", ") ?? "-"
          })`,
        };
      }
      return { ok: true, message, encTypes: [...deliveredEnc, ...groupEnc].map((n) => n.attrs.type) };
    },
  };
}
