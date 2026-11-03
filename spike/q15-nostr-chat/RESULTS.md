# Spike Q15: can bounty chat run over public Nostr relays?

**Question:** a poster and a contributor need to talk: send, reply, edit, and see the other's
messages arrive live. There's no server, and putting each message on chain costs a transaction.
Can public Nostr relays carry the messages, with our own encryption on top?

**Answer: yes.** Five of the seven relays tried took our events, delivered them live in 150 to
480 ms, returned them to a fresh connection by thread tag, and replaced an edited message with
its newer version. The client library adds about 17 KB gzipped.

## Why Nostr

The first plan was Waku. Its JS SDK looks stalled (checked 2026-11-03): the code moved to
[logos-messaging/logos-delivery-js](https://github.com/logos-messaging/logos-delivery-js), the
examples and lab repos were archived in April and May 2026, and an open issue from 2026-08-30
asking whether it's still recommended for browser apps
([#2783](https://github.com/logos-messaging/logos-delivery-js/issues/2783)) has no maintainer
answer. `nostr-tools` is active: 2.25.5 was published on 2026-11-02.

## Setup

- `nostr-tools` 2.25.5 on Node 22.19.0, with `ws` 8.18.3 for WebSockets. Node's built-in
  WebSocket recursed in nostr-tools' error handler when a relay refused a connection
  (`RangeError: Maximum call stack size exceeded`). Browsers don't use that code path.
- Two throwaway keys, one per side. Every event carries the thread in a `z` tag and random
  base64 as content, the shape our ciphertext will have.
- Kind 4515 (regular range, stored) for messages and kind 34515 (addressable, replaced per
  author, kind and `d` tag) for the edit test.
- Run from this laptop on 2026-11-03. `node spike.mjs` writes [results.json](results.json).

## Results

| Relay | Accepts | Ack | Live | History | Largest accepted | Edit returns | Burst of 10 |
|---|---|---|---|---|---|---|---|
| nos.lol | ✅ | 157 ms | 257 ms | ✅ | 16 KiB (64 KiB: "event too large") | only v2 | 10 |
| relay.primal.net | ✅ | 207 ms | 253 ms | ✅ | 64 KiB | only v2 | 10 |
| relay.snort.social | ✅ | 145 ms | 153 ms | ✅ | 64 KiB | only v2 | 10 |
| nostr.mom | ✅ | 198 ms | 238 ms | ✅ | 16 KiB (64 KiB: "event too large") | only v2 | 10 |
| offchain.pub | ✅ | 376 ms | 478 ms | ✅ | 4 KiB (16 KiB: "pubkey is not in our web of trust") | only v2 | 10 |
| relay.damus.io | ❌ "banned: too many rate-limit violations" | | | | | | 0 |
| relay.nostr.band | ❌ connection timed out | | | | | | |

- **Live** is from the send until the other side's open subscription got the event.
- **History** is a new connection asking for `{kinds: [4515], "#z": [thread]}`, so single-letter
  tag queries work on every relay that accepted.
- **Edit:** publishing kind 34515 twice under one `d` tag, a second apart, then querying,
  returned only the second version on all five.
- **damus** banned this machine's IP before the run's first event. I don't know why: the only
  earlier contact was a run that crashed on connecting. It shows a relay can refuse a user
  outright, so the app has to write to several.

## Bundle size

`node bundle.mjs` bundles what the app would import (keys, signing, `SimplePool`) with esbuild
0.25.12, minified: 45.6 KB, **16.6 KB gzipped**.

## Consequences for the app

- **Transport:** publish each message to four or five relays, subscribe on all of them, and
  merge by event ID. Losing one or two relays, or being banned by one, doesn't stop the chat.
- **Size:** messages stay under 4 KiB, which every relay that accepted takes.
- **Identity:** each side signs with a Nostr key derived from its per-bounty key, so relays see
  only keys that link to nothing else. The thread tag is derived from the two parties' shared key,
  so only they can find the thread.
- **Content:** encrypted by the app, with the same key exchange as application codes and a
  separate "message" context, so relays hold only ciphertext.
- **Edits:** either an addressable event per message (relays keep only the latest) or a regular
  event that names the one it replaces. Both work; the app can show "edited" either way.
- **What leaks:** relays see the connecting IP, when messages are sent, and how many there are
  in a thread. They don't see who the parties are, which bounty it is, or the text.

## Not covered yet

- **Retention.** How long relays keep the events. `node recheck.mjs` asks for them again and
  appends to `recheck.json`; to be rerun after a day and a week.
- **The browser.** This ran in Node. The app's own build will show the real bundle cost and
  whether browser WebSockets behave the same.
