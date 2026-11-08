// Spike Q16, in memory: the preimage bounty's JS on runtime 0.21 (Ledger 9).
// Post, a wrong answer, a right answer, decrypt, an early refund.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type CircuitContext,
} from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import { Contract, ledger, pureCircuits as pure, Status } from '../../contract/managed/bounty_preimage/contract/index.js';
import { createBountyPrivateState, randomScalar, witnesses, type BountyPrivateState } from '../../contract/witnesses.js';
import { posterKeyFor } from '../../contract/keys.js';
import { freshCoin, tokenColor } from './coins.js';

const ADDRESS = sampleContractAddress();
const COLOR = tokenColor('bounty:test-token', sampleContractAddress());
const POSTER_PK = 'b0'.repeat(32);
const SOLVER_PK = 'a0'.repeat(32);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
type PS = BountyPrivateState;

describe('Q16: preimage bounty on runtime 0.21', () => {
  const c = new Contract(witnesses);
  const poster = createBountyPrivateState(new Uint8Array(randomBytes(32)));
  let data: Awaited<ReturnType<typeof c.initialState>>['currentContractState']['data'];
  const ctx = (circuitId: string, pk: string, ps: PS): CircuitContext<PS> =>
    createCircuitContext({ circuitId, contractAddress: ADDRESS, coinPublicKeyOrZswapState: pk, contractState: data, privateState: ps });

  it('posts, rejects a wrong answer, pays a right one, and the poster decrypts', async () => {
    // Ledger 9: the constructor and every impure circuit return a Promise.
    data = (await c.initialState(createConstructorContext(poster, POSTER_PK), COLOR.bytes, 1n, 0n)).currentContractState.data;
    const answer = [randomScalar(), randomScalar(), randomScalar(), randomScalar()];
    const salt = new Uint8Array(randomBytes(32));
    const id = pure.bountyIdFor(salt, poster.sk);
    const seed = new Uint8Array(randomBytes(32));
    const key = await posterKeyFor(seed, ADDRESS, id);
    const posted = await c.impureCircuits.postBounty(
      ctx('postBounty', POSTER_PK, poster),
      salt, freshCoin(COLOR, 100n), pure.posterPublicKey(key), pure.answerHash(answer), nowSec() + 3600n, 'Q16', 'sim', nowSec() - 60n,
    );
    data = posted.context.callContext.currentQueryContext.state as typeof data;
    expect(ledger(data).bounties.lookup(id).status).toEqual(Status.OPEN);

    const wrong = [...answer];
    wrong[0] += 1n;
    const solver = (a: bigint[]) => createBountyPrivateState(new Uint8Array(randomBytes(32)), a);
    await expect(c.impureCircuits.submit(ctx('submit', SOLVER_PK, solver(wrong)), id, freshCoin(COLOR, 0n))).rejects.toThrow(/Wrong answer/);
    await expect(c.impureCircuits.refund(ctx('refund', POSTER_PK, poster), id)).rejects.toThrow(/Deadline has not passed/);

    const solved = await c.impureCircuits.submit(ctx('submit', SOLVER_PK, solver(answer)), id, freshCoin(COLOR, 0n));
    data = solved.context.callContext.currentQueryContext.state as typeof data;
    const l = ledger(data);
    expect(l.bounties.lookup(id).status).toEqual(Status.SOLVED);
    expect(pure.decrypt(l.deliveries.lookup(id), key, id)).toEqual(answer);
  });
});
