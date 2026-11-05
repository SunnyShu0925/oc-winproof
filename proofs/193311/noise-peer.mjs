// Server side of Baileys' Noise XX handshake, used by the local WhatsApp Web
// protocol peer (PR 193311). Every primitive comes from the installed Baileys
// build, so both sides run identical crypto; only the role is mirrored.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.PROOF_REPO_ROOT ?? process.cwd();
const BAILEYS_LIB = path.join(ROOT, "node_modules/baileys/lib");
const BAILEYS_ROOT = path.join(ROOT, "node_modules/baileys");
const mod = (rel) => import(pathToFileURL(path.join(BAILEYS_LIB, rel)).href);

const { proto } = await import(
  pathToFileURL(path.join(BAILEYS_ROOT, "WAProto/index.js")).href
);
const { Curve, hkdf, aesEncryptGCM, aesDecryptGCM, sha256 } = await mod(
  "Utils/crypto.js",
);
const { NOISE_MODE, NOISE_WA_HEADER } = await mod("Defaults/index.js");

export { proto, Curve, hkdf, sha256, NOISE_MODE, NOISE_WA_HEADER };

export const frame = (data) => {
  const payload = Buffer.from(data);
  const out = Buffer.alloc(3 + payload.length);
  out[0] = (payload.length >>> 16) & 0xff;
  out[1] = (payload.length >>> 8) & 0xff;
  out[2] = payload.length & 0xff;
  payload.copy(out, 3);
  return out;
};

const counterIv = (counter) => {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(counter >>> 0, 8);
  return iv;
};

export function makeNoiseServer({ staticKeyPair, ephemeralKeyPair }) {
  const modeData = Buffer.from(NOISE_MODE);
  let hash = modeData.length === 32 ? modeData : sha256(modeData);
  let salt = hash;
  let encKey = hash;
  let decKey = hash;
  let counter = 0;
  let transport = null;

  const authenticate = (data) => {
    if (!transport) {
      hash = sha256(Buffer.concat([hash, data]));
    }
  };
  const encrypt = (plaintext) => {
    if (transport) {
      return transport.encrypt(plaintext);
    }
    const result = aesEncryptGCM(plaintext, encKey, counterIv(counter++), hash);
    authenticate(result);
    return result;
  };
  const decrypt = (ciphertext) => {
    if (transport) {
      return transport.decrypt(ciphertext);
    }
    const result = aesDecryptGCM(ciphertext, decKey, counterIv(counter++), hash);
    authenticate(ciphertext);
    return result;
  };
  const mixIntoKey = (data) => {
    const key = hkdf(Buffer.from(data), 64, { salt, info: "" });
    salt = key.subarray(0, 32);
    encKey = key.subarray(32);
    decKey = key.subarray(32);
    counter = 0;
  };
  const finishInit = () => {
    const key = hkdf(Buffer.alloc(0), 64, { salt, info: "" });
    transport = {
      readCounter: 0,
      writeCounter: 0,
      encrypt(plaintext) {
        return aesEncryptGCM(
          plaintext,
          key.subarray(32),
          counterIv(this.writeCounter++),
          Buffer.alloc(0),
        );
      },
      decrypt(ciphertext) {
        return aesDecryptGCM(
          ciphertext,
          key.subarray(0, 32),
          counterIv(this.readCounter++),
          Buffer.alloc(0),
        );
      },
    };
  };

  return {
    authenticate,
    encrypt,
    decrypt,
    mixIntoKey,
    finishInit,
    get hasTransport() {
      return transport !== null;
    },
    get state() {
      return { hash: hash.toString("hex"), encKey: encKey.toString("hex"), counter };
    },
    buildServerHello(clientEphemeral, certChainPayload) {
      authenticate(NOISE_WA_HEADER);
      authenticate(clientEphemeral);
      authenticate(ephemeralKeyPair.public);
      mixIntoKey(Curve.sharedKey(ephemeralKeyPair.private, clientEphemeral));
      const staticEnc = encrypt(staticKeyPair.public);
      mixIntoKey(Curve.sharedKey(staticKeyPair.private, clientEphemeral));
      const payloadEnc = encrypt(certChainPayload);
      return proto.HandshakeMessage.encode({
        serverHello: {
          ephemeral: ephemeralKeyPair.public,
          static: staticEnc,
          payload: payloadEnc,
        },
      }).finish();
    },
    readClientFinish(clientFinish) {
      // Client order: encrypt static (counter 1) -> mix in DH(client static,
      // server ephemeral) which resets the counter -> encrypt payload (counter
      // 0) -> finishInit. The peer mirrors that order exactly.
      const clientStatic = decrypt(clientFinish.static);
      mixIntoKey(Curve.sharedKey(ephemeralKeyPair.private, clientStatic));
      const loginPayload = decrypt(clientFinish.payload);
      finishInit();
      return { clientStatic, loginPayload };
    },
  };
}

let certChainCache = null;
export function buildCertChainPayload(serverStaticPublic, anchorFile) {
  if (certChainCache && certChainCache.serverStaticPublic === serverStaticPublic.toString("hex")) {
    return certChainCache.payload;
  }
  const anchor = JSON.parse(fs.readFileSync(anchorFile, "utf8"));
  const anchorPrivate = Buffer.from(anchor.anchorPrivate, "base64");
  const intermediatePrivate = Buffer.from(anchor.intermediatePrivate, "base64");
  const intermediatePublic = Buffer.from(anchor.intermediatePublic, "base64");

  const details = (fields) =>
    proto.CertChain.NoiseCertificate.Details.encode({
      serial: fields.serial,
      issuerSerial: fields.issuerSerial,
      key: fields.key,
      notBefore: 0,
      notAfter: 0,
    }).finish();

  const intermediateDetails = details({
    serial: 1,
    issuerSerial: 0,
    key: intermediatePublic,
  });
  const intermediateSignature = Curve.sign(anchorPrivate, intermediateDetails);
  const leafDetails = details({ serial: 2, issuerSerial: 1, key: serverStaticPublic });
  const leafSignature = Curve.sign(intermediatePrivate, leafDetails);
  const payload = proto.CertChain.encode({
    intermediate: { details: intermediateDetails, signature: intermediateSignature },
    leaf: { details: leafDetails, signature: leafSignature },
  }).finish();
  certChainCache = { serverStaticPublic: serverStaticPublic.toString("hex"), payload };
  return payload;
}
