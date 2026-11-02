// What the board shows, worked out from the bounty rows the api file reads
// off the ledger (bountyViews). Pure, so it's tested without a wallet.
import { Status, type BountyView } from "@/midnight/private-bounties-api";
import { cleanDetails, cleanTitle } from "~/lib/sanitize";

export type Tone = "open" | "ok" | "warn" | "muted";

/** A bounty's status in words, with the color it's shown in. */
export function statusOf(b: BountyView, now: bigint): { label: string; tone: Tone } {
  if (b.status === Status.SOLVED) return { label: "Solved", tone: "ok" };
  if (b.status === Status.REFUNDED) return { label: "Refunded", tone: "muted" };
  if (now < b.deadline) return { label: "Open", tone: "open" };
  return b.mine ? { label: "Refund ready", tone: "warn" } : { label: "Ended", tone: "muted" };
}

/** Open and before its deadline: still solvable. */
export function isActive(b: BountyView, now: bigint): boolean {
  return b.status === Status.OPEN && now < b.deadline;
}

export interface BoardTotals {
  /** Rewards the contract still holds: every bounty not yet solved or refunded. */
  inEscrow: bigint;
  active: number;
  paidOut: bigint;
}

export function totals(rows: BountyView[], now: bigint): BoardTotals {
  let inEscrow = 0n;
  let paidOut = 0n;
  let active = 0;
  for (const b of rows) {
    const reward = b.reward ?? 0n;
    if (b.status === Status.OPEN) inEscrow += reward;
    if (b.status === Status.SOLVED) paidOut += reward;
    if (isActive(b, now)) active++;
  }
  return { inEscrow, active, paidOut };
}

/**
 * This browser's side of the board. Posted bounties are recognized from the
 * private state (`mine`). Solving leaves nothing public that points back to
 * the solver, so `solvedHere` is the list this browser keeps of what it solved.
 */
export interface Yours {
  waiting: number;
  answersToRead: number;
  refundReady: bigint;
  refundCount: number;
  earned: bigint;
  solved: number;
}

export function yours(rows: BountyView[], now: bigint, solvedHere: ReadonlySet<string>, read: ReadonlySet<string>): Yours {
  const out: Yours = { waiting: 0, answersToRead: 0, refundReady: 0n, refundCount: 0, earned: 0n, solved: 0 };
  for (const b of rows) {
    if (b.mine) {
      if (isActive(b, now)) out.waiting++;
      if (b.status === Status.SOLVED && !read.has(b.idHex)) out.answersToRead++;
      if (b.status === Status.OPEN && now >= b.deadline) {
        out.refundCount++;
        out.refundReady += b.reward ?? 0n;
      }
    } else if (b.status === Status.SOLVED && solvedHere.has(b.idHex)) {
      out.solved++;
      out.earned += b.reward ?? 0n;
    }
  }
  return out;
}

export type Phase = "active" | "done";
export type Sort = "newest" | "reward" | "ending";

export interface Filters {
  phase: Phase;
  query: string;
  sort: Sort;
}

/** The rows the board lists for these filters, without hidden ones. */
export function boardRows(rows: BountyView[], f: Filters, now: bigint, hidden: ReadonlySet<string>): BountyView[] {
  const q = f.query.trim().toLowerCase();
  const picked = rows.filter(
    (b) =>
      !hidden.has(b.idHex) &&
      (f.phase === "active") === isActive(b, now) &&
      (q === "" || cleanTitle(b.title).toLowerCase().includes(q) || cleanDetails(b.details).toLowerCase().includes(q)),
  );
  return picked.sort(compare(f.sort));
}

function compare(sort: Sort): (a: BountyView, b: BountyView) => number {
  const desc = (x: bigint, y: bigint) => (x === y ? 0 : x > y ? -1 : 1);
  if (sort === "reward") return (a, b) => desc(a.reward ?? 0n, b.reward ?? 0n);
  if (sort === "ending") return (a, b) => -desc(a.deadline, b.deadline);
  // Newest first; a bounty without a post time sorts by its deadline.
  return (a, b) => desc(a.postedAt ?? a.deadline, b.postedAt ?? b.deadline);
}

/**
 * Bounties whose title and question match an earlier one's, after cleaning.
 * A copy of a real listing is how a misleading one would get attention, so
 * the board flags it (second audit, S1). The earliest post keeps no flag.
 */
export function duplicates(rows: BountyView[]): Set<string> {
  const byTime = [...rows].sort((a, b) => {
    const x = a.postedAt ?? a.deadline;
    const y = b.postedAt ?? b.deadline;
    return x === y ? a.idHex.localeCompare(b.idHex) : x < y ? -1 : 1;
  });
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const b of byTime) {
    const key = `${cleanTitle(b.title).toLowerCase()}\n${cleanDetails(b.details).toLowerCase()}`;
    if (seen.has(key)) out.add(b.idHex);
    else seen.add(key);
  }
  return out;
}
