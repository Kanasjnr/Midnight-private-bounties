// Chat between a reviewed-work poster and an applicant or contributor, over
// public Nostr relays (spike Q15). Nothing here touches the chain.
//
// Keys. The poster's end is their per-bounty encryption key b (on chain as
// b·G). The other end is a per-bounty contact key c, derived from the
// account's identity secret, so it needs no storage and the key backup covers
// it. The applicant puts c·G in their application code; the code is the
// handshake. Both sides then compute the same shared point, and from it:
//   - an AES-GCM key for the messages ("pb:chat-aes");
//   - a thread tag only the two of them can compute ("pb:chat-thread").
// Each side signs its Nostr events with a key derived from its own secret and
// the thread, so a browser knows its own messages by their author, and every
// other message that decrypts came from the one other holder of the key.
//
// Applications travel too, to the bounty's inbox tag ("pb:inbox"), so the
// poster's page picks them up. Anyone can compute an inbox tag from the
// public bounty, so watching it shows how many applications a bounty gets;
// what they say, and who sent them, stays hidden.
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools/pure";
import { posterKeyFor } from "../../../contract/keys.js";
import { workCircuits } from "~/midnight/work-api";

export const CHAT_KIND = 4515;
export const MESSAGE_MAX = 2000;
type Point = { x: bigint; y: bigint };

const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);
const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function fieldBytes(x: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return b;
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(concat(...parts))));
}

/** The tag a bounty's applications are sent under. Public: anyone can compute it from the bounty. */
export async function inboxTag(address: string, id: Uint8Array): Promise<string> {
  return hex(await sha256(enc.encode("pb:inbox"), enc.encode(address.toLowerCase()), id));
}

/** This account's contact key for one bounty, from its identity secret. */
export async function contactKey(sk: Uint8Array, address: string, id: Uint8Array): Promise<bigint> {
  return posterKeyFor(await sha256(enc.encode("pb:chat"), sk), address, id);
}

export function publicKeyOf(scalar: bigint): Point {
  return workCircuits.posterPublicKey(scalar);
}

/** One end of a chat: the keys this browser uses with the other party. */
export interface Channel {
  thread: string;
  key: CryptoKey;
  /** Nostr secret key for this side's events in this thread. */
  signer: Uint8Array;
  /** Its public key, which marks this side's own messages. */
  me: string;
}

export async function openChannel(mine: bigint, theirs: Point, id: Uint8Array): Promise<Channel> {
  const shared = fieldBytes(workCircuits.applicationKey(mine, theirs, id));
  const thread = hex(await sha256(enc.encode("pb:chat-thread"), shared));
  const key = await crypto.subtle.importKey("raw", buf(await sha256(enc.encode("pb:chat-aes"), shared)), "AES-GCM", false, ["encrypt", "decrypt"]);
  const signer = await sha256(enc.encode("pb:nostr"), fieldBytes(mine), enc.encode(thread));
  return { thread, key, signer, me: getPublicKey(signer) };
}

/** What a message says, inside the encryption. */
interface Body {
  v: 1;
  text: string;
  /** The message this one answers. */
  re?: string;
  /** The message this one replaces. */
  edit?: string;
  /** When it was written, in ms. The event's own time is only to the second. */
  at: number;
}

function b64(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** A signed, encrypted event for one message. The thread is bound into the AES associated data. */
export async function sealMessage(ch: Channel, text: string, opts: { re?: string; edit?: string } = {}): Promise<Event> {
  const t = text.trim();
  if (!t) throw new Error("Write something first");
  if ([...t].length > MESSAGE_MAX) throw new Error(`Keep it under ${MESSAGE_MAX} characters`);
  const body: Body = { v: 1, text: t, at: Date.now(), ...(opts.re ? { re: opts.re } : {}), ...(opts.edit ? { edit: opts.edit } : {}) };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: buf(enc.encode(ch.thread)) }, ch.key, enc.encode(JSON.stringify(body))));
  return finalizeEvent({ kind: CHAT_KIND, created_at: Math.floor(body.at / 1000), tags: [["z", ch.thread]], content: `${b64(iv)}.${b64(ct)}` }, ch.signer);
}

/** A message as decrypted, before edits are applied. */
export interface Sealed {
  id: string;
  author: string;
  body: Body;
}

/** Opens one event of the thread, or null if it isn't one of ours (another key, or changed). */
export async function openMessage(ch: Channel, ev: Event): Promise<Sealed | null> {
  const [iv, ct] = ev.content.split(".");
  if (!iv || !ct) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(unb64(iv)), additionalData: buf(enc.encode(ch.thread)) }, ch.key, buf(unb64(ct)));
    const body = JSON.parse(dec.decode(plain)) as Body;
    if (body.v !== 1 || typeof body.text !== "string" || typeof body.at !== "number") return null;
    return { id: ev.id, author: ev.pubkey, body };
  } catch {
    return null;
  }
}

export interface ChatMessage {
  id: string;
  mine: boolean;
  text: string;
  at: number;
  edited: boolean;
  /** The text of the message this answers, if it's in the thread. */
  replyTo: { id: string; text: string; mine: boolean } | null;
}

/**
 * The conversation: originals in time order, each showing its latest edit.
 * An edit counts only from the original's author, so neither side can put
 * words in the other's mouth.
 */
export function conversation(sealed: Sealed[], me: string): ChatMessage[] {
  const byId = new Map(sealed.map((m) => [m.id, m]));
  const latest = new Map<string, Sealed>();
  for (const m of sealed) {
    if (!m.body.edit) continue;
    const orig = byId.get(m.body.edit);
    if (!orig || orig.body.edit || orig.author !== m.author) continue;
    const prev = latest.get(orig.id);
    if (!prev || prev.body.at < m.body.at) latest.set(orig.id, m);
  }
  const text = (m: Sealed) => latest.get(m.id)?.body.text ?? m.body.text;
  return sealed
    .filter((m) => !m.body.edit)
    .sort((a, b) => a.body.at - b.body.at || a.id.localeCompare(b.id))
    .map((m) => {
      const r = m.body.re ? byId.get(m.body.re) : undefined;
      return {
        id: m.id,
        mine: m.author === me,
        text: text(m),
        at: m.body.at,
        edited: latest.has(m.id),
        replyTo: r && !r.body.edit ? { id: r.id, text: text(r), mine: r.author === me } : null,
      };
    });
}

/** An application code as an inbox event, signed by a throwaway key so nothing links applications. */
export function applicationEvent(tag: string, code: string, throwaway: Uint8Array): Event {
  return finalizeEvent({ kind: CHAT_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["z", tag]], content: code }, throwaway);
}
