// "Your activity": what happened to the bounties this browser posted, applied
// for, works on or solved. Two sources, merged newest first:
//   - the chain's history (~/midnight/activity), kept to those bounties and
//     worded for the role this browser has in each;
//   - what only this browser can read: new applications in its inboxes, and
//     messages from the other side of its chats.
// One store per set of inputs. Shown by the bell in the top bar.
import { useMemo, useState } from "react";
import { Bell } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { useLocalSet, useLocalValue } from "~/hooks/use-local-value";
import { cleanTitle } from "~/lib/sanitize";
import { constantStore, externalStore, useStore, type Store } from "~/lib/store";
import { boardActivity, wording, type FeedKind, type Role } from "~/midnight/activity";
import { contactKey, inboxTag, openChannel } from "~/midnight/chat";
import { publicIndexerUrl } from "~/midnight/read-only";
import { checkedPosterKey, type WorkView } from "~/midnight/work-api";
import { href } from "~/router";
import { useSession } from "~/session";
import { inboxStore, threadStore, type Inbound } from "~/components/chat";
import { cx } from "~/components/ui";

export interface Personal {
  key: string;
  at: number;
  text: string;
  /** The bounty's title, or a message's first words. */
  detail: string;
  href: string;
  /** Only this browser could have learned it (an application, a message). */
  private: boolean;
}

const stores = new Map<string, Store<Personal[] | null>>();

interface Inputs {
  key: string;
  indexer: () => Promise<string | null>;
  contracts: { kind: FeedKind; address: string }[];
  roles: Map<string, Role>;
  posterWork: WorkView[];
  workerWork: WorkView[];
  work: { address: string; state: NonNullable<ReturnType<typeof useSession>["work"]["state"]>; ps: NonNullable<ReturnType<typeof useSession>["work"]["ps"]> } | null;
}

function workHref(address: string, v: WorkView) {
  return href({ name: "work", address, id: v.idHex });
}

function personalStore(i: Inputs): Store<Personal[] | null> {
  let s = stores.get(i.key);
  if (s) return s;
  s = externalStore<Personal[] | null>(null, (set) => {
    let live = true;
    const parts = new Map<string, Personal[]>();
    const unsubs: (() => void)[] = [];
    const watched = new Set<string>();
    const emit = () => live && set([...parts.values()].flat().sort((a, b) => b.at - a.at));
    function watch<T>(key: string, store: Store<T | null>, map: (v: T) => Personal[], also?: (v: T) => void) {
      if (watched.has(key)) return;
      watched.add(key);
      const read = () => {
        const v = store.get();
        if (v === null) return;
        parts.set(key, map(v));
        also?.(v);
        emit();
      };
      unsubs.push(store.subscribe(read));
      read();
    }

    // The chain's history, kept to this browser's bounties.
    const chain = async () => {
      const url = await i.indexer();
      if (!url || !live) return;
      const events = await boardActivity(url, i.contracts, 60).catch(() => null);
      if (!events || !live) return;
      parts.set(
        "chain",
        events.flatMap((e) => {
          const role = e.idHex ? i.roles.get(e.idHex) : undefined;
          if (!role || !e.idHex) return [];
          const text = wording(e, role);
          if (!text) return [];
          return [{ key: e.key, at: e.at, text, detail: cleanTitle(e.title ?? "") || "Untitled", href: href({ name: e.kind === "work" ? "work" : "bounty", address: e.address, id: e.idHex }), private: false }];
        }),
      );
      emit();
    };
    void chain();
    const timer = window.setInterval(() => void chain(), 30_000);

    const w = i.work;
    if (w) {
      // Applications to work this browser posted, and the chats they open.
      for (const v of i.posterWork) {
        void (async () => {
          const [tag, b] = await Promise.all([inboxTag(w.address, v.id), checkedPosterKey(w.state, w.address, v.id, w.ps.posterSeed!).catch(() => null)]);
          if (!live || b === null) return;
          const title = cleanTitle(v.title) || "Untitled";
          watch<Inbound[]>(
            `inbox:${tag}`,
            inboxStore(tag, w.state, w.address, v, w.ps.posterSeed!),
            (apps) =>
              apps.map((a) => ({
                key: `app:${tag}:${a.pseudonym.join(",")}:${a.at}`,
                at: a.at,
                text: v.terms.firstToClaim ? "The claimer introduced themselves" : `New application from ${cleanTitle(a.name) || "someone"}`,
                detail: title,
                href: workHref(w.address, v),
                private: true,
              })),
            (apps) => {
              for (const a of apps) {
                void openChannel(b, a.contact, v.id).then((ch) => {
                  if (!live) return;
                  const who = cleanTitle(a.name) || (v.terms.firstToClaim ? "the claimer" : "an applicant");
                  watch(`thread:${ch.thread}`, threadStore(ch), (msgs) =>
                    msgs.filter((m) => !m.mine).map((m) => ({ key: `msg:${m.id}`, at: m.at, text: `Message from ${who}`, detail: m.text, href: workHref(w.address, v), private: true })),
                  );
                });
              }
            },
          );
        })();
      }
      // Chats with the posters of work this browser applied for or works on.
      for (const v of i.workerWork) {
        void (async () => {
          const c = await contactKey(w.ps.sk, w.address, v.id);
          const ch = await openChannel(c, w.state.works.lookup(v.id).posterPk, v.id);
          if (!live) return;
          watch(`thread:${ch.thread}`, threadStore(ch), (msgs) =>
            msgs.filter((m) => !m.mine).map((m) => ({ key: `msg:${m.id}`, at: m.at, text: "Message from the poster", detail: m.text, href: workHref(w.address, v), private: true })),
          );
        })();
      }
    }

    return () => {
      live = false;
      window.clearInterval(timer);
      unsubs.forEach((u) => u());
    };
  });
  stores.set(i.key, s);
  return s;
}

/** This browser's activity, live, and the newest-first list's unread count. */
export function useMyActivity(): { events: Personal[] | null; unread: number; seen: number; markRead: () => void } {
  const { connectedApi } = useWallet();
  const { network, boardAddress, work, templates, items } = useSession();
  const applied = useLocalSet(`private-bounties-app:applied:${network}`);
  const [seenRaw, setSeen] = useLocalValue(`private-bounties-app:activity-seen:${network}`);

  const roles = new Map<string, Role>();
  for (const b of items) {
    if (b.mine) roles.set(b.idHex, "poster");
    else if (b.working || (b.kind === "work" && b.earnedHere)) roles.set(b.idHex, "worker");
    else if (b.earnedHere) roles.set(b.idHex, "solver");
    else if (b.kind === "work" && work.address && applied.set.has(`${work.address}:${b.idHex}`)) roles.set(b.idHex, "applicant");
  }
  const posterWork = work.views.filter((v) => v.mine);
  const workerWork = work.views.filter((v) => !v.mine && (v.assignedToMe || (work.address && applied.set.has(`${work.address}:${v.idHex}`))));
  const contracts: { kind: FeedKind; address: string }[] = [
    ...(boardAddress ? [{ kind: "answer" as const, address: boardAddress }] : []),
    ...(work.address ? [{ kind: "work" as const, address: work.address }] : []),
    ...(templates.factor.address ? [{ kind: "factor" as const, address: templates.factor.address }] : []),
    ...(templates.signed.address ? [{ kind: "signed" as const, address: templates.signed.address }] : []),
  ];
  const ready = work.ps !== null || roles.size > 0;
  const key = [
    network,
    connectedApi ? "w" : "-",
    contracts.map((c) => c.address).join("."),
    [...roles].map(([id, r]) => `${id}:${r}`).sort().join(","),
    posterWork.map((v) => v.idHex).join(","),
    workerWork.map((v) => v.idHex).join(","),
    work.state && work.ps ? "k" : "-",
  ].join("|");

  const store = useMemo(() => {
    if (!ready || roles.size === 0) return constantStore<Personal[] | null>([]);
    return personalStore({
      key,
      indexer: () => (connectedApi ? connectedApi.getConfiguration().then((c) => c.indexerUri) : Promise.resolve(publicIndexerUrl(network))),
      contracts,
      roles,
      posterWork,
      workerWork,
      work: work.address && work.state && work.ps ? { address: work.address, state: work.state, ps: work.ps } : null,
    });
    // `key` names every input that changes what the store reads.
  }, [key]);
  const events = useStore(store);
  const seen = seenRaw ? Number(seenRaw) : 0;
  return {
    events,
    seen,
    unread: events ? events.filter((e) => e.at > seen).length : 0,
    markRead: () => setSeen(String(Date.now())),
  };
}

function time(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(undefined, today ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * The bell in the top bar. Its count is what's new since it was last opened;
 * opening it marks everything read, and keeps this opening's new items
 * highlighted until it closes.
 */
export function Notifications() {
  const { events, unread, seen, markRead } = useMyActivity();
  const [openedAfter, setOpenedAfter] = useState<number | null>(null);
  const open = openedAfter !== null;
  const close = () => setOpenedAfter(null);
  const toggle = () => {
    if (open) return close();
    setOpenedAfter(seen);
    if (unread > 0) markRead();
  };
  const isNew = (e: Personal) => e.at > (openedAfter ?? seen);

  return (
    <div className="relative" onKeyDown={(e) => e.key === "Escape" && close()}>
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} new` : "Notifications"}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggle}
        className={cx("relative inline-flex size-8 items-center justify-center rounded-md border border-line-strong text-muted transition-colors hover:border-line-hover hover:bg-raised hover:text-fg", open && "bg-raised text-fg")}
      >
        <Bell aria-hidden="true" className="size-4" />
        {unread > 0 && (
          <span aria-hidden="true" className="absolute -top-1.5 -right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-private px-1 text-[10px] font-semibold text-on-fg tabular">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        // Clicking anywhere outside the panel lands on this backdrop and closes it.
        <div aria-hidden="true" className="fixed inset-0 z-10" onClick={close} />
      )}
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 z-20 mt-2 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[10px] border border-line bg-surface shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-medium">Notifications</span>
            <span className="text-xs text-faint">Only you can see these</span>
          </div>
          <div className="max-h-[440px] overflow-y-auto">
            {events === null ? (
              <p className="m-0 px-4 py-6 text-sm text-faint">Reading your bounties' history…</p>
            ) : events.length === 0 ? (
              <p className="m-0 px-4 py-8 text-center text-sm text-muted">
                Nothing yet. Applications, messages and payouts on your bounties show up here.
              </p>
            ) : (
              <ol className="m-0 flex list-none flex-col divide-y divide-line-soft p-0">
                {events.slice(0, 40).map((e) => (
                  <li key={e.key}>
                    <a href={e.href} onClick={close} className={cx("flex items-start gap-3 px-4 py-3 text-inherit no-underline transition-colors hover:bg-raised", isNew(e) && "bg-raised/60")}>
                      <span aria-hidden="true" className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", isNew(e) ? (e.private ? "bg-private" : "bg-fg") : "bg-transparent")} />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className={cx("text-[13px]", isNew(e) ? "font-medium text-fg" : "text-fg-2")}>{e.text}</span>
                          <span className="shrink-0 text-[11px] text-faint tabular">{time(e.at)}</span>
                        </span>
                        <span className="truncate text-xs text-muted">{e.detail}</span>
                      </span>
                    </a>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
