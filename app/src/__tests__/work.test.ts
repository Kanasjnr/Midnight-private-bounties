// @vitest-environment node
//
// Runs the real compiled bounty_reviewed_work contract in memory (no network,
// no proofs) with the values the app builds, and checks the app's helpers
// against it: workActionError against every circuit it gates, workViews and
// contributorPseudonym against the stored pseudonyms, application codes from
// applicant to poster, and the submitted link through readSubmission.
import { describe, expect, it } from "vitest";
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
  type CircuitResults,
} from "@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { Contract, ledger, pureCircuits } from "../../../contract/managed/bounty_reviewed_work/contract/index.js";
import { posterKeyFor } from "../../../contract/keys.js";
import { witnesses } from "../../../contract/witnesses.js";
import type { PrivateBountiesPrivateState } from "@/midnight/contract";
import { encodeAnswer, freshCoin, newPrivateState, tokenColor } from "@/midnight/private-bounties-api";
import {
  contributorPseudonym,
  checkedPosterKey,
  makeApplication,
  openApplication,
  readSubmission,
  windowEnd,
  workActionError,
  WorkStatus,
  workViews,
  type Terms,
  type WorkAction,
  type WorkLedger,
  type WorkView,
} from "~/midnight/work-api";
import { workItem } from "~/lib/items";
import { contactKey, openChannel, publicKeyOf } from "~/midnight/chat";

type PS = PrivateBountiesPrivateState;

const POSTER_PK = "b0".repeat(32);
const CONTRIB_PK = "a0".repeat(32);
const OTHER_PK = "c0".repeat(32);
const ADDRESS = sampleContractAddress();
const COLOR = tokenColor(sampleContractAddress());
const REWARD = 100n;
const SLACK = 900n;
const LINK = "https://github.com/example/repo/pull/42";

const contract = new Contract(witnesses);
const c = contract.impureCircuits;
const nowSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

// Ledger 9: the constructor and the circuits are async, hence create() and the awaits.
class Board {
  data!: Awaited<ReturnType<typeof contract.initialState>>["currentContractState"]["data"];
  static async create(poster: PS, collect: bigint): Promise<Board> {
    const b = new Board();
    b.data = (await contract.initialState(createConstructorContext(poster, POSTER_PK), COLOR.bytes, 1n, 0n, SLACK, collect)).currentContractState.data;
    return b;
  }
  get ledger(): WorkLedger {
    return ledger(this.data);
  }
  /** `time` pins the block time (seconds) the circuit sees; it defaults to now. */
  private ctx(circuitId: string, pk: string, ps: PS, time?: bigint): CircuitContext<PS> {
    return createCircuitContext({
      circuitId,
      contractAddress: ADDRESS,
      coinPublicKeyOrZswapState: pk,
      contractState: this.data,
      privateState: ps,
      ...(time === undefined ? {} : { time: Number(time) }),
    });
  }
  async call<R>(circuitId: string, pk: string, ps: PS, fn: (ctx: CircuitContext<PS>) => Promise<CircuitResults<PS, R>>): Promise<CircuitResults<PS, R>> {
    const res = await fn(this.ctx(circuitId, pk, ps));
    this.data = res.context.callContext.currentQueryContext.state as typeof this.data;
    return res;
  }
  async errorOf(circuitId: string, pk: string, ps: PS, fn: (ctx: CircuitContext<PS>) => Promise<unknown>, time?: bigint): Promise<string | null> {
    try {
      await fn(this.ctx(circuitId, pk, ps, time));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}

async function setup(collect = 3_600n) {
  const poster = newPrivateState();
  const contributor = newPrivateState();
  const other = newPrivateState();
  return { board: await Board.create(poster, collect), poster, contributor, other };
}

type F = Awaited<ReturnType<typeof setup>>;

async function post(f: F, t: Partial<Terms> = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const id = pureCircuits.bountyIdFor(salt, f.poster.sk);
  const key = await posterKeyFor(f.poster.posterSeed!, ADDRESS, id);
  const terms: Terms = {
    firstToClaim: false,
    deliveryWindow: 3_600n,
    reviewWindow: 3_600n,
    appealWindow: 0n,
    deadline: nowSec() + 7_200n,
    hasArbiter: false,
    arbiter: new Uint8Array(32),
    ...t,
  };
  await f.board.call("postWork", POSTER_PK, f.poster, (ctx) =>
    c.postWork(ctx, salt, freshCoin(COLOR.hex, REWARD), pureCircuits.posterPublicKey(key), terms, "Write a guide", "Link the PR.", nowSec() - 60n),
  );
  return id;
}

function view(f: F, id: Uint8Array, ps: PS): WorkView {
  const v = workViews(f.board.ledger, ADDRESS, ps).find((w) => w.idHex === toHex(id));
  if (!v) throw new Error("no such work");
  return v;
}

/** Run `action` the way the app's call would, as (pk, ps). */
function runAction(action: WorkAction, v: WorkView, extra: { pseudonym?: Uint8Array; now?: bigint } = {}) {
  const now = extra.now ?? nowSec();
  return (ctx: CircuitContext<PS>) => {
    switch (action) {
      case "claim":
        return c.claim(ctx, v.id, windowEnd(v.terms.deliveryWindow, now));
      case "assign":
        return c.assign(ctx, v.id, extra.pseudonym ?? new Uint8Array(32), windowEnd(v.terms.deliveryWindow, now));
      case "release":
        return c.release(ctx, v.id);
      case "submit":
        return c.submit(ctx, v.id, windowEnd(v.terms.reviewWindow, now));
      case "approve":
        return c.approve(ctx, v.id);
      case "reject":
        return c.reject(ctx, v.id, v.terms.hasArbiter ? windowEnd(v.terms.appealWindow, now) : 0n);
      case "overturn":
        return c.overturn(ctx, v.id);
      case "reopen":
        return c.reopen(ctx, v.id);
      case "collect":
        return c.collect(ctx, v.id, freshCoin(COLOR.hex, 0n));
      case "refund":
        return c.refund(ctx, v.id);
    }
  };
}

const ACTIONS: WorkAction[] = ["claim", "assign", "release", "submit", "approve", "reject", "reopen", "collect", "refund"];

/** For every action and every party, workActionError and the circuit agree on pass or fail. */
async function expectMirrors(f: F, id: Uint8Array, pseudonym?: Uint8Array) {
  const parties: [string, string, PS][] = [
    ["poster", POSTER_PK, f.poster],
    ["contributor", CONTRIB_PK, { ...f.contributor, answer: encodeAnswer(LINK) }],
    ["other", OTHER_PK, f.other],
  ];
  for (const [name, pk, ps] of parties) {
    const v = view(f, id, ps);
    for (const a of ACTIONS) {
      // One instant for both sides, or a second ticking over between them, near
      // a window's end, makes them disagree.
      const now = nowSec();
      const predicted = workActionError(a, f.board.ledger, v, now);
      const actual = await f.board.errorOf(a, pk, ps, runAction(a, v, { pseudonym, now }), now);
      expect({ who: name, action: a, passes: actual === null }, `${name} ${a}: app says ${predicted}, circuit says ${actual}`).toEqual({
        who: name,
        action: a,
        passes: predicted === null,
      });
    }
  }
}

// Each mirror check runs every circuit for every party, which takes a while on a busy machine.
describe("reviewed work, against the compiled contract", { timeout: 120_000 }, () => {
  it("applicant mode: the application code reaches the poster, who assigns; submit, review and collect", async () => {
    const f = await setup();
    const id = await post(f);
    await expectMirrors(f, id);

    // The applicant makes a code under their contact key, as the app sends it; the poster opens it
    // and gets the pseudonym the circuit will store, and the key that opens their chat.
    const asApplicant = view(f, id, f.contributor);
    const posterPk = f.board.ledger.works.lookup(id).posterPk;
    const c = await contactKey(f.contributor.sk, ADDRESS, id);
    const code = await makeApplication(
      asApplicant,
      posterPk,
      { pseudonym: contributorPseudonym(ADDRESS, id, f.contributor.sk), plan: "Two weeks, one PR.", name: "ada", links: ["https://github.com/ada"] },
      c,
    );
    const app = await openApplication(f.board.ledger, ADDRESS, view(f, id, f.poster), f.poster.posterSeed!, code);
    expect(app).toMatchObject({ plan: "Two weeks, one PR.", name: "ada", links: ["https://github.com/ada"], contact: publicKeyOf(c) });
    const b = await checkedPosterKey(f.board.ledger, ADDRESS, id, f.poster.posterSeed!);
    expect((await openChannel(b, app.contact, id)).thread).toEqual((await openChannel(c, posterPk, id)).thread);
    await expectMirrors(f, id, app.pseudonym);

    const asPoster = view(f, id, f.poster);
    await f.board.call("assign", POSTER_PK, f.poster, runAction("assign", asPoster, { pseudonym: app.pseudonym }));
    expect(toHex(f.board.ledger.works.lookup(id).contributor)).toEqual(toHex(contributorPseudonym(ADDRESS, id, f.contributor.sk)));
    expect(view(f, id, f.contributor).assignedToMe).toBe(true);
    expect(view(f, id, f.other).assignedToMe).toBe(false);
    await expectMirrors(f, id);

    const withLink = { ...f.contributor, answer: encodeAnswer(LINK) };
    await f.board.call("submit", CONTRIB_PK, withLink, runAction("submit", view(f, id, f.contributor)));
    expect(await readSubmission(f.board.ledger, ADDRESS, id, f.poster.posterSeed!)).toEqual(LINK);
    expect(workItem(view(f, id, f.poster), f.board.ledger, ADDRESS, nowSec()).needs).toEqual("review");
    await expectMirrors(f, id);

    await f.board.call("approve", POSTER_PK, f.poster, runAction("approve", view(f, id, f.poster)));
    expect(workItem(view(f, id, f.contributor), f.board.ledger, ADDRESS, nowSec()).needs).toEqual("collect");
    await expectMirrors(f, id);

    await f.board.call("collect", CONTRIB_PK, f.contributor, runAction("collect", view(f, id, f.contributor)));
    expect(f.board.ledger.works.lookup(id).status).toEqual(WorkStatus.PAID);
    expect(workItem(view(f, id, f.contributor), f.board.ledger, ADDRESS, nowSec()).earnedHere).toBe(true);
    await expectMirrors(f, id);
  });

  it("refuses an application code that was changed, or made for another bounty", async () => {
    const f = await setup();
    const a = await post(f);
    const b = await post(f);
    const code = await makeApplication(view(f, a, f.contributor), f.board.ledger.works.lookup(a).posterPk, {
      pseudonym: contributorPseudonym(ADDRESS, a, f.contributor.sk),
      plan: "plan",
      name: "",
      links: [],
    });
    const open = (id: Uint8Array, text: string, seed = f.poster.posterSeed!) => openApplication(f.board.ledger, ADDRESS, view(f, id, f.poster), seed, text);
    await expect(open(b, code)).rejects.toThrow("This code is for another bounty");
    const tampered = code.slice(0, -2) + (code.endsWith("A") ? "BB" : "AA");
    await expect(open(a, tampered)).rejects.toThrow(/wasn't made for your key, or it was changed/);
    await expect(open(a, "hello")).rejects.toThrow("That isn't an application code");
    await expect(open(a, code, f.other.posterSeed!)).rejects.toThrow(/doesn't match the bounty's/);
  });

  it("first to claim: claim, release, and a window that runs out", async () => {
    const f = await setup(3n);
    // A delivery window of 62 s puts the app's window end two seconds out.
    const id = await post(f, { firstToClaim: true, deliveryWindow: 62n, reviewWindow: 62n });
    await expectMirrors(f, id);
    await f.board.call("claim", CONTRIB_PK, f.contributor, runAction("claim", view(f, id, f.contributor)));
    await expectMirrors(f, id);
    await f.board.call("release", POSTER_PK, f.poster, runAction("release", view(f, id, f.poster)));
    expect(f.board.ledger.works.lookup(id).status).toEqual(WorkStatus.OPEN);
    await f.board.call("claim", OTHER_PK, f.other, runAction("claim", view(f, id, f.other)));
    expect(view(f, id, f.other).assignedToMe).toBe(true);
    await sleep(3);
    // Overdue: anyone can reopen.
    await expectMirrors(f, id);
    expect(workActionError("reopen", f.board.ledger, view(f, id, f.contributor), nowSec())).toBeNull();
  });

  it("silence pays, then the collect-by time hands the reward back to the poster", async () => {
    const f = await setup(10n);
    const id = await post(f, { reviewWindow: 62n });
    const pseudonym = contributorPseudonym(ADDRESS, id, f.contributor.sk);
    await f.board.call("assign", POSTER_PK, f.poster, runAction("assign", view(f, id, f.poster), { pseudonym }));
    const withLink = { ...f.contributor, answer: encodeAnswer(LINK) };
    await f.board.call("submit", CONTRIB_PK, withLink, runAction("submit", view(f, id, f.contributor)));
    const reviewBy = f.board.ledger.works.lookup(id).until;
    await sleep(Number(reviewBy - nowSec()) + 1);
    // Past review-by, inside collect-by (10 s more): silence pays.
    expect(workActionError("collect", f.board.ledger, view(f, id, f.contributor), nowSec())).toBeNull();
    expect(workActionError("refund", f.board.ledger, view(f, id, f.poster), nowSec())).toEqual("Still collectable");
    await expectMirrors(f, id);
    await sleep(Math.max(0, Number(reviewBy + 10n - nowSec()) + 1));
    await expectMirrors(f, id);
    expect(workActionError("collect", f.board.ledger, view(f, id, f.contributor), nowSec())).toEqual("Past the collect-by time");
    expect(workActionError("refund", f.board.ledger, view(f, id, f.poster), nowSec())).toBeNull();
    expect(workItem(view(f, id, f.poster), f.board.ledger, ADDRESS, nowSec()).needs).toEqual("refund");
  });
});
