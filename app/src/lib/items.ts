// One row type for the board, whatever kind of bounty it is: a verified answer
// (the preimage template) or reviewed work. The board's filters, totals and
// table work on these.
import { Status, type BountyView } from "@/midnight/private-bounties-api";
import { WorkStatus, windowEnd, workActionError, type WorkLedger, type WorkView } from "~/midnight/work-api";
import { TEMPLATES, type TemplateView } from "~/midnight/verified-api";
import { statusOf, type Tone } from "~/lib/board";
import { cleanDetails, cleanTitle } from "~/lib/sanitize";
import { href } from "~/router";

export type Kind = "work" | "answer";

export interface BoardItem {
  kind: Kind;
  idHex: string;
  title: string;
  details: string;
  reward: bigint | null;
  postedAt: bigint | null;
  /** The final deadline. */
  deadline: bigint;
  mine: boolean;
  /** Reviewed work assigned to this browser. */
  working: boolean;
  /** Still in play: not paid, refunded, or past its deadline unclaimed. */
  active: boolean;
  /** Still holding its reward in escrow. */
  escrowed: boolean;
  paid: boolean;
  status: { label: string; tone: Tone };
  /** What the time column counts down to, and how it's worded. */
  clock: { to: bigint; before: string; after: string } | { text: string };
  /** The line under the title. */
  sub: string;
  href: string;
  /** What this browser should do about it, if anything. */
  needs: Need | null;
  /** Paid to this browser: solved here, or reviewed work it delivered. */
  earnedHere: boolean;
}

export type Need = "read" | "refund" | "review" | "deliver" | "collect";

/** Per-browser marks the rows depend on. */
export interface Marks {
  read: ReadonlySet<string>;
  solvedHere: ReadonlySet<string>;
}

export function answerItem(b: BountyView, address: string, now: bigint, marks: Marks): BoardItem {
  const open = b.status === Status.OPEN;
  const needs: Need | null = !b.mine
    ? null
    : b.status === Status.SOLVED && !marks.read.has(b.idHex)
      ? "read"
      : open && now >= b.deadline
        ? "refund"
        : null;
  return {
    kind: "answer",
    idHex: b.idHex,
    title: b.title,
    details: b.details,
    reward: b.reward,
    postedAt: b.postedAt,
    deadline: b.deadline,
    mine: b.mine,
    working: false,
    active: open && now < b.deadline,
    escrowed: open,
    paid: b.status === Status.SOLVED,
    status: statusOf(b, now),
    clock: open ? { to: b.deadline, before: "Ends in", after: "Ended" } : { text: b.status === Status.SOLVED ? "Solved" : "Refunded" },
    sub: "Preimage",
    href: href({ name: "bounty", address, id: b.idHex }),
    needs,
    earnedHere: !b.mine && b.status === Status.SOLVED && marks.solvedHere.has(b.idHex),
  };
}

/** A factor or signed-record bounty: the same shape of row as a preimage one. */
export function templateItem(v: TemplateView, address: string, now: bigint, marks: Marks): BoardItem {
  const open = v.status === Status.OPEN;
  return {
    kind: "answer",
    idHex: v.idHex,
    title: v.title,
    details: v.details,
    reward: v.reward,
    postedAt: v.postedAt,
    deadline: v.deadline,
    mine: v.mine,
    working: false,
    active: open && now < v.deadline,
    escrowed: open,
    paid: v.status === Status.SOLVED,
    status: statusOf(v, now),
    clock: open ? { to: v.deadline, before: "Ends in", after: "Ended" } : { text: v.status === Status.SOLVED ? "Solved" : "Refunded" },
    sub: TEMPLATES[v.template].name,
    href: href({ name: "bounty", address, id: v.idHex }),
    needs: !v.mine ? null : v.status === Status.SOLVED && !marks.read.has(v.idHex) ? "read" : open && now >= v.deadline ? "refund" : null,
    earnedHere: !v.mine && v.status === Status.SOLVED && marks.solvedHere.has(v.idHex),
  };
}

/** A reviewed-work bounty's status in words, from the viewer's side. */
export function workStatus(w: WorkView, now: bigint): { label: string; tone: Tone } {
  switch (w.status) {
    case WorkStatus.OPEN:
      if (now >= w.terms.deadline) return w.mine ? { label: "Refund ready", tone: "warn" } : { label: "Ended", tone: "muted" };
      if (windowEnd(w.terms.deliveryWindow, now) > w.terms.deadline) return { label: "Claims closed", tone: "muted" };
      return w.terms.firstToClaim ? { label: "Open, first to claim", tone: "open" } : { label: "Taking applications", tone: "open" };
    case WorkStatus.ASSIGNED:
      return now < w.until ? { label: w.assignedToMe ? "Yours to deliver" : "Assigned", tone: "private" } : { label: "Overdue", tone: "warn" };
    case WorkStatus.SUBMITTED:
      return now < w.until ? { label: "In review", tone: "warn" } : { label: w.assignedToMe ? "Ready to collect" : "Review time over", tone: "ok" };
    case WorkStatus.APPROVED:
      return { label: w.assignedToMe ? "Approved: collect" : "Approved", tone: "ok" };
    case WorkStatus.REJECTED:
      return now < w.until ? { label: "Rejected, appeal open", tone: "warn" } : { label: "Rejected", tone: "muted" };
    case WorkStatus.PAID:
      return { label: "Paid", tone: "ok" };
    case WorkStatus.REFUNDED:
      return { label: "Refunded", tone: "muted" };
    default:
      return { label: "Unknown", tone: "muted" };
  }
}

export function workItem(w: WorkView, state: WorkLedger, address: string, now: bigint): BoardItem {
  const can = (a: Parameters<typeof workActionError>[0]) => workActionError(a, state, w, now) === null;
  const needs: Need | null = w.mine
    ? can("approve") && now < w.until
      ? "review"
      : can("refund")
        ? "refund"
        : null
    : w.assignedToMe
      ? can("submit")
        ? "deliver"
        : can("collect")
          ? "collect"
          : null
      : null;
  const final = w.status === WorkStatus.PAID || w.status === WorkStatus.REFUNDED;
  const expiredOpen = w.status === WorkStatus.OPEN && now >= w.terms.deadline;
  const clock: BoardItem["clock"] =
    w.status === WorkStatus.OPEN
      ? { to: w.terms.deadline, before: "Ends in", after: "Ended" }
      : w.status === WorkStatus.ASSIGNED
        ? { to: w.until, before: "Due in", after: "Was due" }
        : w.status === WorkStatus.SUBMITTED
          ? { to: w.until, before: "Review ends in", after: "Review ended" }
          : w.status === WorkStatus.REJECTED
            ? { to: w.until, before: "Appeal ends in", after: "Appeal ended" }
            : { text: w.status === WorkStatus.PAID ? "Paid" : w.status === WorkStatus.REFUNDED ? "Refunded" : "Approved" };
  return {
    kind: "work",
    idHex: w.idHex,
    title: w.title,
    details: w.details,
    reward: w.reward,
    postedAt: w.postedAt,
    deadline: w.terms.deadline,
    mine: w.mine,
    working: w.assignedToMe,
    active: !final && !expiredOpen,
    escrowed: !final,
    paid: w.status === WorkStatus.PAID,
    status: workStatus(w, now),
    clock,
    sub: w.terms.firstToClaim ? "First to claim" : "Applications",
    href: href({ name: "work", address, id: w.idHex }),
    needs,
    earnedHere: w.assignedToMe && w.status === WorkStatus.PAID,
  };
}

export interface ItemFilters {
  kind: Kind | "all";
  phase: "active" | "done";
  query: string;
  sort: "newest" | "reward" | "ending";
}

/** The rows the board lists for these filters, without hidden ones. */
export function filterItems(items: BoardItem[], f: ItemFilters, hidden: ReadonlySet<string>): BoardItem[] {
  const q = f.query.trim().toLowerCase();
  const desc = (x: bigint, y: bigint) => (x === y ? 0 : x > y ? -1 : 1);
  const order =
    f.sort === "reward"
      ? (a: BoardItem, b: BoardItem) => desc(a.reward ?? 0n, b.reward ?? 0n)
      : f.sort === "ending"
        ? (a: BoardItem, b: BoardItem) => -desc(a.deadline, b.deadline)
        : (a: BoardItem, b: BoardItem) => desc(a.postedAt ?? a.deadline, b.postedAt ?? b.deadline);
  return items
    .filter(
      (b) =>
        !hidden.has(b.idHex) &&
        (f.kind === "all" || b.kind === f.kind) &&
        (f.phase === "active") === b.active &&
        (q === "" || cleanTitle(b.title).toLowerCase().includes(q) || cleanDetails(b.details).toLowerCase().includes(q)),
    )
    .sort(order);
}

export interface Totals {
  inEscrow: bigint;
  active: number;
  paidOut: bigint;
}

export function itemTotals(items: BoardItem[]): Totals {
  let inEscrow = 0n;
  let paidOut = 0n;
  let active = 0;
  for (const b of items) {
    if (b.escrowed) inEscrow += b.reward ?? 0n;
    if (b.paid) paidOut += b.reward ?? 0n;
    if (b.active) active++;
  }
  return { inEscrow, active, paidOut };
}
