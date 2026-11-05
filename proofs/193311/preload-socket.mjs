// Installs the local WhatsApp Web socket factory for the shipped Gateway
// process. The factory is handed to the plugin through globalThis because the
// bundled plugin graph is loaded by jiti, which resolves `baileys` itself and
// therefore bypasses Node's module hooks.
//
// Everything except the socket is shipped code: the Gateway, the WhatsApp
// channel's startAccount, the group metadata cache owner, the inbound monitor,
// the outbound send path, and the `openclaw message send` CLI.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.env.PROOF_REPO_ROOT || process.cwd();
const fixtureUrl = new URL("./socket-fixture.mjs", import.meta.url).href;

const requireFromRepo = createRequire(`${REPO_ROOT}/package.json`);
const realBaileys = await import(pathToFileURL(requireFromRepo.resolve("baileys")).href);
const { createFixtureMakeWASocket } = await import(fixtureUrl);

globalThis.__proofMakeWASocket = createFixtureMakeWASocket(realBaileys);
process.stdout.write("PROOF socket preload armed: __proofMakeWASocket installed\n");
