// @vitest-environment node
//
// The activity feed's state comparison, on real states from the compiled
// factor contract: a post, then a solve, read back as two events naming the
// bounty, with the oldest state only as context.
import { describe, expect, it } from "vitest";
import { createCircuitContext, createConstructorContext, sampleContractAddress } from "@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime";
import * as Factor from "../../../contract/managed/bounty_factor/contract/index.js";
import { posterKeyFor } from "../../../contract/keys.js";
import { witnesses } from "../../../contract/witnesses.js";
import { freshCoin, newPrivateState, tokenColor } from "@/midnight/private-bounties-api";
import { factorAnswer } from "~/midnight/verified-api";
import { eventsFrom, snapshot, wording, type Step } from "~/midnight/activity";

const ADDRESS = sampleContractAddress();
const COLOR = tokenColor(sampleContractAddress());
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

describe("activity feed", () => {
  it("names the bounty each action touched", async () => {
    const poster = newPrivateState();
    const c = new Factor.Contract(witnesses);
    let data = (await c.initialState(createConstructorContext(poster, "b0".repeat(32)), COLOR.bytes, 1n, 0n)).currentContractState.data;
    const ctx = (circuitId: string, pk: string, privateState: typeof poster) =>
      createCircuitContext({ circuitId, contractAddress: ADDRESS, coinPublicKeyOrZswapState: pk, contractState: data, privateState });
    const step = (circuit: string, at: number): Step => ({ kind: "factor", address: ADDRESS, circuit, at, hash: `h${at}`, bounties: snapshot("factor", ADDRESS, data) });
    const steps: Step[] = [step("deploy", 1)];

    const salt = crypto.getRandomValues(new Uint8Array(32));
    const id = Factor.pureCircuits.bountyIdFor(salt, poster.sk);
    const key = await posterKeyFor(poster.posterSeed!, ADDRESS, id);
    const N = 2147483647n * 2147483629n;
    data = (
      await c.impureCircuits.postBounty(
        ctx("postBounty", "b0".repeat(32), poster),
        salt, freshCoin(COLOR.hex, 100n), Factor.pureCircuits.posterPublicKey(key), N, nowSec() + 3600n, "Factor it", "Two primes.", nowSec() - 60n,
      )
    ).context.callContext.currentQueryContext.state as typeof data;
    steps.unshift(step("postBounty", 2));

    const solver = { ...newPrivateState(), answer: factorAnswer("2147483647", "2147483629") };
    data = (await c.impureCircuits.submit(ctx("submit", "a0".repeat(32), solver), id, freshCoin(COLOR.hex, 0n))).context.callContext.currentQueryContext.state as typeof data;
    steps.unshift(step("submit", 3));

    const events = eventsFrom(steps);
    expect(events.map((e) => [e.text, e.title, e.reward])).toEqual([
      ["Solved and paid", "Factor it", 100n],
      ["New bounty", "Factor it", 100n],
      ["Factor bounties added to the board", null, null],
    ]);
    // Without the step before it, the oldest action is context only.
    expect(eventsFrom(steps.slice(0, 2)).map((e) => e.text)).toEqual(["Solved and paid"]);

    // The same history in the words of the poster and of the solver.
    expect(events.map((e) => wording(e, "poster"))).toEqual(["Solved: the answer is ready to read", "You posted it with 100 TEST", null]);
    expect(events.map((e) => wording(e, "solver"))).toEqual(["You solved it and were paid", null, null]);
  });
});
