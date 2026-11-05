# PR 193311 proof: WhatsApp group metadata cache judged on elapsed time

Reproduces the reported failure and the fix on the shipped path: a running
Gateway keeps a group metadata cache entry, the wall clock steps backwards
(NTP correction, VM resume), and the next group send must still refetch the
roster instead of serving the pre-step snapshot.

Run locally:

```bash
cd <openclaw worktree at the PR head>
PROOF_REPO_ROOT=$PWD PROOF_VARIANT=fixed bash proofs/193311/run-proof.sh       # branch
PROOF_REPO_ROOT=$PWD PROOF_VARIANT=reverted bash proofs/193311/run-proof.sh   # both cache files at origin/main
```

`.github/workflows/proof-whatsapp-193311.yml` runs both arms on a GitHub runner.

## What is shipped code

The Gateway source entry, the bundled WhatsApp channel plugin (session, group
metadata cache owner, inbound monitor, outbound send path) and the
`openclaw message send` CLI. The send, the cache decision and the wire traffic
are the product's own code paths.

## What stands in for production

* **WhatsApp Web endpoint** (`wa-peer.mjs`, `noise-peer.mjs`): a local server
  speaking the real protocol — 3-byte length framing, the `Noise_XX` handshake
  with `WA_CERT_DETAILS`, the `success` node, and the group/usync/prekey IQs.
  The channel's real `makeWASocket` client connects to it through the shipped
  `OPENCLAW_WHATSAPP_WEB_SOCKET_URL` override, so the session, socket options,
  Noise handshake and stanza encryption are exercised for real.
* **Second Signal device** (`peer-device.mjs`): `initAuthCreds()`, a real
  prekey bundle and `decryptMessageNode`, so the delivered group stanza
  (`pkmsg` + `skmsg` sender-key ciphertext) is decrypted and the mention list
  the client actually sent is reported, not simulated.
* **Noise trust anchor** (`anchor-trust.mjs`): the client pins WhatsApp's
  long-term certificate key in `node_modules/baileys/lib/Defaults/index.js`, so
  the harness points that constant at the peer's static key for the run and
  restores it afterwards. No file in the product tree is patched.

## Scenario

1. The Gateway hydrates the roster over the transport (self + `15550000222`).
2. `301 s` of real elapsed time pass; the TTL is `300 s`.
3. The Gateway's `Date.now` steps back `30 s` (`performance.now` untouched).
4. The peer adds `15550000333` to the group **without a group event**, so only
   the cache deadline decides whether the send sees the new member.
5. `openclaw message send --channel whatsapp --target <group> --message "handoff ping @15550000333"`.

Expected: `fixed` refetches the roster and the decrypted stanza carries
`mentionedJid=["15550000333@s.whatsapp.net"]`; `reverted` serves the stale
snapshot and the mention degrades to plain text (`mentionedJid=[]`).
