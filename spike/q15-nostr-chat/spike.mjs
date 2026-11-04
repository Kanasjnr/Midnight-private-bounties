// Spike Q15: can bounty chat run over public Nostr relays?
//
// Two throwaway keys stand in for a poster and a contributor. For each relay:
//   accept   does it take a regular event of our own kind, tagged with a thread?
//   live     how long until the other side's subscription sees it?
//   history  does a fresh connection get it back by its thread tag?
//   sizes    which content sizes does it accept (1, 4, 16, 64 KiB)?
//   edit     an addressable event published twice under one `d` tag:
//            does a query return only the newer one?
//   burst    10 events at once: how many are accepted?
// Content is random base64, the same shape as our ciphertext. Results go to
// results.json; recheck.mjs asks for the same events again later.
//
//   node spike.mjs
import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import WebSocket from "ws";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";

// Node's built-in WebSocket recurses in nostr-tools' error handler when a relay
// refuses the connection; browsers and `ws` don't.
useWebSocketImplementation(WebSocket);

const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://relay.snort.social",
  "wss://offchain.pub",
  "wss://nostr.mom",
];
const KIND = 4515; // regular range (1000-9999): stored
const EDIT_KIND = 34515; // addressable range (30000-39999): replaced per pubkey, kind and `d`
const TIMEOUT = 8000;

const poster = generateSecretKey();
const contributor = generateSecretKey();
const now = () => Math.floor(Date.now() / 1000);
const b64 = (n) => randomBytes(Math.ceil((n * 3) / 4)).toString("base64").slice(0, n);
const event = (sk, kind, tags, content) => finalizeEvent({ kind, created_at: now(), tags, content }, sk);
const withTimeout = (p, ms = TIMEOUT) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

async function connect(url) {
  return withTimeout(Relay.connect(url));
}

async function publish(relay, ev) {
  try {
    await withTimeout(relay.publish(ev));
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e).slice(0, 160) };
  }
}

function query(relay, filter) {
  return withTimeout(
    new Promise((resolve) => {
      const got = [];
      const sub = relay.subscribe([filter], {
        onevent: (e) => got.push(e),
        oneose: () => {
          sub.close();
          resolve(got);
        },
      });
    }),
  ).catch(() => null);
}

async function testRelay(url) {
  const out = { url };
  const thread = randomBytes(32).toString("hex");
  let a, b;
  try {
    [a, b] = await Promise.all([connect(url), connect(url)]);
  } catch (e) {
    return { ...out, connect: String(e?.message ?? e) };
  }
  out.connect = "ok";
  try {
    // live: the contributor listens on the thread, the poster sends
    let seen = null;
    const sub = b.subscribe([{ kinds: [KIND], "#z": [thread], since: now() - 5 }], { onevent: () => (seen ??= Date.now()) });
    await new Promise((r) => setTimeout(r, 500));
    const msg = event(poster, KIND, [["z", thread]], b64(400));
    const sent = Date.now();
    out.accept = await publish(a, msg);
    const acked = Date.now();
    for (let i = 0; i < 50 && seen === null; i++) await new Promise((r) => setTimeout(r, 100));
    sub.close();
    out.ackMs = acked - sent;
    out.liveMs = seen === null ? null : seen - sent;

    // history: a fresh connection asks by thread tag
    const c = await connect(url);
    const back = await query(c, { kinds: [KIND], "#z": [thread] });
    out.history = back === null ? "timeout" : back.some((e) => e.id === msg.id);
    out.ids = [msg.id];

    // sizes
    out.sizes = {};
    for (const kib of [1, 4, 16, 64]) {
      const r = await publish(a, event(poster, KIND, [["z", thread]], b64(kib * 1024)));
      out.sizes[`${kib}KiB`] = r.ok ? "ok" : r.reason;
    }

    // edit: same d tag twice
    const d = randomBytes(16).toString("hex");
    const v1 = event(contributor, EDIT_KIND, [["d", d], ["z", thread]], "v1:" + b64(200));
    await publish(a, v1);
    await new Promise((r) => setTimeout(r, 1100)); // newer created_at
    const v2 = event(contributor, EDIT_KIND, [["d", d], ["z", thread]], "v2:" + b64(200));
    const e2 = await publish(a, v2);
    const edits = await query(c, { kinds: [EDIT_KIND], authors: [getPublicKey(contributor)], "#d": [d] });
    out.edit = !e2.ok ? `rejected: ${e2.reason}` : edits === null ? "timeout" : edits.map((e) => e.content.slice(0, 2)).join(",");

    // burst
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => publish(a, event(poster, KIND, [["z", thread], ["n", String(i)]], b64(300)))));
    out.burst = burst.filter((r) => r.ok).length;
    const firstNo = burst.find((r) => !r.ok);
    if (firstNo) out.burstReason = firstNo.reason;
    out.thread = thread;
    c.close();
  } catch (e) {
    out.error = String(e?.message ?? e);
  } finally {
    a?.close();
    b?.close();
  }
  return out;
}

const results = { at: new Date().toISOString(), node: process.version, kind: KIND, editKind: EDIT_KIND, relays: [] };
for (const url of RELAYS) {
  const r = await testRelay(url);
  results.relays.push(r);
  console.log(JSON.stringify(r));
}
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
process.exit(0);
