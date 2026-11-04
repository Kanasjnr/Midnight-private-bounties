// Asks each relay again for the first message spike.mjs stored there, to see
// how long relays keep our events. Appends to recheck.json.
//
//   node recheck.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";
import { Relay, useWebSocketImplementation } from "nostr-tools/relay";

// Node's built-in WebSocket recurses in nostr-tools' error handler when a relay
// refuses the connection; browsers and `ws` don't.
useWebSocketImplementation(WebSocket);

const results = JSON.parse(readFileSync(new URL("./results.json", import.meta.url), "utf8"));
const file = new URL("./recheck.json", import.meta.url);
const log = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
const withTimeout = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

const row = { at: new Date().toISOString(), hoursAfter: +((Date.now() - Date.parse(results.at)) / 3.6e6).toFixed(1), relays: {} };
for (const r of results.relays) {
  if (!r.ids || r.accept?.ok !== true) continue;
  try {
    const relay = await withTimeout(Relay.connect(r.url));
    const got = await withTimeout(
      new Promise((resolve) => {
        const found = [];
        const sub = relay.subscribe([{ ids: r.ids }], { onevent: (e) => found.push(e.id), oneose: () => (sub.close(), resolve(found)) });
      }),
    );
    row.relays[r.url] = got.includes(r.ids[0]);
    relay.close();
  } catch (e) {
    row.relays[r.url] = String(e?.message ?? e);
  }
}
log.push(row);
writeFileSync(file, JSON.stringify(log, null, 2) + "\n");
console.log(JSON.stringify(row));
process.exit(0);
