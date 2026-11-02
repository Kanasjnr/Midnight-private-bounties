import type { ReactNode } from "react";
import { Status, type BountyView } from "@/midnight/private-bounties-api";
import { statusOf } from "~/lib/board";
import { amount, ago, deadlineText } from "~/lib/format";
import { cleanTitle } from "~/lib/sanitize";
import { href } from "~/router";
import { Chip, cx, StatusText } from "~/components/ui";

const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 sm:grid-cols-[minmax(0,1fr)_110px_150px_130px]";

/** Rows of bounties, as on the board and in My bounties. */
export function BountyTable({
  rows,
  address,
  now,
  copies,
  empty,
  footer,
}: {
  rows: BountyView[];
  address: string;
  now: bigint;
  /** Bounties whose text copies an earlier one. */
  copies?: ReadonlySet<string>;
  empty: string;
  footer?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className={cx(ROW, "border-b border-line px-5 py-2.5 text-xs font-semibold tracking-wider text-faint uppercase")}>
        <span>Bounty</span>
        <span className="hidden text-right sm:block">Reward</span>
        <span className="hidden sm:block">Time</span>
        <span>Status</span>
      </div>
      {rows.length === 0 && <div className="px-5 py-10 text-center text-muted">{empty}</div>}
      {rows.map((b) => {
        const s = statusOf(b, now);
        const soon = s.tone === "open" && b.deadline - now < 3_600n;
        return (
          <a
            key={b.idHex}
            href={href({ name: "bounty", address, id: b.idHex })}
            className={cx(ROW, "border-b border-line-soft px-5 py-3.5 text-inherit no-underline transition-colors last:border-b-0 hover:bg-raised")}
          >
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold tracking-tight">{cleanTitle(b.title) || "Untitled"}</span>
                {b.mine && <Chip>Yours</Chip>}
                {copies?.has(b.idHex) && <Chip className="border-warn-line text-warn">Copies an earlier bounty</Chip>}
              </span>
              <span className="truncate text-sm text-muted">
                <span className="font-semibold text-fg-2">Verified</span> <span className="text-faint">· Preimage</span>
                {b.postedAt !== null && <span className="text-faint"> · posted {ago(b.postedAt, now)}</span>}
                <span className="text-fg-2 sm:hidden"> · {b.reward !== null ? `${amount(b.reward)} TEST` : ""}</span>
              </span>
            </span>
            <span className="hidden text-right font-mono text-[15px] font-medium whitespace-nowrap sm:block">
              {b.reward !== null ? amount(b.reward) : "–"} <span className="text-xs text-faint">TEST</span>
            </span>
            <span className={cx("hidden text-sm sm:block", soon ? "text-warn" : "text-fg-2")}>{timeText(b, now)}</span>
            <span className="text-sm">
              <StatusText {...s} />
            </span>
          </a>
        );
      })}
      {footer}
    </div>
  );
}

function timeText(b: BountyView, now: bigint): string {
  if (b.status === Status.OPEN) return deadlineText(b.deadline, now);
  return b.status === Status.SOLVED ? "Solved" : "Refunded";
}
