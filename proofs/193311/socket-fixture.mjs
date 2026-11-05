// Local WhatsApp Web peer for the PR 193311 proof.
//
// The shipped Gateway boots the shipped WhatsApp channel plugin, which builds a
// real Baileys socket config (cachedGroupMetadata, getMessage, ...) and runs the
// shipped inbound monitor, group metadata cache owner, and outbound send path.
// Only the socket factory is local: no paired WhatsApp device is available, so
// this module stands in for the WhatsApp Web peer.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

const GROUP_JID = process.env.PROOF_GROUP_JID ?? "120363000000000001@g.us";
const SELF_JID = process.env.PROOF_SELF_JID ?? "15550000001:1@s.whatsapp.net";
const STEP_MS = Number(process.env.PROOF_STEP_MS ?? 60_000);
const WAIT_MS = Number(process.env.PROOF_WAIT_MS ?? 301_000);
const OUT_DIR = process.env.PROOF_DIR ?? "/tmp/proof-193311";

const OLD_PARTICIPANTS = [
  { id: "15550000111@s.whatsapp.net", admin: null },
  { id: "15550000222@s.whatsapp.net", admin: null },
];
const NEW_PARTICIPANT = { id: "15550000333@s.whatsapp.net", admin: null };

function log(line) {
  process.stdout.write(`PROOF ${line}\n`);
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

export function createFixtureMakeWASocket(realBaileys) {
  return function makeWASocketFake(config = {}) {
    ensureOutDir();
    const ev = new EventEmitter();
    const ws = new EventEmitter();
    ws.isOpen = true;
    ws.isClosed = false;
    ws.readyState = 1;
    ws.send = () => {};
    ws.close = () => {
      ws.isOpen = false;
      log("fixture ws.close()");
    };
    ws.terminate = () => {};

    const state = {
      groupMetadataCalls: 0,
      sends: 0,
      rosterRenamed: false,
      stepped: false,
      probed: false,
      unknownMembers: new Set(),
    };

    const socketConfigKeys = Object.keys(config).toSorted();
    log(
      `fixture makeWASocket configKeys=${socketConfigKeys.join(",")} realMakeWASocket=${typeof realBaileys?.makeWASocket} realExports=${Object.keys(realBaileys ?? {}).length}`,
    );
    log(
      `fixture baileys socket options cachedGroupMetadata=${typeof config.cachedGroupMetadata} getMessage=${typeof config.getMessage} version=${JSON.stringify(config.version ?? null)}`,
    );

    const currentParticipants = () =>
      state.rosterRenamed ? [...OLD_PARTICIPANTS, NEW_PARTICIPANT] : [...OLD_PARTICIPANTS];

    const groupMetadataValue = (jid) => ({
      id: jid,
      subject: state.rosterRenamed ? "Proof Group (renamed)" : "Proof Group",
      owner: undefined,
      participants: currentParticipants(),
      announce: false,
      restrict: false,
      isCommunity: false,
      isCommunityAnnounce: false,
      creation: 1_700_000_000,
    });

    const probe = async (reason) => {
      if (state.probed) {
        return;
      }
      state.probed = true;
      const cachedGroupMetadata = config.cachedGroupMetadata;
      const cached = cachedGroupMetadata ? await cachedGroupMetadata(GROUP_JID) : undefined;
      const participants = cached?.participants?.map((participant) => participant.id) ?? [];
      log(
        `probe ${reason} cachedGroupMetadata(${GROUP_JID}) -> ${
          cached ? `metadata subject=${JSON.stringify(cached.subject)} participants=[${participants.join(",")}]` : "undefined"
        } (groupMetadata socket calls so far: ${state.groupMetadataCalls})`,
      );
      fs.writeFileSync(path.join(OUT_DIR, "send-ready"), `${Date.now()}\n`);
    };

    const afterHydration = () => {
      setTimeout(() => {
        if (state.stepped) {
          return;
        }
        state.stepped = true;
        const step = globalThis.__proofWallClock?.stepBack;
        if (typeof step === "function") {
          step(STEP_MS);
        } else {
          log("fixture warning: wall clock control missing");
        }
        state.rosterRenamed = true;
        log(
          `fixture roster changed in the peer only: subject="Proof Group (renamed)" participants=[${currentParticipants()
            .map((participant) => participant.id)
            .join(",")}] (no group event emitted; cached entry stays as hydrated)`,
        );
        setTimeout(() => {
          void probe(`after ${WAIT_MS}ms real elapsed`);
        }, WAIT_MS);
      }, 1_500);
    };

    const socket = {
      type: "baileys-fixture",
      ev,
      ws,
      user: { id: SELF_JID, name: "Proof SUT", lid: undefined, phoneNumber: undefined },
      authState: { creds: { accountSyncCounter: 0, registered: true }, keys: {} },
      logger: { level: "silent", trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => socket.logger },
      signalRepository: {
        lidMapping: {
          getPNForLID: async () => null,
          getLIDForPN: async () => null,
          storeLIDPNMapping: async () => {},
          storeLIDMapping: async () => {},
        },
      },
      groupMetadata: async (jid) => {
        state.groupMetadataCalls += 1;
        const meta = groupMetadataValue(jid);
        log(
          `fixture socket.groupMetadata(${jid}) call#${state.groupMetadataCalls} -> subject=${JSON.stringify(
            meta.subject,
          )} participants=[${meta.participants.map((participant) => participant.id).join(",")}]`,
        );
        return meta;
      },
      groupFetchAllParticipating: async () => {
        const groups = { [GROUP_JID]: groupMetadataValue(GROUP_JID) };
        log(
          `fixture socket.groupFetchAllParticipating() -> ${GROUP_JID} subject=${JSON.stringify(
            groups[GROUP_JID].subject,
          )} participants=[${groups[GROUP_JID].participants
            .map((participant) => participant.id)
            .join(",")}]`,
        );
        afterHydration();
        return groups;
      },
      sendMessage: async (jid, content, options) => {
        state.sends += 1;
        log(
          `fixture socket.sendMessage to=${jid} text=${JSON.stringify(content?.text ?? null)} mentionedJids=${JSON.stringify(
            content?.mentions ?? [],
          )} sendOptions=${options ? JSON.stringify(Object.keys(options)) : "none"} performanceNow=${Math.round(
            performance.now(),
          )}ms`,
        );
        return {
          key: { id: `PROOFMSG${state.sends}`, remoteJid: jid, fromMe: true },
          message: {},
          messageTimestamp: Math.floor(Date.now() / 1000),
        };
      },
      sendPresenceUpdate: async () => {},
      presenceSubscribe: async () => {},
      readMessages: async () => {},
      sendReceipt: async () => {},
      updateMediaMessage: async () => ({}) ,
      fetchAccountReachoutTimelock: async () => ({ isActive: false }),
      profilePictureUrl: async () => undefined,
      fetchStatus: async () => undefined,
      fetchBlocklist: async () => [],
      getBusinessProfile: async () => undefined,
      onWhatsApp: async (numbers) => numbers.map(() => undefined),
      logout: async () => {
        log("fixture socket.logout()");
      },
      end: (error) => {
        log(`fixture socket.end(${error === undefined ? "no-error" : String(error)})`);
      },
      close: () => {
        log("fixture socket.close()");
      },
      requestPairingCode: async () => "PROOF-PAIRING",
      chatModify: async () => {},
      sendReceipts: async () => {},
      updateProfilePicture: async () => {},
    };

    const proxy = new Proxy(socket, {
      get(target, property, receiver) {
        if (property in target || typeof property === "symbol") {
          return Reflect.get(target, property, receiver);
        }
        if (property === "then" || property === "toJSON" || property === "inspect") {
          return undefined;
        }
        if (!state.unknownMembers.has(property)) {
          state.unknownMembers.add(property);
          log(`fixture unhandled socket member accessed: ${String(property)}`);
        }
        return async () => undefined;
      },
    });

    setTimeout(() => {
      ev.emit("connection.update", { connection: "open", isNewLogin: false });
      log(`fixture emitted connection.update open user=${SELF_JID}`);
    }, 400);

    // Baileys calls back into cachedGroupMetadata when the plugin asks for group
    // metadata; keep the owner alive for the probe.
    void config;
    return proxy;
  };
}
