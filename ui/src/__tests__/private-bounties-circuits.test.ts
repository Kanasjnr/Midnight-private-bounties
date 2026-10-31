// @vitest-environment node
//
// Runs the real compiled bounty_preimage contract in memory (no network, no
// proofs) through the Node test's flow (src/test/bounty_preimage.test.ts),
// with the values the UI builds: the token color from tokenColor, fresh coins
// from freshCoin (a zero-value one for the solver), answers from
// encodeAnswer, and the poster's per-bounty key from keys.ts. Each step
// asserts on the ledger the board shows, and the panel's pure helpers are
// checked against the circuit: posterPseudonym and bountyViews against the
// stored `poster`, readAnswer against the delivery, actionError against every
// assert it mirrors.
//
// Seed file: generated once by `yarn new:ui`, then yours to edit. The drift
// check ignores it.
import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { FinalizedCallTxData } from "@midnight-ntwrk/midnight-js-contracts";
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
  type CircuitResults,
} from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { posterKeyFor } from "../../../contract/keys.js";
import { NO_ANSWER, witnesses } from "../../../contract/witnesses.js";
import {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
  type PrivateBountiesPrivateState,
} from "../midnight/contract";
import {
  actionError,
  ANSWER_BYTES,
  bountyViews,
  decodeAnswer,
  DETAILS_MAX,
  encodeAnswer,
  listingError,
  TITLE_MAX,
  freshCoin,
  newPrivateState,
  parseAmount,
  postBounty,
  posterPseudonym,
  readAnswer,
  refund,
  Status,
  submit,
  tokenColor,
  type Action,
  type BountyView,
} from "../midnight/private-bounties-api";
import { PROVING_KEY } from "../components/private-bounties-panel";

type PS = PrivateBountiesPrivateState;

const POSTER_PK = "b0".repeat(32);
const SOLVER_PK = "a0".repeat(32);
const ADDRESS = sampleContractAddress();
// The token would live at its own address; for the color it only has to be
// some contract address.
const COLOR = tokenColor(sampleContractAddress());
const REWARD = 100n;
const TITLE = "Name the ship in the bottle";
const DETAILS = "What was the ship in the bottle on the mantel called? One word, as on its label. ⛵";
const ANSWER = "the treasure is under the old oak tree";

const contract = new Contract(witnesses);
const c = contract.impureCircuits;
const nowSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The contract between calls: its state, and a call that advances it. */
class Board {
  data;
  constructor(poster: PS) {
    this.data = contract.initialState(createConstructorContext(poster, POSTER_PK), COLOR.bytes).currentContractState.data;
  }
  get ledger(): Ledger {
    return ledger(this.data);
  }
  /** Run a circuit as (coin key, private state); on success the board moves on. */
  call<R>(pk: string, ps: PS, fn: (ctx: CircuitContext<PS>) => CircuitResults<PS, R>): CircuitResults<PS, R> {
    const res = fn(createCircuitContext(ADDRESS, pk, this.data, ps));
    this.data = res.context.currentQueryContext.state;
    return res;
  }
  /** The circuit's error message, or null if it would succeed (state unchanged). */
  errorOf(pk: string, ps: PS, fn: (ctx: CircuitContext<PS>) => unknown): string | null {
    try {
      fn(createCircuitContext(ADDRESS, pk, this.data, ps));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}

/** What postNewBounty does, against the in-memory board. */
async function post(board: Board, poster: PS, answer = ANSWER, deadline = nowSec() + 3600n) {
  const id = crypto.getRandomValues(new Uint8Array(32));
  const key = await posterKeyFor(poster.posterSeed!, ADDRESS, id);
  board.call(POSTER_PK, poster, (ctx) =>
    c.postBounty(ctx, id, freshCoin(COLOR.hex, REWARD), pureCircuits.posterPublicKey(key), pureCircuits.answerHash(encodeAnswer(answer)), deadline, TITLE, DETAILS),
  );
  return id;
}

/** The board row for `id`, as `ps` sees it. */
function row(board: Board, id: Uint8Array, ps: PS | null): BountyView {
  const found = bountyViews(board.ledger, ADDRESS, ps).find((b) => b.idHex === toHex(id));
  if (!found) throw new Error("no such row");
  return found;
}

/** actionError and the circuit agree: both pass, or the circuit fails with that reason. */
function expectMirrors(
  board: Board,
  action: Exclude<Action, "decrypt">,
  pk: string,
  ps: PS,
  id: Uint8Array,
  answerText?: string,
) {
  const predicted = actionError(action, board.ledger, row(board, id, ps), nowSec(), answerText);
  const solverPs = answerText === undefined ? ps : { ...ps, answer: encodeAnswer(answerText) };
  const actual = board.errorOf(pk, solverPs, (ctx) =>
    action === "submit" ? c.submit(ctx, id, freshCoin(COLOR.hex, 0n)) : c.refund(ctx, id),
  );
  if (predicted === null) expect(actual).toBeNull();
  else expect(actual).toContain(predicted);
}

/** Coin outputs of a call that pay `pk` exactly `value`. */
function paid(res: CircuitResults<PS, unknown>, pk: string, value: bigint) {
  return res.context.currentZswapLocalState.outputs.filter(
    (o) => o.recipient.is_left && toHex(o.recipient.left.bytes) === pk && o.coinInfo.value === value,
  );
}

// Each circuit call runs the real contract, and the refund test waits out a
// deadline, so these take seconds each; more on a busy machine.
describe("private-bounties contract (in memory)", { timeout: 60_000 }, () => {
  it("constructs with the token color the UI derives, and decodes an empty board", () => {
    const board = new Board(newPrivateState());
    // The panel reads the color back as toHex(rewardColor): it must be the token's hex.
    expect(toHex(board.ledger.rewardColor)).toBe(COLOR.hex);
    expect(bountyViews(board.ledger, ADDRESS, null)).toEqual([]);
  });

  it("posts, solves with a zero-value coin, and lets only the poster decrypt", async () => {
    const poster = newPrivateState();
    const solver = newPrivateState();
    const board = new Board(poster);
    const id = await post(board, poster);

    // The board: open, escrowed, and the poster's own (from the pseudonym alone).
    const stored = board.ledger.bounties.lookup(id);
    expect(toHex(posterPseudonym(ADDRESS, id, poster.sk))).toBe(toHex(stored.poster));
    expect(row(board, id, poster)).toMatchObject({ title: TITLE, details: DETAILS, status: Status.OPEN, reward: REWARD, mine: true });
    expect(row(board, id, solver)).toMatchObject({ mine: false });
    expect(row(board, id, null)).toMatchObject({ mine: false });

    // Wrong answers, the poster's refund and a decrypt are all refused, as predicted.
    expectMirrors(board, "submit", SOLVER_PK, solver, id, "the treasure is under the old elm tree");
    expectMirrors(board, "refund", POSTER_PK, poster, id);
    expectMirrors(board, "refund", SOLVER_PK, solver, id);
    expect(actionError("decrypt", board.ledger, row(board, id, poster), nowSec())).toBe("Nothing delivered yet");

    // Surrounding whitespace doesn't matter: the UI trims before encoding.
    expectMirrors(board, "submit", SOLVER_PK, solver, id, `  ${ANSWER}\n`);
    const res = board.call(SOLVER_PK, { ...solver, answer: encodeAnswer(ANSWER) }, (ctx) =>
      c.submit(ctx, id, freshCoin(COLOR.hex, 0n)),
    );
    // One payout coin, worth exactly the reward, to the solver.
    expect(paid(res, SOLVER_PK, REWARD)).toHaveLength(1);
    expect(row(board, id, poster)).toMatchObject({ status: Status.SOLVED, reward: null, mine: true });
    expectMirrors(board, "submit", SOLVER_PK, newPrivateState(), id, ANSWER);
    expectMirrors(board, "refund", POSTER_PK, poster, id);

    // Only the poster's seed opens the delivery.
    expect(actionError("decrypt", board.ledger, row(board, id, poster), nowSec())).toBeNull();
    expect(actionError("decrypt", board.ledger, row(board, id, solver), nowSec())).toBe("Only the poster can decrypt");
    expect(await readAnswer(board.ledger, ADDRESS, id, poster.posterSeed!)).toBe(ANSWER);
    await expect(readAnswer(board.ledger, ADDRESS, id, solver.posterSeed!)).rejects.toThrow();
  });

  it("refunds the poster after the deadline, and nobody else", async () => {
    const poster = newPrivateState();
    const solver = newPrivateState();
    const board = new Board(poster);
    const id = await post(board, poster, ANSWER, nowSec() + 2n);
    expectMirrors(board, "refund", POSTER_PK, poster, id);
    await sleep(3_000);

    expectMirrors(board, "submit", SOLVER_PK, solver, id, ANSWER);
    expectMirrors(board, "refund", SOLVER_PK, solver, id);
    expectMirrors(board, "refund", POSTER_PK, poster, id);
    const res = board.call(POSTER_PK, poster, (ctx) => c.refund(ctx, id));
    expect(paid(res, POSTER_PK, REWARD)).toHaveLength(1);
    expect(row(board, id, poster)).toMatchObject({ status: Status.REFUNDED, reward: null });
    expectMirrors(board, "refund", POSTER_PK, poster, id);
  });

  it("gives every bounty its own pseudonym and key", async () => {
    const poster = newPrivateState();
    const board = new Board(poster);
    const [a, b] = [await post(board, poster), await post(board, poster)];
    const [ba, bb] = [board.ledger.bounties.lookup(a), board.ledger.bounties.lookup(b)];
    expect(toHex(ba.poster)).not.toBe(toHex(bb.poster));
    expect(ba.posterPk.x).not.toBe(bb.posterPk.x);
    expect(bountyViews(board.ledger, ADDRESS, poster).every((v) => v.mine)).toBe(true);
  });

  it("never leaves the answer in a new private state", () => {
    const ps = newPrivateState();
    expect(ps.answer).toEqual(NO_ANSWER);
    expect(ps.sk).toHaveLength(32);
    expect(ps.posterSeed).toHaveLength(32);
    expect(toHex(ps.sk)).not.toBe(toHex(newPrivateState().sk));
  });
});

describe("answer encoding", () => {
  it("round-trips text, including multi-byte UTF-8, up to 124 bytes", () => {
    for (const text of ["a", ANSWER, "ünïcödé ✓ 答え", "x".repeat(ANSWER_BYTES)]) {
      const m = encodeAnswer(text);
      expect(m).toHaveLength(4);
      for (const x of m) expect(x < 1n << 248n).toBe(true);
      expect(decodeAnswer(m)).toBe(text);
    }
    expect(decodeAnswer(encodeAnswer("  padded \n"))).toBe("padded");
  });

  it("refuses what can't be an answer", () => {
    expect(() => encodeAnswer("")).toThrow("empty");
    expect(() => encodeAnswer("   ")).toThrow("empty");
    expect(() => encodeAnswer("x".repeat(ANSWER_BYTES + 1))).toThrow("at most 124");
    expect(() => decodeAnswer([1n << 248n, 0n, 0n, 0n])).toThrow("Not an encoded answer");
    expect(() => decodeAnswer([0xffn << 232n, 0n, 0n, 0n])).toThrow(); // not UTF-8
  });

  it("listingError asks for a title and a question, within the page's limits", () => {
    expect(listingError(TITLE, DETAILS)).toBeNull();
    expect(listingError("  ", DETAILS)).toBe("Give the bounty a title");
    expect(listingError(TITLE, "\n")).toBe("Write the question");
    // Limits count characters, not bytes or UTF-16 units.
    expect(listingError("ζ".repeat(TITLE_MAX), "🦊".repeat(DETAILS_MAX))).toBeNull();
    expect(listingError("x".repeat(TITLE_MAX + 1), DETAILS)).toBe(`Title is over ${TITLE_MAX} characters`);
    expect(listingError(TITLE, "x".repeat(DETAILS_MAX + 1))).toBe(`Question is over ${DETAILS_MAX} characters`);
  });

  it("parseAmount accepts exactly the positive Uint<64> values", () => {
    expect(parseAmount("1")).toBe(1n);
    expect(parseAmount(((1n << 64n) - 1n).toString())).toBe((1n << 64n) - 1n);
    for (const bad of ["0", "-1", "1.5", "x", "", (1n << 64n).toString()]) expect(parseAmount(bad)).toBeNull();
  });
});

describe("proving default (spike Q10)", () => {
  it("reads the proving choice from the key the template's providers context writes", () => {
    // The panel switches a first visit to the local proof server by checking
    // this key; if the template renamed it, every visit would look like a first.
    const source = readFileSync(new URL("../providers/midnight-providers.tsx", import.meta.url), "utf8");
    expect(source).toContain(`const PROVING_KEY = "${PROVING_KEY}";`);
  });
});

// Checked by `tsc -b` (the typecheck script); expectTypeOf does nothing at
// runtime. Each wrapper must hit the callTx overload that proves, submits and
// waits for finalization, and take exactly the circuit's arguments (counted
// from contract-info.json) after the contract handle.
describe("private-bounties circuit wrappers (types)", () => {
  it("submit through callTx with exactly the circuit's arguments", () => {
    expectTypeOf<Awaited<ReturnType<typeof postBounty>>>().toEqualTypeOf<
      FinalizedCallTxData<Contract, "postBounty">
    >();
    expectTypeOf<Parameters<typeof postBounty>["length"]>().toEqualTypeOf<8>();
    expectTypeOf<Awaited<ReturnType<typeof submit>>>().toEqualTypeOf<
      FinalizedCallTxData<Contract, "submit">
    >();
    expectTypeOf<Parameters<typeof submit>["length"]>().toEqualTypeOf<3>();
    expectTypeOf<Awaited<ReturnType<typeof refund>>>().toEqualTypeOf<
      FinalizedCallTxData<Contract, "refund">
    >();
    expectTypeOf<Parameters<typeof refund>["length"]>().toEqualTypeOf<2>();
  });
});
