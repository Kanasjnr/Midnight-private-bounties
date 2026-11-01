// In-memory tests for the factoring bounty. The escrow, deadline and refund
// circuits are the same as bounty_preimage's (see its tests); these cover what
// this template adds: its checker, including the field-wraparound attack.

import { describe, expect, it } from 'vitest';
import { Sim, assertNotInPublicState, expectRejects } from '@midnight-ntwrk/example-sim';
import { Contract, ledger, pureCircuits, Status } from '../../contract/managed/bounty_factor/contract/index.js';
import { bountyWitnesses, createBountyPrivateState, randomScalar } from '../../contract/witnesses.js';

const REWARD = 100n;
const STAKE = 10n;
const TITLE = 'Factor a 62-bit number';
const DETAILS = 'N is the product of two primes. Send p and q.';
const POSTER_PK = 'b0'.repeat(32);
const SOLVER_PK = 'a0'.repeat(32);
// Two 31-bit primes, and their product.
const P = 2147483647n;
const Q = 2147483629n;
const N = P * Q;
// A 101-bit number: 3 × BIG is below 2^128, but BIG is too big for 64 bits.
const BIG = (1n << 100n) + 277n;
// The BLS12-381 scalar field, which Compact's Field is.
const R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

const rand32 = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(32));
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const nowSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const fieldBytes = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return b;
};
const modPow = (b: bigint, e: bigint, m: bigint): bigint => {
  let r = 1n;
  b %= m;
  for (; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
};

const color = rand32();
const freshCoin = (value: bigint) => ({ nonce: rand32(), color, value });

function setup(n: bigint = N) {
  const posterSk = rand32();
  const solverSk = rand32();
  const posterKey = randomScalar();
  const sim = Sim.deploy({
    contract: new Contract(bountyWitnesses),
    ledger,
    privateState: createBountyPrivateState(posterSk),
    args: [color],
    coinPublicKey: POSTER_PK,
  });
  const id = rand32();
  sim.call('postBounty', id, freshCoin(REWARD), pureCircuits.posterPublicKey(posterKey), n, nowSec() + 3600n, TITLE, DETAILS);
  const submitAs = (answer: bigint[]) => {
    sim.as(SOLVER_PK).privateState = createBountyPrivateState(solverSk, answer);
    return sim.call('submit', id, freshCoin(STAKE));
  };
  return { sim, id, posterSk, solverSk, posterKey, submitAs };
}

describe('bounty_factor (in memory)', () => {
  it('pays for true factors and stores them encrypted to the poster', () => {
    const f = setup();
    f.submitAs([P, Q, 0n, 0n]);
    const l = f.sim.ledger();
    expect(l.bounties.lookup(f.id).status).toEqual(Status.SOLVED);
    expect(l.bounties.lookup(f.id).target).toEqual(N);
    expect(l.listings.lookup(f.id)).toEqual({ title: TITLE, details: DETAILS });
    const paid = (f.sim.lastContext?.currentZswapLocalState.outputs ?? []).filter(
      (o) => o.recipient.is_left && hex(o.recipient.left.bytes) === SOLVER_PK && o.coinInfo.value === REWARD + STAKE,
    );
    expect(paid).toHaveLength(1);
    expect(pureCircuits.decrypt(l.deliveries.lookup(f.id), f.posterKey, f.id)).toEqual([P, Q, 0n, 0n]);
    assertNotInPublicState(l, {
      posterSk: f.posterSk,
      solverSk: f.solverSk,
      posterKey: fieldBytes(f.posterKey),
      p: fieldBytes(P),
      q: fieldBytes(Q),
    });
  });

  it('rejects the trivial factorisation 1 × N, either way round', () => {
    const f = setup();
    expectRejects(() => f.submitAs([1n, N, 0n, 0n]), 'Wrong answer');
    expectRejects(() => f.submitAs([N, 1n, 0n, 0n]), 'Wrong answer');
    expect(f.sim.ledger().bounties.lookup(f.id).status).toEqual(Status.OPEN);
  });

  it('pays for a factorisation whose larger factor is above 2^64 (audit L2)', () => {
    const f = setup(3n * BIG);
    f.submitAs([3n, BIG, 0n, 0n]);
    expect(f.sim.ledger().bounties.lookup(f.id).status).toEqual(Status.SOLVED);
  });

  it('rejects an N that no 64 × 128-bit factorisation could reach, at post time', () => {
    expectRejects(() => setup(1n << 128n), 'cast from Field or Uint value to smaller Uint value failed');
    expectRejects(() => setup(3n), 'N must be at least 4');
  });

  it('rejects factors whose product is not N', () => {
    const f = setup();
    expectRejects(() => f.submitAs([P, Q + 2n, 0n, 0n]), 'Wrong answer');
  });

  it('rejects fake factors that only multiply to N modulo the field', () => {
    const f = setup();
    // q = N / p in the field: p × q == N in field arithmetic, but q is huge.
    const p = 3n;
    const q = (N * modPow(p, R - 2n, R)) % R;
    expect((p * q) % R).toEqual(N);
    expect(q >= 1n << 128n).toBe(true);
    // The 128-bit cast in the checker is what stops it.
    expectRejects(() => f.submitAs([p, q, 0n, 0n]), 'cast from Field or Uint value to smaller Uint value failed');
    expect(f.sim.ledger().bounties.lookup(f.id).status).toEqual(Status.OPEN);
    expect(f.sim.ledger().deliveries.member(f.id)).toBe(false);
  });

  it('checkAnswer matches the in-circuit checker', () => {
    expect(pureCircuits.checkAnswer([P, Q, 0n, 0n], N)).toBe(true);
    expect(pureCircuits.checkAnswer([Q, P, 0n, 0n], N)).toBe(true);
    expect(pureCircuits.checkAnswer([1n, N, 0n, 0n], N)).toBe(false);
  });
});
