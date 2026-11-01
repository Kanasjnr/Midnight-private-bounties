// In-memory tests for the preimage bounty: every circuit and every guard, run
// in compact-runtime with no network and no proofs. Fast enough for every edit.

import { describe, expect, it } from 'vitest';
import { Sim, assertNotInPublicState, expectRejects } from '@midnight-ntwrk/example-sim';
import {
  Contract,
  ledger,
  pureCircuits,
  Status,
  type Delivery,
} from '../../contract/managed/bounty_preimage/contract/index.js';
import { bountyWitnesses, createBountyPrivateState, randomScalar } from '../../contract/witnesses.js';
import { posterKeyFor } from '../../contract/keys.js';

const REWARD = 100n;
const STAKE = 10n;
// The deploy-time minimums. Most tests use short deadlines, so no minimum window.
const MIN_REWARD = 1n;
const MIN_WINDOW = 0n;
const TITLE = 'Name the ship in the bottle';
const DETAILS = 'What was the ship in the bottle on the mantel called? One word, as on its label. ⛵';
const POSTER_PK = 'b0'.repeat(32); // coin public keys, hex
const SOLVER_PK = 'a0'.repeat(32);
const OTHER_PK = 'c0'.repeat(32);

const rand32 = (): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(32));
const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const nowSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A field element as the 32 little-endian bytes it would occupy in state. */
const fieldBytes = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return b;
};

const color = rand32();
const otherColor = rand32();
const freshCoin = (value: bigint, c: Uint8Array = color) => ({ nonce: rand32(), color: c, value });

type Fixture = ReturnType<typeof setup>;

function setup(minReward = MIN_REWARD, minWindow = MIN_WINDOW) {
  const posterSk = rand32();
  const solverSk = rand32();
  const posterKey = randomScalar(); // b: the poster's encryption secret, off-chain only
  const answer = [randomScalar(), randomScalar(), randomScalar(), randomScalar()];
  const target = pureCircuits.answerHash(answer);
  const sim = Sim.deploy({
    contract: new Contract(bountyWitnesses),
    ledger,
    privateState: createBountyPrivateState(posterSk),
    args: [color, minReward, minWindow],
    coinPublicKey: POSTER_PK,
  });

  const asPoster = () => {
    sim.as(POSTER_PK).privateState = createBountyPrivateState(posterSk);
    return sim;
  };
  const asSolver = (ans: bigint[] = answer, pk = SOLVER_PK, sk = solverSk) => {
    sim.as(pk).privateState = createBountyPrivateState(sk, ans);
    return sim;
  };
  // The ID comes from a fresh salt and the poster's secret (second audit, L3).
  const idFor = (salt: Uint8Array) => pureCircuits.bountyIdFor(salt, posterSk);
  const post = (deadline: bigint = nowSec() + 3600n) => {
    const salt = rand32();
    const reward = freshCoin(REWARD);
    asPoster().call('postBounty', salt, reward, pureCircuits.posterPublicKey(posterKey), target, deadline, TITLE, DETAILS, nowSec());
    return { id: idFor(salt), salt, reward };
  };
  /** Coin outputs of the last call that pay `pk` exactly `value`. */
  const paid = (pk: string, value: bigint) =>
    (sim.lastContext?.currentZswapLocalState.outputs ?? []).filter(
      (o) => o.recipient.is_left && hex(o.recipient.left.bytes) === pk && o.coinInfo.value === value,
    );

  return { sim, posterSk, solverSk, posterKey, answer, target, asPoster, asSolver, idFor, post, paid };
}

describe('bounty_preimage (in memory)', () => {
  it('deploys with the reward token color', () => {
    const { sim } = setup();
    expect(hex(sim.ledger().rewardColor)).toEqual(hex(color));
    expect(sim.ledger().bounties.isEmpty()).toBe(true);
  });

  describe('postBounty', () => {
    it('escrows the reward and records an open bounty under a pseudonym', () => {
      const f = setup();
      const { id, reward } = f.post();
      const l = f.sim.ledger();
      const b = l.bounties.lookup(id);
      expect(b.status).toEqual(Status.OPEN);
      expect(b.target).toEqual(f.target);
      // The reward coin is public by design (whoever solves it must spend it).
      expect(hex(l.escrows.lookup(id).nonce)).toEqual(hex(reward.nonce));
      expect(l.escrows.lookup(id).value).toEqual(REWARD);
      // The listing's reward is the escrowed coin's value (second audit, S4).
      expect(l.listings.lookup(id).reward).toEqual(l.escrows.lookup(id).value);
      // The poster is a pseudonym, not their secret.
      expect(hex(b.poster)).not.toEqual(hex(f.posterSk));
    });

    it('stores the title, details and reward once, as posted', () => {
      const f = setup();
      const { id } = f.post();
      const posted = { title: TITLE, details: DETAILS, reward: REWARD };
      expect(f.sim.ledger().listings.lookup(id)).toMatchObject(posted);
      // Solving rewrites the bounty record and removes the escrow, not the
      // listing, so the board can still show what was paid.
      f.asSolver().call('submit', id, freshCoin(STAKE));
      expect(f.sim.ledger().escrows.member(id)).toBe(false);
      expect(f.sim.ledger().listings.lookup(id)).toMatchObject(posted);
    });

    it('takes a post time from 15 minutes before the block time up to the block time', () => {
      const f = setup();
      const pk = pureCircuits.posterPublicKey(f.posterKey);
      const soon = nowSec() + 3600n;
      const post = (postedAt: bigint, salt = rand32()) =>
        f.asPoster().call('postBounty', salt, freshCoin(REWARD), pk, f.target, soon, TITLE, DETAILS, postedAt);
      expectRejects(() => post(nowSec() + 60n), 'Post time is in the future');
      // Exactly 15 minutes old is already too old (second audit, S4).
      expectRejects(() => post(nowSec() - 900n), 'Post time is too old');
      const salt = rand32();
      const postedAt = nowSec() - 895n;
      post(postedAt, salt);
      expect(f.sim.ledger().listings.lookup(f.idFor(salt)).postedAt).toEqual(postedAt);
    });

    it("takes long text up to the ledger's 32 KiB cell bound, and no more", () => {
      const f = setup();
      const pk = pureCircuits.posterPublicKey(f.posterKey);
      const post = (details: string, salt = rand32()) =>
        f.asPoster().call('postBounty', salt, freshCoin(REWARD), pk, f.target, nowSec() + 3600n, '', details, nowSec());
      const salt = rand32();
      const long = 'ζ'.repeat(2000);
      post(long, salt);
      expect(f.sim.ledger().listings.lookup(f.idFor(salt))).toMatchObject({ title: '', details: long });
      // The contract can't check an Opaque string's length; the ledger caps a
      // cell at 32,768 bytes (second audit, L1 and S4).
      post('A'.repeat(32_700));
      expectRejects(() => post('A'.repeat(32_800)), 'Cell exceeded maximum bound of 32768');
    });

    it('enforces the deploy-time minimum reward and minimum open window (second audit, L1)', () => {
      const f = setup(50n, 3600n);
      const pk = pureCircuits.posterPublicKey(f.posterKey);
      const now = nowSec();
      const post = (reward: bigint, deadline: bigint) =>
        f.asPoster().call('postBounty', rand32(), freshCoin(reward), pk, f.target, deadline, TITLE, DETAILS, now);
      expectRejects(() => post(49n, now + 7200n), 'Reward is below the minimum');
      expectRejects(() => post(50n, now + 3599n), 'Deadline is too soon');
      post(50n, now + 3600n);
      expect(f.sim.ledger().minReward).toEqual(50n);
      expect(f.sim.ledger().minWindow).toEqual(3600n);
    });

    it("can't be front-run with the poster's bounty ID (second audit, L3)", () => {
      const f = setup();
      const pk = pureCircuits.posterPublicKey(f.posterKey);
      const soon = nowSec() + 3600n;
      const salt = rand32();
      const victimId = f.idFor(salt);
      // A squatter who copies the pending post, salt included, gets a bounty
      // under their own secret, which is a different ID.
      f.sim.as(OTHER_PK).privateState = createBountyPrivateState(rand32());
      f.sim.call('postBounty', salt, freshCoin(REWARD), pk, f.target, soon, TITLE, DETAILS, nowSec());
      expect(f.sim.ledger().bounties.member(victimId)).toBe(false);
      // So the poster's own post still lands, under the ID they expected.
      f.asPoster().call('postBounty', salt, freshCoin(REWARD), pk, f.target, soon, TITLE, DETAILS, nowSec());
      expect(f.sim.ledger().bounties.member(victimId)).toBe(true);
      expect(f.sim.ledger().bounties.size()).toEqual(2n);
    });

    it('rejects a duplicate id, the wrong token, an empty coin and a past deadline', () => {
      const f = setup();
      const { salt } = f.post();
      const pk = pureCircuits.posterPublicKey(f.posterKey);
      const soon = nowSec() + 3600n;
      expectRejects(() => f.asPoster().call('postBounty', salt, freshCoin(REWARD), pk, f.target, soon, TITLE, DETAILS, nowSec()), 'Bounty already exists');
      expectRejects(() => f.asPoster().call('postBounty', rand32(), freshCoin(REWARD, otherColor), pk, f.target, soon, TITLE, DETAILS, nowSec()), 'Wrong token');
      expectRejects(() => f.asPoster().call('postBounty', rand32(), freshCoin(0n), pk, f.target, soon, TITLE, DETAILS, nowSec()), 'Reward has no value');
      expectRejects(() => f.asPoster().call('postBounty', rand32(), freshCoin(REWARD), pk, f.target, nowSec() - 1n, TITLE, DETAILS, nowSec()), 'Deadline has passed');
    });
  });

  describe('poster keys (audit H2, L1)', () => {
    it("can't link a poster's bounties through the pseudonym or the encryption key", async () => {
      const f = setup();
      const seed = rand32();
      const salts = [rand32(), rand32()];
      const ids = salts.map(f.idFor);
      for (const [i, id] of ids.entries()) {
        const b = await posterKeyFor(seed, f.sim.address, id);
        f.asPoster().call('postBounty', salts[i], freshCoin(REWARD), pureCircuits.posterPublicKey(b), f.target, nowSec() + 3600n, TITLE, DETAILS, nowSec());
      }
      const [b1, b2] = ids.map((id) => f.sim.ledger().bounties.lookup(id));
      expect(hex(b1.poster)).not.toEqual(hex(b2.poster));
      expect(b1.posterPk.x).not.toEqual(b2.posterPk.x);

      // The poster still decrypts each delivery with that bounty's own key.
      f.asSolver().call('submit', ids[1], freshCoin(STAKE));
      const key = await posterKeyFor(seed, f.sim.address, ids[1]);
      expect(pureCircuits.decrypt(f.sim.ledger().deliveries.lookup(ids[1]), key, ids[1])).toEqual(f.answer);
    });

    it('rejects a poster key nobody should encrypt to', () => {
      const f = setup();
      const soon = nowSec() + 3600n;
      // The identity point would make every shared key public.
      expectRejects(() => f.asPoster().call('postBounty', rand32(), freshCoin(REWARD), { x: 0n, y: 1n }, f.target, soon, TITLE, DETAILS, nowSec()), 'Invalid public key');
      // A point that is not on the curve can't be used at all.
      expectRejects(() => f.asPoster().call('postBounty', rand32(), freshCoin(REWARD), { x: 1n, y: 2n }, f.target, soon, TITLE, DETAILS, nowSec()));
      expect(f.sim.ledger().bounties.size()).toEqual(0n);
    });
  });

  describe('submit', () => {
    it('pays the solver, stores the answer encrypted to the poster, and closes the bounty', () => {
      const f = setup();
      const { id } = f.post();
      f.asSolver().call('submit', id, freshCoin(STAKE));
      const l = f.sim.ledger();

      expect(l.bounties.lookup(id).status).toEqual(Status.SOLVED);
      expect(l.escrows.member(id)).toBe(false);
      // One payout coin: the reward plus the solver's own coin back, to the solver.
      expect(f.paid(SOLVER_PK, REWARD + STAKE)).toHaveLength(1);

      const d: Delivery = l.deliveries.lookup(id);
      expect(d.c).not.toEqual(f.answer);
      expect(pureCircuits.decrypt(d, f.posterKey, id)).toEqual(f.answer);
      expect(pureCircuits.decrypt(d, f.posterKey + 1n, id)).not.toEqual(f.answer);
    });

    it('pays a solver who brings a zero-value coin (spike Q12)', () => {
      const f = setup();
      const { id } = f.post();
      f.asSolver().call('submit', id, freshCoin(0n));
      expect(f.sim.ledger().bounties.lookup(id).status).toEqual(Status.SOLVED);
      // The payout is the reward alone: the solver's coin added nothing.
      expect(f.paid(SOLVER_PK, REWARD)).toHaveLength(1);
    });

    it('uses a fresh key exchange every time', () => {
      const a = setup();
      const { id: id1 } = a.post();
      a.asSolver().call('submit', id1, freshCoin(STAKE));
      const { id: id2 } = a.post();
      a.asSolver().call('submit', id2, freshCoin(STAKE));
      const d1 = a.sim.ledger().deliveries.lookup(id1);
      const d2 = a.sim.ledger().deliveries.lookup(id2);
      expect(d1.ephemeralPk.x).not.toEqual(d2.ephemeralPk.x);
      expect(d1.c).not.toEqual(d2.c);
    });

    it('rejects a wrong answer, an unknown bounty, the wrong token and a closed bounty', () => {
      const f = setup();
      const { id } = f.post();
      const wrong = [...f.answer];
      wrong[0] += 1n;
      expectRejects(() => f.asSolver(wrong).call('submit', id, freshCoin(STAKE)), 'Wrong answer');
      expectRejects(() => f.asSolver().call('submit', rand32(), freshCoin(STAKE)), 'No such bounty');
      expectRejects(() => f.asSolver().call('submit', id, freshCoin(STAKE, otherColor)), 'Wrong token');
      // A rejected call changes nothing.
      expect(f.sim.ledger().bounties.lookup(id).status).toEqual(Status.OPEN);
      expect(f.sim.ledger().deliveries.member(id)).toBe(false);

      f.asSolver().call('submit', id, freshCoin(STAKE));
      expectRejects(() => f.asSolver(f.answer, OTHER_PK, rand32()).call('submit', id, freshCoin(STAKE)), 'Bounty is closed');
    });

    it('rejects a submission after the deadline', async () => {
      const f = setup();
      const { id } = f.post(nowSec() + 2n);
      await sleep(3000);
      expectRejects(() => f.asSolver().call('submit', id, freshCoin(STAKE)), 'Deadline has passed');
    });
  });

  describe('refund', () => {
    it('returns the reward to the poster after the deadline', async () => {
      const f = setup();
      const { id } = f.post(nowSec() + 2n);
      expectRejects(() => f.asPoster().call('refund', id), 'Deadline has not passed');
      await sleep(3000);
      expectRejects(() => f.asSolver().call('refund', id), 'Only the poster can refund');

      f.asPoster().call('refund', id);
      const l = f.sim.ledger();
      expect(l.bounties.lookup(id).status).toEqual(Status.REFUNDED);
      expect(l.escrows.member(id)).toBe(false);
      expect(l.listings.lookup(id).title).toEqual(TITLE);
      expect(f.paid(POSTER_PK, REWARD)).toHaveLength(1);
      expectRejects(() => f.asPoster().call('refund', id), 'Bounty is closed');
    });

    it('cannot refund a solved bounty', async () => {
      const f = setup();
      const { id } = f.post(nowSec() + 2n);
      f.asSolver().call('submit', id, freshCoin(STAKE));
      await sleep(3000);
      expectRejects(() => f.asPoster().call('refund', id), 'Bounty is closed');
    });
  });

  describe('privacy', () => {
    it('keeps secrets, the answer and the solver coin out of public state', () => {
      const f = setup();
      const { id } = f.post();
      const stake = freshCoin(STAKE);
      f.asSolver().call('submit', id, stake);
      const secrets: Record<string, Uint8Array> = {
        posterSk: f.posterSk,
        solverSk: f.solverSk,
        posterKey: fieldBytes(f.posterKey),
        stakeNonce: stake.nonce,
      };
      f.answer.forEach((m, i) => (secrets[`answer[${i}]`] = fieldBytes(m)));
      assertNotInPublicState(f.sim.ledger(), secrets);
    });
  });

  describe('off-chain helpers', () => {
    it('checkAnswer matches the in-circuit checker', () => {
      const f: Fixture = setup();
      expect(pureCircuits.checkAnswer(f.answer, f.target)).toBe(true);
      expect(pureCircuits.checkAnswer([1n, 2n, 3n, 4n], f.target)).toBe(false);
    });
  });
});
