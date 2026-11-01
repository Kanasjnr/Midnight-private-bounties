// Spike Q13: the reviewed-work contract in memory. Every window is checked
// with block-time comparisons only; the simulator's block time follows the
// wall clock, so the window tests use windows of a few seconds and sleep.

import { describe, expect, it } from 'vitest';
import { Sim, assertNotInPublicState, expectRejects } from '@midnight-ntwrk/example-sim';
import {
  CompactTypeBytes,
  CompactTypeVector,
  encodeContractAddress,
  persistentHash,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { Contract, ledger, pureCircuits, Status, type Terms } from '../../contract/managed/reviewed_work/contract/index.js';
import { createWorkPrivateState, randomScalar, workWitnesses } from '../../contract/witnesses.js';

const REWARD = 100n;
const STAKE = 10n;
const SLACK = 3n;
const POSTER_PK = 'b0'.repeat(32); // coin public keys, hex
const CONTRIBUTOR_PK = 'a0'.repeat(32);
const OTHER_PK = 'c0'.repeat(32);
const ARBITER_PK = 'd0'.repeat(32);

const rand32 = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(32));
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const nowSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const pad32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label));
  return out;
};
const fieldBytes = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return b;
};

const color = rand32();
const freshCoin = (value: bigint) => ({ nonce: rand32(), color, value });

function setup() {
  const posterSk = rand32();
  const contributorSk = rand32();
  const otherSk = rand32();
  const arbiterSk = rand32();
  const posterKey = randomScalar(); // the poster's encryption secret, off-chain only
  const link = [randomScalar(), randomScalar(), randomScalar(), randomScalar()];
  const sim = Sim.deploy({
    contract: new Contract(workWitnesses),
    ledger,
    privateState: createWorkPrivateState(posterSk),
    args: [color, SLACK],
    coinPublicKey: POSTER_PK,
  });
  const as = (pk: string, sk: Uint8Array, answer?: bigint[]) => {
    sim.as(pk).privateState = createWorkPrivateState(sk, answer);
    return sim;
  };
  const poster = () => as(POSTER_PK, posterSk);
  const contributor = () => as(CONTRIBUTOR_PK, contributorSk, link);
  const other = () => as(OTHER_PK, otherSk, link);
  const arbiter = () => as(ARBITER_PK, arbiterSk);

  const terms = (t: Partial<Terms> = {}): Terms => ({
    firstToClaim: true,
    deliveryWindow: 10n,
    reviewWindow: 10n,
    appealWindow: 10n,
    deadline: nowSec() + 120n,
    hasArbiter: false,
    arbiter: new Uint8Array(32),
    ...t,
  });
  const post = (t: Partial<Terms> = {}) => {
    const id = rand32();
    const tt = terms(t);
    poster().call('postWork', id, freshCoin(REWARD), pureCircuits.posterPublicKey(posterKey), tt);
    return { id, terms: tt };
  };
  const work = (id: Uint8Array) => sim.ledger().works.lookup(id);
  /** The per-bounty contributor pseudonym, worked out off chain the way an applicant would. */
  const pseudonym = (id: Uint8Array, sk: Uint8Array) =>
    persistentHash(new CompactTypeVector(4, new CompactTypeBytes(32)), [
      pad32('bounty:contributor'),
      encodeContractAddress(sim.address),
      id,
      sk,
    ]);
  /** Coin outputs of the last call that pay `pk` exactly `value`. */
  const paid = (pk: string, value: bigint) =>
    (sim.lastContext?.currentZswapLocalState.outputs ?? []).filter(
      (o) => o.recipient.is_left && hex(o.recipient.left.bytes) === pk && o.coinInfo.value === value,
    );
  /** Claim in first-to-claim mode with a deliver-by at exactly now + window. */
  const claimed = (t: Partial<Terms> = {}) => {
    const p = post(t);
    contributor().call('claim', p.id, nowSec() + p.terms.deliveryWindow);
    return p;
  };
  const submitted = (t: Partial<Terms> = {}) => {
    const p = claimed(t);
    contributor().call('submit', p.id, nowSec() + p.terms.reviewWindow);
    return p;
  };

  return {
    sim, posterSk, contributorSk, otherSk, arbiterSk, posterKey, link,
    poster, contributor, other, arbiter, post, work, pseudonym, paid, claimed, submitted,
  };
}

describe('reviewed work (in memory)', () => {
  describe('1. exclusive claim window', () => {
    it('accepts a deliver-by of now + window and records the claimer under a pseudonym', () => {
      const f = setup();
      const { id } = f.post();
      const deliverBy = nowSec() + 10n;
      f.contributor().call('claim', id, deliverBy);
      const w = f.work(id);
      expect(w.status).toEqual(Status.ASSIGNED);
      expect(w.until).toEqual(deliverBy);
      // The pseudonym an applicant computes off chain is the one the circuit stores.
      expect(hex(w.contributor)).toEqual(hex(f.pseudonym(id, f.contributorSk)));
      expect(hex(w.contributor)).not.toEqual(hex(f.contributorSk));
    });

    it('rejects a deliver-by later than now + window, or more than the slack earlier', () => {
      const f = setup();
      const { id } = f.post();
      expectRejects(() => f.contributor().call('claim', id, nowSec() + 10n + 5n), 'Window end is too late');
      expectRejects(() => f.contributor().call('claim', id, nowSec() + 10n - SLACK - 3n), 'Window end is too early');
      expect(f.work(id).status).toEqual(Status.OPEN);
    });

    it('lets only one contributor hold the work', () => {
      const f = setup();
      const { id } = f.claimed();
      expectRejects(() => f.other().call('claim', id, nowSec() + 10n), 'Not open');
    });

    it('applicant mode: claiming is refused and only the poster can assign', () => {
      const f = setup();
      const { id } = f.post({ firstToClaim: false });
      const applicant = f.pseudonym(id, f.contributorSk);
      expectRejects(() => f.contributor().call('claim', id, nowSec() + 10n), 'The poster assigns this work');
      expectRejects(() => f.other().call('assign', id, applicant, nowSec() + 10n), 'Only the poster can assign');
      // The poster can't shorten the window either: the same check applies.
      expectRejects(() => f.poster().call('assign', id, applicant, nowSec() + 2n), 'Window end is too early');
      f.poster().call('assign', id, applicant, nowSec() + 10n);
      expect(hex(f.work(id).contributor)).toEqual(hex(applicant));
      // The applicant, and nobody else, can now submit.
      expectRejects(() => f.other().call('submit', id, nowSec() + 10n), 'Only the assigned contributor can submit');
      f.contributor().call('submit', id, nowSec() + 10n);
      expect(f.work(id).status).toEqual(Status.SUBMITTED);
    });

    it('reopens for anyone once the delivery window runs out, and can be claimed again', async () => {
      const f = setup();
      const { id } = f.claimed({ deliveryWindow: 3n });
      expectRejects(() => f.other().call('reopen', id), 'Deadline has not passed');
      await sleep(4);
      expectRejects(() => f.contributor().call('submit', id, nowSec() + 10n), 'Deadline has passed');
      f.other().call('reopen', id);
      expect(f.work(id).status).toEqual(Status.OPEN);
      expect(hex(f.work(id).contributor)).toEqual(hex(new Uint8Array(32)));
      f.other().call('claim', id, nowSec() + 3n);
      expect(hex(f.work(id).contributor)).toEqual(hex(f.pseudonym(id, f.otherSk)));
    });

    it('closes claims once a full delivery window no longer fits before the final deadline', () => {
      const f = setup();
      const { id } = f.post({ deliveryWindow: 30n, deadline: nowSec() + 20n });
      expectRejects(() => f.contributor().call('claim', id, nowSec() + 30n), 'Past the final deadline');
      expectRejects(() => f.contributor().call('claim', id, nowSec() + 20n), 'Window end is too early');
    });
  });

  describe('2. review clock', () => {
    it('stores the submission encrypted to the poster, with a review-by inside the window', () => {
      const f = setup();
      const { id } = f.claimed();
      // The contributor would like a short review; the lower bound stops that.
      expectRejects(() => f.contributor().call('submit', id, nowSec() + 2n), 'Window end is too early');
      expectRejects(() => f.contributor().call('submit', id, nowSec() + 30n), 'Window end is too late');
      const reviewBy = nowSec() + 10n;
      f.contributor().call('submit', id, reviewBy);
      const w = f.work(id);
      expect(w.status).toEqual(Status.SUBMITTED);
      expect(w.until).toEqual(reviewBy);
      const d = f.sim.ledger().submissions.lookup(id);
      expect(d.c).not.toEqual(f.link);
      expect(pureCircuits.decrypt(d, f.posterKey, id)).toEqual(f.link);
    });

    it('lets only the poster approve', () => {
      const f = setup();
      const { id } = f.submitted();
      expectRejects(() => f.contributor().call('approve', id), 'Only the poster can approve');
      expectRejects(() => f.other().call('approve', id), 'Only the poster can approve');
      f.poster().call('approve', id);
      expect(f.work(id).status).toEqual(Status.APPROVED);
    });

    it('silence pays: collect waits for approval or for the review window to end', async () => {
      const f = setup();
      const { id } = f.submitted({ reviewWindow: 3n });
      expectRejects(() => f.contributor().call('collect', id, freshCoin(0n)), 'Not approved, and the review window is still open');
      await sleep(4);
      // The poster missed the window: too late to reject.
      expectRejects(() => f.poster().call('reject', id, nowSec() + 10n), 'Deadline has passed');
      f.contributor().call('collect', id, freshCoin(0n));
      expect(f.work(id).status).toEqual(Status.PAID);
      expect(f.paid(CONTRIBUTOR_PK, REWARD)).toHaveLength(1);
    });
  });

  describe('3. collect', () => {
    it('merges the contributor’s fresh coin first and pays reward plus coin to the caller', () => {
      const f = setup();
      const { id } = f.submitted();
      f.poster().call('approve', id);
      expectRejects(() => f.other().call('collect', id, freshCoin(STAKE)), 'Only the contributor can collect');
      f.contributor().call('collect', id, freshCoin(STAKE));
      expect(f.paid(CONTRIBUTOR_PK, REWARD + STAKE)).toHaveLength(1);
      expect(f.sim.ledger().escrows.member(id)).toBe(false);
      expect(f.work(id).status).toEqual(Status.PAID);
      expectRejects(() => f.contributor().call('collect', id, freshCoin(STAKE)), 'Not approved, and the review window is still open');
    });

    it('works with a zero-value coin', () => {
      const f = setup();
      const { id } = f.submitted();
      f.poster().call('approve', id);
      f.contributor().call('collect', id, freshCoin(0n));
      expect(f.paid(CONTRIBUTOR_PK, REWARD)).toHaveLength(1);
    });
  });

  describe('4. arbiter', () => {
    const withArbiter = (f: ReturnType<typeof setup>, t: Partial<Terms> = {}) =>
      f.submitted({ hasArbiter: true, arbiter: pureCircuits.arbiterId(f.arbiterSk), ...t });

    it('needs an appeal window when there is an arbiter', () => {
      const f = setup();
      expectRejects(
        () => f.post({ hasArbiter: true, arbiter: pureCircuits.arbiterId(f.arbiterSk), appealWindow: 0n }),
        'An arbiter needs an appeal window',
      );
    });

    it('a rejection waits out the appeal window, and only the arbiter can overturn it', () => {
      const f = setup();
      const { id } = withArbiter(f);
      expectRejects(() => f.contributor().call('reject', id, nowSec() + 10n), 'Only the poster can reject');
      // The poster can't shorten the appeal window.
      expectRejects(() => f.poster().call('reject', id, nowSec() + 2n), 'Window end is too early');
      f.poster().call('reject', id, nowSec() + 10n);
      expect(f.work(id).status).toEqual(Status.REJECTED);
      expectRejects(() => f.other().call('reopen', id), 'Deadline has not passed');
      expectRejects(() => f.poster().call('overturn', id), 'Only the arbiter can overturn');
      expectRejects(() => f.contributor().call('overturn', id), 'Only the arbiter can overturn');
      f.arbiter().call('overturn', id);
      expect(f.work(id).status).toEqual(Status.APPROVED);
      f.contributor().call('collect', id, freshCoin(0n));
      expect(f.paid(CONTRIBUTOR_PK, REWARD)).toHaveLength(1);
    });

    it('after the appeal window, anyone can reopen and the arbiter can no longer overturn', async () => {
      const f = setup();
      const { id } = withArbiter(f, { appealWindow: 3n });
      f.poster().call('reject', id, nowSec() + 3n);
      await sleep(4);
      expectRejects(() => f.arbiter().call('overturn', id), 'Deadline has passed');
      f.other().call('reopen', id);
      expect(f.work(id).status).toEqual(Status.OPEN);
    });

    it('without an arbiter, a rejection reopens the work at once', () => {
      const f = setup();
      const { id } = f.submitted();
      f.poster().call('reject', id, 0n);
      expect(f.work(id).status).toEqual(Status.OPEN);
      expectRejects(() => f.arbiter().call('overturn', id), 'Only the arbiter can overturn');
    });
  });

  describe('5. refund', () => {
    it('pays the poster back after the final deadline when nobody delivered', async () => {
      const f = setup();
      const { id } = f.post({ deadline: nowSec() + 3n });
      expectRejects(() => f.poster().call('refund', id), 'Deadline has not passed');
      await sleep(4);
      expectRejects(() => f.other().call('refund', id), 'Only the poster can refund');
      f.poster().call('refund', id);
      expect(f.work(id).status).toEqual(Status.REFUNDED);
      expect(f.paid(POSTER_PK, REWARD)).toHaveLength(1);
    });

    it('refunds an assignment that ran out, but never submitted work', async () => {
      const f = setup();
      const a = f.claimed({ deliveryWindow: 3n, deadline: nowSec() + 4n });
      const s = setup();
      const b = s.submitted({ deliveryWindow: 3n, reviewWindow: 30n, deadline: nowSec() + 4n });
      await sleep(5);
      f.poster().call('refund', a.id);
      expect(f.work(a.id).status).toEqual(Status.REFUNDED);
      expectRejects(() => s.poster().call('refund', b.id), 'Not refundable');
      // The submitted work can still be approved and collected after the deadline.
      s.poster().call('approve', b.id);
      s.contributor().call('collect', b.id, freshCoin(0n));
      expect(s.paid(CONTRIBUTOR_PK, REWARD)).toHaveLength(1);
    });
  });

  describe('privacy (in memory)', () => {
    it('keeps every secret, the submission and the contributor coin out of public state', () => {
      const f = setup();
      const { id } = f.submitted({ hasArbiter: true, arbiter: pureCircuits.arbiterId(f.arbiterSk) });
      f.poster().call('approve', id);
      const stake = freshCoin(STAKE);
      f.contributor().call('collect', id, stake);
      const secrets: Record<string, Uint8Array> = {
        posterSk: f.posterSk,
        contributorSk: f.contributorSk,
        arbiterSk: f.arbiterSk,
        posterKey: fieldBytes(f.posterKey),
        stakeNonce: stake.nonce,
      };
      f.link.forEach((m, i) => (secrets[`link[${i}]`] = fieldBytes(m)));
      assertNotInPublicState(f.sim.ledger(), secrets);
    });
  });
});
