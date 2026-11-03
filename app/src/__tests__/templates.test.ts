// @vitest-environment node
//
// The factor and signed-record templates, run in memory with the values the
// app builds: templateSubmitError against the circuit's submit, a record
// issued here passing the circuit's signature check, the poster decrypting
// what was delivered, the record file round trip, and board codes.
import { describe, expect, it } from "vitest";
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
} from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";
import * as Factor from "../../../contract/managed/bounty_factor/contract/index.js";
import * as Signed from "../../../contract/managed/bounty_signed_record/contract/index.js";
import { posterKeyFor } from "../../../contract/keys.js";
import { NO_SIGNATURE, witnesses, type SchnorrSignature } from "../../../contract/witnesses.js";
import type { PrivateBountiesPrivateState } from "@/midnight/contract";
import { freshCoin, newPrivateState, tokenColor } from "@/midnight/private-bounties-api";
import {
  factorAnswer,
  issueRecord,
  newIssuerKey,
  pointFromText,
  pointText,
  readTemplateAnswer,
  recordFromFile,
  recordToFile,
  schemaName,
  schemaTag,
  templateSubmitError,
  templateViews,
  type Template,
  type TemplateLedger,
} from "~/midnight/verified-api";
import { parseBoardCode } from "~/pages/setup";
import { boardCode } from "~/pages/board";

type PS = PrivateBountiesPrivateState;
const POSTER_PK = "b0".repeat(32);
const SOLVER_PK = "a0".repeat(32);
const ADDRESS = sampleContractAddress();
const COLOR = tokenColor(sampleContractAddress());
const nowSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));

// The two contracts' circuits take the same context, so one board class runs either.
class Board {
  data;
  constructor(
    private readonly t: Template,
    poster: PS,
  ) {
    const c = t === "factor" ? new Factor.Contract(witnesses) : new Signed.Contract(witnesses);
    this.data = c.initialState(createConstructorContext(poster, POSTER_PK), COLOR.bytes, 1n, 0n).currentContractState.data;
  }
  get ledger(): TemplateLedger {
    return this.t === "factor" ? Factor.ledger(this.data) : Signed.ledger(this.data);
  }
  call(pk: string, ps: PS, fn: (ctx: CircuitContext<PS>) => { context: { currentQueryContext: { state: unknown } } }) {
    const res = fn(createCircuitContext(ADDRESS, pk, this.data, ps));
    this.data = res.context.currentQueryContext.state as typeof this.data;
  }
  errorOf(pk: string, ps: PS, fn: (ctx: CircuitContext<PS>) => unknown): string | null {
    try {
      fn(createCircuitContext(ADDRESS, pk, this.data, ps));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}

const factorCircuits = new Factor.Contract(witnesses).impureCircuits;
const signedCircuits = new Signed.Contract(witnesses).impureCircuits;

async function posted(t: Template, args: (salt: Uint8Array, key: bigint) => (ctx: CircuitContext<PS>) => { context: { currentQueryContext: { state: unknown } } }) {
  const poster = newPrivateState();
  const board = new Board(t, poster);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const id = Factor.pureCircuits.bountyIdFor(salt, poster.sk);
  const key = await posterKeyFor(poster.posterSeed!, ADDRESS, id);
  board.call(POSTER_PK, poster, args(salt, key));
  const v = templateViews(t, board.ledger, ADDRESS, poster).find((x) => x.id.every((b, i) => b === id[i]))!;
  return { board, poster, id, v };
}

function submitAs(board: Board, t: Template, id: Uint8Array, answer: bigint[], signature: SchnorrSignature = NO_SIGNATURE) {
  const ps = { ...newPrivateState(), answer, signature };
  const fn = (ctx: CircuitContext<PS>) =>
    t === "factor" ? factorCircuits.submit(ctx, id, freshCoin(COLOR.hex, 0n)) : signedCircuits.submit(ctx, id, freshCoin(COLOR.hex, 0n));
  return { error: board.errorOf(SOLVER_PK, ps, fn), run: () => board.call(SOLVER_PK, ps, fn) };
}

describe("factor, against the compiled contract", () => {
  const N = 2147483647n * 2147483629n;
  const post = () =>
    posted("factor", (salt, key) => (ctx) =>
      factorCircuits.postBounty(ctx, salt, freshCoin(COLOR.hex, 100n), Factor.pureCircuits.posterPublicKey(key), N, nowSec() + 3600n, "Factor it", "N is a product of two primes.", nowSec() - 60n),
    );

  it("templateSubmitError agrees with the circuit, and the poster reads the factors", async () => {
    const { board, poster, id, v } = await post();
    expect(v.n).toEqual(N);
    for (const [a, b] of [["2147483629", "2147483647"], ["2147483647", "2147483629"], ["1", N.toString()], ["3", "5"]] as const) {
      const answer = factorAnswer(a, b);
      const predicted = templateSubmitError(v, nowSec(), answer);
      expect(submitAs(board, "factor", id, answer).error === null, `${a} × ${b}`).toEqual(predicted === null);
    }
    submitAs(board, "factor", id, factorAnswer("2147483647", "2147483629")).run();
    const solved = templateViews("factor", board.ledger, ADDRESS, poster).find((x) => x.idHex === v.idHex)!;
    expect(await readTemplateAnswer(board.ledger, ADDRESS, solved, poster.posterSeed!)).toEqual([2147483629n, 2147483647n, 0n, 0n]);
  });
});

describe("signed record, against the compiled contract", () => {
  it("a record issued in the app passes the circuit; templateSubmitError agrees on the rest", async () => {
    const issuer = newIssuerKey();
    const stranger = newIssuerKey();
    const type = "Bank statement v1";
    const { board, poster, id, v } = await posted("signed", (salt, key) => (ctx) =>
      signedCircuits.postBounty(ctx, salt, freshCoin(COLOR.hex, 100n), Signed.pureCircuits.publicKey(key), issuer.pk, schemaTag(type), 1n, 3000n, nowSec() + 3600n, "Income of at least 3,000", "A bank statement.", nowSec() - 60n),
    );
    const cases = [
      await issueRecord(issuer.sk, type, [5000n, 1n, 2n]), // passes
      await issueRecord(issuer.sk, type, [2999n, 1n, 2n]), // below the threshold
      await issueRecord(issuer.sk, "Age attestation v1", [5000n, 1n, 2n]), // wrong type
      await issueRecord(stranger.sk, type, [5000n, 1n, 2n]), // wrong issuer
    ];
    for (const r of cases) {
      // Through the file format, as a solver would load it.
      const loaded = recordFromFile(recordToFile(r));
      const predicted = templateSubmitError(v, nowSec(), loaded.record, loaded.issuerPk);
      expect(submitAs(board, "signed", id, loaded.record, loaded.signature).error === null, predicted ?? "passes").toEqual(predicted === null);
    }
    submitAs(board, "signed", id, cases[0]!.record, cases[0]!.signature).run();
    const solved = templateViews("signed", board.ledger, ADDRESS, poster).find((x) => x.idHex === v.idHex)!;
    expect(await readTemplateAnswer(board.ledger, ADDRESS, solved, poster.posterSeed!)).toEqual(cases[0]!.record);
  });

  it("names record types and keys in text, and refuses a damaged file", () => {
    expect(schemaName(schemaTag("Bank statement v1"))).toEqual("Bank statement v1");
    expect(() => schemaTag("x".repeat(32))).toThrow();
    const k = newIssuerKey();
    expect(pointFromText(pointText(k.pk))).toEqual(k.pk);
    expect(() => recordFromFile("{}")).toThrow("That isn't a signed-record file");
    expect(() => recordFromFile("not json")).toThrow("That isn't a signed-record file");
  });
});

describe("board codes", () => {
  const a = "aa".repeat(32);
  const b = "bb".repeat(32);
  const c = "cc".repeat(32);
  it("round-trip, leaving out contracts the board doesn't have", () => {
    expect(parseBoardCode(boardCode(a, b, c, null))).toEqual({ verified: a, work: b, factor: c, signed: null });
    expect(parseBoardCode(boardCode(a, null, null, c))).toEqual({ verified: a, work: null, factor: null, signed: c });
    expect(boardCode(a, null)).toEqual(a);
  });
  it("still read the older one- and two-address codes, and nothing else", () => {
    expect(parseBoardCode(a)).toEqual({ verified: a, work: null, factor: null, signed: null });
    expect(parseBoardCode(`${a}.${b}`)).toEqual({ verified: a, work: b, factor: null, signed: null });
    expect(parseBoardCode(`${a}.zz`)).toBeNull();
    expect(parseBoardCode(`${a}.${b}.${b}.${b}.${b}`)).toBeNull();
    expect(parseBoardCode("")).toBeNull();
  });
});
