import { describe, expect, it } from "vitest";
import { Status } from "@/midnight/private-bounties-api";
import { boardRows, duplicates, statusOf, totals, yours } from "~/lib/board";
import { ago, amount, deadlineText, short, span, SPECK_PER_DUST, STAR_PER_NIGHT, units } from "~/lib/format";
import { cleanDetails, cleanTitle, hadHiddenCharacters } from "~/lib/sanitize";
import { href, parseRoute } from "~/router";
import { answerStrength } from "~/pages/post";
import { view } from "./fixtures";

describe("format", () => {
  it("shows spans in their two largest units", () => {
    expect(span(45n)).toBe("45s");
    expect(span(47n * 60n)).toBe("47m");
    expect(span(3n * 3600n + 12n * 60n)).toBe("3h 12m");
    expect(span(2n * 86400n + 4n * 3600n + 59n)).toBe("2d 4h");
    expect(span(86400n)).toBe("1d");
  });
  it("words deadlines and ages", () => {
    expect(deadlineText(1_000n, 400n)).toBe("Ends in 10m");
    expect(deadlineText(1_000n, 1_000n + 86_400n)).toBe("Ended 1d ago");
    expect(ago(100n, 130n)).toBe("just now");
  });
  it("formats amounts and wallet units", () => {
    expect(amount(2060n)).toBe("2,060");
    expect(units(1_250_500_000n, STAR_PER_NIGHT)).toBe("1,250.5");
    expect(units(12_400_000_000_000_000n, SPECK_PER_DUST, 1)).toBe("12.4");
    expect(units(3n * SPECK_PER_DUST, SPECK_PER_DUST)).toBe("3");
    expect(short("a".repeat(64))).toBe(`${"a".repeat(8)}…${"a".repeat(6)}`);
    expect(short("abc")).toBe("abc");
  });
});

describe("sanitize (second audit, S1)", () => {
  it("strips bidi overrides, zero-width and control characters", () => {
    const tricky = "Pay‮yas‬ me​\u0007";
    expect(hadHiddenCharacters(tricky)).toBe(true);
    expect(cleanTitle(tricky)).toBe("Payyas me");
    expect(hadHiddenCharacters("plain")).toBe(false);
  });
  it("keeps line breaks in a question but not in a title", () => {
    expect(cleanTitle("a\n\nb")).toBe("a b");
    expect(cleanDetails("a  \n\n\n\nb\t c")).toBe("a\n\nb  c");
  });
});

describe("board", () => {
  const now = 5_000n;
  it("names each status", () => {
    expect(statusOf(view(), now)).toEqual({ label: "Open", tone: "open" });
    expect(statusOf(view({ deadline: 4_000n }), now).label).toBe("Ended");
    expect(statusOf(view({ deadline: 4_000n, mine: true }), now).label).toBe("Refund ready");
    expect(statusOf(view({ status: Status.SOLVED }), now).label).toBe("Solved");
    expect(statusOf(view({ status: Status.REFUNDED }), now).label).toBe("Refunded");
  });
  it("totals escrow, active and paid out", () => {
    const rows = [view(), view({ deadline: 1n, reward: 50n }), view({ status: Status.SOLVED, reward: 40n }), view({ status: Status.REFUNDED })];
    expect(totals(rows, now)).toEqual({ inEscrow: 150n, active: 1, paidOut: 40n });
  });
  it("counts this browser's side", () => {
    const solved = view({ status: Status.SOLVED, reward: 30n });
    const read = view({ status: Status.SOLVED, mine: true });
    const rows = [view({ mine: true }), view({ mine: true, status: Status.SOLVED }), read, view({ mine: true, deadline: 1n, reward: 75n }), solved, view({ status: Status.SOLVED })];
    expect(yours(rows, now, new Set([solved.idHex]), new Set([read.idHex]))).toEqual({
      waiting: 1, answersToRead: 1, refundReady: 75n, refundCount: 1, earned: 30n, solved: 1,
    });
  });
  it("filters by phase, search and hidden, and sorts", () => {
    const a = view({ title: "Ship in a bottle", reward: 10n, postedAt: 3n, deadline: 9_000n });
    const b = view({ details: "the SHIP name", reward: 90n, postedAt: 2n, deadline: 6_000n });
    const c = view({ reward: 50n, postedAt: 1n, deadline: 7_000n });
    const done = view({ status: Status.SOLVED });
    const rows = [a, b, c, done];
    const ids = (r: typeof rows) => r.map((x) => x.idHex);
    expect(ids(boardRows(rows, { phase: "active", query: "", sort: "newest" }, now, new Set()))).toEqual(ids([a, b, c]));
    expect(ids(boardRows(rows, { phase: "active", query: "", sort: "reward" }, now, new Set()))).toEqual(ids([b, c, a]));
    expect(ids(boardRows(rows, { phase: "active", query: "", sort: "ending" }, now, new Set()))).toEqual(ids([b, c, a]));
    expect(ids(boardRows(rows, { phase: "active", query: "ship", sort: "newest" }, now, new Set()))).toEqual(ids([a, b]));
    expect(ids(boardRows(rows, { phase: "active", query: "", sort: "newest" }, now, new Set([a.idHex])))).toEqual(ids([b, c]));
    expect(ids(boardRows(rows, { phase: "done", query: "", sort: "newest" }, now, new Set()))).toEqual(ids([done]));
  });
  it("flags later copies of a listing, not the original", () => {
    const first = view({ title: "Same", details: "Q", postedAt: 1n });
    const copy = view({ title: "Sa​me ", details: "q", postedAt: 2n });
    const other = view({ title: "Other", details: "Q" });
    expect([...duplicates([copy, first, other])]).toEqual([copy.idHex]);
  });
});

describe("router", () => {
  it("round-trips routes", () => {
    const id = "ab".repeat(32);
    for (const r of [{ name: "board" }, { name: "mine" }, { name: "setup" }, { name: "post" }, { name: "bounty", address: "cd".repeat(32), id }] as const) {
      expect(parseRoute(href(r))).toEqual(r);
    }
  });
  it("falls back to the board for anything else", () => {
    expect(parseRoute("#/b/zz/12")).toEqual({ name: "board" });
    expect(parseRoute("")).toEqual({ name: "board" });
  });
});

describe("answer strength", () => {
  it("grades by length and character classes", () => {
    expect(answerStrength("  ")).toBe(0);
    expect(answerStrength("albatross")).toBe(1);
    expect(answerStrength("albatrossalbatross")).toBe(2);
    expect(answerStrength("Albatross-on-the-mantel-1907")).toBe(3);
  });
});
