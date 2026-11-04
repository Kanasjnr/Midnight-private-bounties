// The Nostr side of chat (spike Q15): one pool for the whole page, writing to
// several relays and merging what comes back by event ID, so one relay being
// down or refusing us doesn't stop a conversation. Events are kept in
// localStorage per tag as they arrived (still encrypted), so a thread shows
// at once on reload and survives a relay forgetting it.
import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/pure";
import { storage } from "@/lib/storage";
import { externalStore, type Store } from "~/lib/store";
import { CHAT_KIND } from "~/midnight/chat";

/** The relays from Q15 that took our events, live and by tag. */
export const RELAYS = ["wss://relay.primal.net", "wss://relay.snort.social", "wss://nos.lol", "wss://nostr.mom", "wss://offchain.pub"];

const CACHE_MAX = 500;
let pool: SimplePool | null = null;
const getPool = () => (pool ??= new SimplePool({ enablePing: true, enableReconnect: true }));

const cacheKey = (tag: string) => `private-bounties-app:relay:${tag}`;

function cached(tag: string): Event[] {
  try {
    const v = JSON.parse(storage.get(cacheKey(tag)) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as Event[]) : [];
  } catch {
    return [];
  }
}

const stores = new Map<string, { store: Store<Event[]>; add: (e: Event) => void }>();

/** Every event under one tag: the cache first, then live from the relays for as long as someone reads it. */
export function tagStore(tag: string): Store<Event[]> {
  return entry(tag).store;
}

function entry(tag: string) {
  let e = stores.get(tag);
  if (e) return e;
  let events = cached(tag);
  let publish: ((v: Event[]) => void) | null = null;
  const add = (ev: Event) => {
    if (ev.kind !== CHAT_KIND || !ev.tags.some((t) => t[0] === "z" && t[1] === tag) || events.some((x) => x.id === ev.id)) return;
    events = [...events, ev].slice(-CACHE_MAX);
    storage.set(cacheKey(tag), JSON.stringify(events));
    publish?.(events);
  };
  const store = externalStore<Event[]>(events, (set) => {
    publish = set;
    // The pool checks each event's signature before handing it over.
    const sub = getPool().subscribeMany(RELAYS, { kinds: [CHAT_KIND], "#z": [tag] }, { onevent: add });
    return () => {
      publish = null;
      sub.close();
    };
  });
  e = { store, add };
  stores.set(tag, e);
  return e;
}

/** Sends an event to every relay. Resolves once one has taken it, and shows it locally at once. */
export async function send(ev: Event): Promise<void> {
  const tag = ev.tags.find((t) => t[0] === "z")?.[1];
  try {
    await Promise.any(getPool().publish(RELAYS, ev));
  } catch {
    throw new Error("No relay took the message. Check your connection and try again.");
  }
  if (tag) entry(tag).add(ev);
}
