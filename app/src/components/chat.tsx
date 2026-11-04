// The chat box for reviewed work, and the stores behind it: a thread's
// messages decrypted as the relays deliver them, and a poster's inbox of
// applications. No effects: each is an external store, cached by its tag.
import { useMemo, useState } from "react";
import { CornerDownRight, Lock, Pencil, Reply } from "lucide-react";
import type { Event } from "nostr-tools/pure";
import { send, tagStore } from "~/lib/relays";
import { constantStore, externalStore, promiseStore, useStore, type Store } from "~/lib/store";
import { conversation, MESSAGE_MAX, openChannel, openMessage, sealMessage, type Channel, type ChatMessage, type Sealed } from "~/midnight/chat";
import { openApplication, type OpenedApplication, type WorkLedger, type WorkView } from "~/midnight/work-api";
import { Button, cx, Textarea } from "~/components/ui";

type Point = { x: bigint; y: bigint };

const channels = new Map<string, Store<Channel | null>>();
/** The channel for one pair of keys on one bounty, made once. */
export function useChannel(mine: bigint | null, theirs: Point | null, id: Uint8Array): Channel | null {
  const key = mine !== null && theirs ? `${mine}:${theirs.x}:${theirs.y}:${id.join(",")}` : null;
  const store = useMemo(() => {
    if (key === null) return constantStore<Channel | null>(null);
    let s = channels.get(key);
    if (!s) {
      s = promiseStore(() => openChannel(mine!, theirs!, id));
      channels.set(key, s);
    }
    return s;
    // `key` names mine, theirs and id.
  }, [key]);
  return useStore(store);
}

/** Decrypts each event once, and rebuilds the conversation as events arrive. */
function decrypted<T, R>(tag: string, open: (ev: Event) => Promise<T | null>, build: (opened: T[]) => R): Store<R | null> {
  const src = tagStore(tag);
  const seen = new Map<string, T | null>();
  return externalStore<R | null>(null, (set) => {
    let live = true;
    const update = async () => {
      for (const ev of src.get()) {
        if (!seen.has(ev.id)) seen.set(ev.id, await open(ev));
      }
      if (live) set(build([...seen.values()].filter((x): x is T => x !== null)));
    };
    const unsub = src.subscribe(() => void update());
    void update();
    return () => {
      live = false;
      unsub();
    };
  });
}

const threads = new Map<string, Store<ChatMessage[] | null>>();
/** One thread's conversation, decrypted as events arrive; one store per thread. */
export function threadStore(ch: Channel): Store<ChatMessage[] | null> {
  let s = threads.get(ch.thread);
  if (!s) {
    s = decrypted<Sealed, ChatMessage[]>(ch.thread, (ev) => openMessage(ch, ev), (m) => conversation(m, ch.me));
    threads.set(ch.thread, s);
  }
  return s;
}

export interface Inbound extends OpenedApplication {
  at: number;
}

const inboxes = new Map<string, Store<Inbound[] | null>>();
/**
 * A poster's applications for one bounty, opened with their key; one store
 * per inbox tag. The latest code from each applicant (by pseudonym) wins, so
 * re-applying replaces. The ledger is only used for the bounty's poster key,
 * which never changes.
 */
export function inboxStore(tag: string, state: WorkLedger, address: string, v: WorkView, posterSeed: Uint8Array): Store<Inbound[] | null> {
  let s = inboxes.get(tag);
  if (!s) {
    s = decrypted<Inbound, Inbound[]>(
      tag,
      (ev) => openApplication(state, address, v, posterSeed, ev.content).then((a) => ({ ...a, at: ev.created_at * 1000 }), () => null),
      (apps) => {
        const latest = new Map<string, Inbound>();
        for (const a of apps) {
          const k = a.pseudonym.join(",");
          const prev = latest.get(k);
          if (!prev || prev.at < a.at) latest.set(k, a);
        }
        return [...latest.values()].sort((a, b) => b.at - a.at);
      },
    );
    inboxes.set(tag, s);
  }
  return s;
}

export function useInbox(tag: string | null, state: WorkLedger | null, address: string | null, v: WorkView, posterSeed: Uint8Array | undefined): Inbound[] | null {
  const store = useMemo(
    () => (tag && state && address && posterSeed ? inboxStore(tag, state, address, v, posterSeed) : constantStore<Inbound[] | null>(null)),
    // The store is cached by tag; the rest only matters for the first one.
    [tag, address, posterSeed !== undefined],
  );
  return useStore(store);
}

function time(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(undefined, today ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * One private conversation. `other` names the other side ("the poster", "this
 * applicant"); `beforeSend` runs before each send (the claimer's introduction).
 */
export function ChatBox({ ch, other, beforeSend }: { ch: Channel; other: string; beforeSend?: () => Promise<void> }) {
  const messages = useStore(useMemo(() => threadStore(ch), [ch]));
  const [text, setText] = useState("");
  const [re, setRe] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = [...text].length > MESSAGE_MAX;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await beforeSend?.();
      await send(await sealMessage(ch, text, editing ? { edit: editing.id } : re ? { re: re.id } : {}));
      setText("");
      setRe(null);
      setEditing(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col rounded-lg border border-line bg-surface">
      <div className="flex max-h-[420px] min-h-28 flex-col gap-3 overflow-y-auto px-4 py-4">
        {messages === null ? (
          <span className="text-sm text-faint">Opening the conversation…</span>
        ) : messages.length === 0 ? (
          <span className="text-sm text-muted">No messages yet. Say hello to {other}.</span>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={cx("group flex max-w-[85%] flex-col gap-1", m.mine ? "self-end items-end" : "self-start items-start")}>
              {m.replyTo && (
                <span className="flex max-w-full items-center gap-1 truncate text-[12px] text-faint">
                  <CornerDownRight aria-hidden="true" className="size-3 shrink-0" />
                  <span className="truncate">{m.replyTo.mine ? "You" : "They"}: {m.replyTo.text}</span>
                </span>
              )}
              <div className={cx("rounded-lg px-3.5 py-2 text-[15px] break-words whitespace-pre-wrap", m.mine ? "bg-fg text-page" : "bg-chip text-fg")}>{m.text}</div>
              <span className="flex items-center gap-2 text-[11px] text-faint">
                {time(m.at)}
                {m.edited && <span>edited</span>}
                <button type="button" onClick={() => (setEditing(null), setRe(m))} className="inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100">
                  <Reply aria-hidden="true" className="size-3" /> Reply
                </button>
                {m.mine && (
                  <button type="button" onClick={() => (setRe(null), setEditing(m), setText(m.text))} className="inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100">
                    <Pencil aria-hidden="true" className="size-3" /> Edit
                  </button>
                )}
              </span>
            </div>
          ))
        )}
      </div>
      <form
        className="flex flex-col gap-2 border-t border-line-soft px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() && !tooLong && !busy) void submit();
        }}
      >
        {(re || editing) && (
          <span className="flex items-center justify-between gap-3 text-[13px] text-muted">
            <span className="truncate">{editing ? "Editing your message" : `Replying to: ${re!.text}`}</span>
            <button type="button" className="shrink-0 text-faint hover:text-fg" onClick={() => (setRe(null), editing && setText(""), setEditing(null))}>
              Cancel
            </button>
          </span>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            aria-label="Message"
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (text.trim() && !tooLong && !busy) void submit();
              }
            }}
            placeholder={`Message ${other}`}
            className="min-h-11 flex-1"
          />
          <Button type="submit" disabled={!text.trim() || tooLong} busy={busy}>
            {editing ? "Save" : "Send"}
          </Button>
        </div>
        <span className="flex items-center gap-1.5 text-[12px] text-faint">
          <Lock aria-hidden="true" className="size-3" />
          {tooLong ? <span className="text-warn">Keep it under {MESSAGE_MAX} characters.</span> : "Encrypted in this browser. Relays carry it but can't read it or tell who you are."}
        </span>
        {error && <span className="text-sm text-bad">{error}</span>}
      </form>
    </div>
  );
}
