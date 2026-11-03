import { useMemo } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { amount, ago } from "~/lib/format";
import { constantStore, pollStore, useStore } from "~/lib/store";
import { boardActivity, type ActivityEvent, type FeedKind } from "~/midnight/activity";
import { publicIndexerUrl } from "~/midnight/read-only";
import { href } from "~/router";
import { useSession } from "~/session";
import { cleanTitle } from "~/lib/sanitize";

const NONE = constantStore<ActivityEvent[] | null>(null);
const keyOf = (es: ActivityEvent[]) => es.map((e) => e.key).join(",");

/** The board's recent activity: the last actions on each of its contracts, read again every 30 s. */
export function ActivityCard() {
  const { connectedApi } = useWallet();
  const { boardAddress, work, templates, network, now } = useSession();
  const contracts: { kind: FeedKind; address: string }[] = [
    ...(boardAddress ? [{ kind: "answer" as const, address: boardAddress }] : []),
    ...(work.address ? [{ kind: "work" as const, address: work.address }] : []),
    ...(templates.factor.address ? [{ kind: "factor" as const, address: templates.factor.address }] : []),
    ...(templates.signed.address ? [{ kind: "signed" as const, address: templates.signed.address }] : []),
  ];
  const which = contracts.map((c) => c.address).join(".");
  const store = useMemo(() => {
    if (!which) return NONE;
    // The wallet's indexer when there is one (it may be Blockfrost, with its key), else the network's public one.
    const url = () => (connectedApi ? connectedApi.getConfiguration().then((c) => c.indexerUri) : Promise.resolve(publicIndexerUrl(network)));
    return pollStore(
      () => url().then((u) => (u ? boardActivity(u, contracts) : [])),
      30_000,
      keyOf,
    ).store;
    // `contracts` is rebuilt every render; `which` names the same contracts.
  }, [which, connectedApi, network]);
  const events = useStore(store);

  return (
    <section aria-labelledby="activity-title" className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <h2 id="activity-title" className="m-0 text-[15px] font-semibold">
        Recent activity
      </h2>
      {events === null ? (
        <span className="text-[13px] text-faint">Reading the board's history…</span>
      ) : events.length === 0 ? (
        <span className="text-[13px] text-muted">Nothing yet.</span>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {events.map((e) => (
            <li key={e.key} className="flex flex-col gap-0.5 text-sm">
              <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{e.text}</span>
                <span className="shrink-0 text-[12px] text-faint">{ago(BigInt(Math.floor(e.at / 1000)), now)}</span>
              </span>
              {e.idHex && (
                <a
                  href={href({ name: e.kind === "work" ? "work" : "bounty", address: e.address, id: e.idHex })}
                  className="truncate text-[13px] text-muted no-underline hover:text-fg"
                >
                  {cleanTitle(e.title ?? "") || "Untitled"}
                  {e.reward !== null ? ` · ${amount(e.reward)} TEST` : ""}
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
      <span className="text-[12px] text-faint">From the public chain record. It never shows who did what.</span>
    </section>
  );
}
