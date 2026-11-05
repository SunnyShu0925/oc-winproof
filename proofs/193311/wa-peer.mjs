// Local WhatsApp Web protocol peer for PR 193311.
//
// This is a real protocol endpoint, not a JavaScript stand-in for the Baileys
// socket: the shipped WhatsApp channel opens an actual WebSocket to it and the
// real Baileys client performs the Noise XX handshake, WA binary-node framing
// and group metadata IQs over that socket. The peer implements the server side
// with the same primitives Baileys ships (Curve, hkdf, AES-GCM, WABinary,
// WAProto), so the client code under test is unmodified Baileys code.
//
// The one deviation from WhatsApp's production endpoint: the certificate chain
// is signed by a task-owned anchor instead of WhatsApp's pinned long-term key
// (see anchor-trust.mjs). That is the local-peer equivalent of a task-owned CA
// for an HTTPS fixture.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildCertChainPayload,
  Curve,
  frame,
  makeNoiseServer,
  proto,
} from "./noise-peer.mjs";

const ROOT = process.env.PROOF_REPO_ROOT ?? process.cwd();
const BAILEYS_LIB = path.join(ROOT, "node_modules/baileys/lib");
const mod = (rel) => import(pathToFileURL(path.join(BAILEYS_LIB, rel)).href);
const { encodeBinaryNode } = await mod("WABinary/encode.js");
const { decodeBinaryNode } = await mod("WABinary/decode.js");
const { makePeerDevice } = await import("./peer-device.mjs");
const requireFromRoot = createRequire(path.join(ROOT, "package.json"));
const { WebSocketServer } = requireFromRoot("ws");

const PORT = Number(process.env.PROOF_PEER_PORT ?? 0);
const GROUP_JID = process.env.PROOF_GROUP_JID ?? "120363000000000001@g.us";
const SELF_JID = process.env.PROOF_SELF_JID ?? "15550000001@s.whatsapp.net";
const PEER_JID = process.env.PROOF_PEER_JID ?? "15550000222@s.whatsapp.net";
const NEW_MEMBER_JID = process.env.PROOF_NEW_MEMBER_JID ?? "15550000333@s.whatsapp.net";
const SWAP_FILE = process.env.PROOF_ROSTER_SWAP_FILE ?? "";
const ROSTER_SWAP_AFTER_MS = Number(process.env.PROOF_ROSTER_SWAP_AFTER_MS ?? "45000");

const log = (...args) => process.stdout.write(`PEER ${args.join(" ")}\n`);

let rosterRefreshed = false;
let participatingQueries = 0;
let groupMetadataQueries = 0;

const baseMembers = () => [SELF_JID, PEER_JID];
const members = () =>
  rosterRefreshed ? [...baseMembers(), NEW_MEMBER_JID] : [...baseMembers()];

function refreshRoster(reason) {
  if (rosterRefreshed) return;
  rosterRefreshed = true;
  log(`roster refreshed (${reason}) participants=${members().join(",")}`);
}

if (SWAP_FILE) {
  setInterval(() => {
    try {
      if (fs.existsSync(SWAP_FILE)) refreshRoster(`swap file ${path.basename(SWAP_FILE)}`);
    } catch {}
  }, 250).unref();
}

function groupNode() {
  return {
    tag: "group",
    attrs: {
      id: GROUP_JID,
      subject: rosterRefreshed ? "Proof Group (renamed)" : "Proof Group",
      creation: "1700000000",
      creator: SELF_JID,
      s_t: "1700000000",
    },
    content: members().map((jid) => ({ tag: "participant", attrs: { jid } })),
  };
}

// ------------------------------------------------------------- binary protocol

function makeSession(socket) {
  let inBytes = Buffer.alloc(0);
  let introConsumed = false;
  let noise = null;
  let handshakeDone = false;
  const serverStatic = Curve.generateKeyPair();
  const serverEphemeral = Curve.generateKeyPair();

  const sendFrame = (payload) => {
    const body = handshakeDone || noise?.hasTransport ? noise.encrypt(payload) : payload;
    socket.send(frame(body));
  };
  const sendNode = (node) => sendFrame(encodeBinaryNode(node));

  const iqResult = (request, content) => {
    const attrs = { id: request.attrs.id, type: "result" };
    if (request.attrs.to) {
      attrs.from = request.attrs.to;
    }
    return { tag: "iq", attrs, content };
  };

  const handleIq = async (node) => {
    const attrs = node.attrs ?? {};
    const xmlns = attrs.xmlns ?? "";
    const child = Array.isArray(node.content) ? node.content[0] : undefined;
    log(
      `iq xmlns=${xmlns || "-"} type=${attrs.type ?? "-"} to=${attrs.to ?? "-"} child=${child?.tag ?? "-"} request=${child?.attrs?.request ?? "-"}`,
    );

    if (xmlns === "usync") {
      const usync = child?.tag === "usync" ? child : undefined;
      const protocols = ((usync?.content ?? []).find((c) => c?.tag === "query")?.content ?? [])
        .map((c) => c?.tag)
        .filter(Boolean);
      const listNode = (usync?.content ?? []).find((c) => c?.tag === "list");
      const requested = (listNode?.content ?? [])
        .filter((c) => c?.tag === "user" && c.attrs?.jid)
        .map((c) => c.attrs.jid);
      log(`usync protocols=[${protocols.join(",")}] users=${requested.join(",") || "(none)"}`);
      sendNode(
        iqResult(node, [
          {
            tag: "usync",
            attrs: { context: usync?.attrs?.context ?? "message" },
            content: [
              {
                tag: "list",
                attrs: {},
                content: requested.map((jid) => {
                  const user = jid.split("@")[0].split(":")[0];
                  const children = [];
                  if (protocols.includes("devices")) {
                    children.push({
                      tag: "devices",
                      attrs: {},
                      content: [
                        {
                          tag: "device-list",
                          attrs: {},
                          content: [{ tag: "device", attrs: { id: "0" } }],
                        },
                      ],
                    });
                  }
                  if (protocols.includes("lid")) {
                    children.push({ tag: "lid", attrs: { val: `${user}@lid` } });
                  }
                  return { tag: "user", attrs: { jid }, content: children };
                }),
              },
            ],
          },
        ]),
      );
      return;
    }

    if (xmlns === "encrypt") {
      if (child?.tag === "key") {
        log(`prekey request shape ${JSON.stringify((Array.isArray(child.content) ? child.content : []).map((c) => ({ tag: c?.tag, attrs: c?.attrs, kind: Array.isArray(c?.content) ? "array" : typeof c?.content })))}`);
        const requested = (child.content ?? [])
          .filter((c) => c?.tag === "user" && c.attrs?.jid)
          .map((c) => c.attrs.jid);
        log(`prekey bundle requested for ${requested.join(",") || "(none)"}`);
        sendNode(
          iqResult(node, [
            {
              tag: "list",
              attrs: {},
              content: requested.map((jid) => peerDevice.preKeyBundleNode(jid)),
            },
          ]),
        );
        return;
      }
      if (child?.tag === "count") {
        sendNode(iqResult(node, [{ tag: "count", attrs: { value: "100" } }]));
        return;
      }
      if (child?.tag === "digest") {
        sendNode(iqResult(node, [{ tag: "digest", attrs: {} }]));
        return;
      }
      sendNode(iqResult(node, []));
      return;
    }

    if (xmlns === "w:g2") {
      if (attrs.to === "@g.us") {
        participatingQueries += 1;
        log(`group roster served (#${participatingQueries}) participants=${members().join(",")}`);
        sendNode(iqResult(node, [{ tag: "groups", attrs: {}, content: [groupNode()] }]));
        return;
      }
      groupMetadataQueries += 1;
      log(
        `group metadata served (#${groupMetadataQueries}) jid=${attrs.to} participants=${members().join(",")}`,
      );
      sendNode(iqResult(node, [groupNode()]));
      return;
    }

    sendNode(iqResult(node, []));
  };

  const handleMessage = async (node) => {
    const attrs = node.attrs ?? {};
    const content = Array.isArray(node.content) ? node.content : [];
    const childTags = content.map((c) => c?.tag ?? typeof c);
    log(
      `message stanza id=${attrs.id ?? "-"} to=${attrs.to ?? "-"} type=${attrs.type ?? "-"} children=[${childTags.join(",")}]`,
    );
    const participants = content.find((c) => c?.tag === "participants");
    const toJids = (participants?.content ?? [])
      .filter((c) => c?.tag === "to")
      .map((c) => c.attrs?.jid);
    const encSummary = content
      .filter((c) => c?.tag === "enc")
      .map((c) => `${c.attrs?.type}:${Buffer.from(c.content ?? []).length}B`);
    log(`message participants=${toJids.join(",") || "(none)"} group_enc=[${encSummary.join(",")}]`);

    const delivered = await peerDevice.decryptDelivered(node, {
      fromJid: GROUP_JID,
      participantJid: SELF_JID,
    });
    if (!delivered.ok) {
      log(`delivery FAILED ${delivered.reason}`);
    } else {
      const message = delivered.message;
      const extended = message.extendedTextMessage ?? {};
      const context = extended.contextInfo ?? message.messageContextInfo ?? {};
      const text = extended.text ?? message.conversation ?? "";
      log(
        `delivery decrypted enc=[${delivered.encTypes.join(",")}] text=${JSON.stringify(text)} mentionedJid=${JSON.stringify(context.mentionedJid ?? [])}`,
      );
    }
    sendNode({
      tag: "ack",
      attrs: {
        id: attrs.id ?? "",
        to: attrs.to ?? "",
        class: "message",
      },
    });
  };

  const handleNode = async (node) => {
    if (!node || typeof node !== "object") {
      log(`decoded non-node frame ${typeof node}`);
      return;
    }
    const tag = node.tag;
    if (tag === "iq") {
      await handleIq(node);
      return;
    }
    if (tag === "message") {
      await handleMessage(node);
      return;
    }
    if (tag === "presence" || tag === "chatstate" || tag === "ack" || tag === "receipt") {
      return;
    }
    log(`stanza <${tag}> ${JSON.stringify(node.attrs ?? {})}`);
  };

  const onFrames = async () => {
    while (true) {
      if (!introConsumed) {
        if (inBytes.length < 4) {
          return;
        }
        const header = inBytes.subarray(0, 4);
        if (header[0] !== 0x57 || header[1] !== 0x41) {
          throw new Error(`unexpected intro header ${header.toString("hex")}`);
        }
        inBytes = inBytes.subarray(4);
        introConsumed = true;
      }
      if (inBytes.length < 3) {
        return;
      }
      const size = (inBytes[0] << 16) | (inBytes[1] << 8) | inBytes[2];
      if (inBytes.length < size + 3) {
        return;
      }
      const body = inBytes.subarray(3, size + 3);
      inBytes = inBytes.subarray(size + 3);

      if (!noise) {
        const hello = proto.HandshakeMessage.decode(body);
        const clientEphemeral = Buffer.from(hello.clientHello.ephemeral);
        log(`client hello ephemeral=${clientEphemeral.toString("hex").slice(0, 16)}…`);
        noise = makeNoiseServer({
          staticKeyPair: serverStatic,
          ephemeralKeyPair: serverEphemeral,
        });
        const serverHello = noise.buildServerHello(clientEphemeral, buildCertChainPayload(serverStatic.public, process.env.PROOF_ANCHOR_FILE));
        socket.send(frame(serverHello));
        log("server hello sent (real Noise server: ephemeral + static + cert chain)");
        continue;
      }

      if (!handshakeDone) {
        const clientFinish = proto.HandshakeMessage.decode(body).clientFinish;
        const { clientStatic, loginPayload } = noise.readClientFinish(clientFinish);
        handshakeDone = true;
        log(
          `noise handshake complete clientStatic=${Buffer.from(clientStatic).toString("hex").slice(0, 16)}… loginPayload=${Buffer.from(loginPayload).length}B`,
        );
        sendNode({
          tag: "success",
          attrs: { t: String(Date.now()), server: "proof-local-peer" },
        });
        log("success node sent");
        continue;
      }

      const plaintext = noise.decrypt(body);
      const node = await decodeBinaryNode(plaintext);
      await handleNode(node);
    }
  };

  socket.on("message", async (data) => {
    try {
      inBytes = Buffer.concat([inBytes, Buffer.from(data)]);
      await onFrames();
    } catch (error) {
      log(`frame error: ${error?.stack ?? error}`);
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  });

  socket.on("close", (code) => log(`socket closed code=${code}`));
  socket.on("error", (error) => log(`socket error: ${error?.message ?? error}`));
}

// ---------------------------------------------------------------- peer device

const peerDevice = await makePeerDevice({ meJid: PEER_JID, log });

// ------------------------------------------------------------------ ws server

const server = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
server.on("listening", () => {
  const address = server.address();
  log(`listening ws://127.0.0.1:${address.port}/ws/chat group=${GROUP_JID}`);
  if (process.env.PROOF_PEER_PORT_FILE) {
    fs.writeFileSync(process.env.PROOF_PEER_PORT_FILE, String(address.port));
  }
});
server.on("connection", (socket, request) => {
  log(`websocket connection ${request.url}`);
  makeSession(socket);
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});

if (ROSTER_SWAP_AFTER_MS > 0 && !SWAP_FILE) {
  setTimeout(() => refreshRoster("timer"), ROSTER_SWAP_AFTER_MS).unref();
}
