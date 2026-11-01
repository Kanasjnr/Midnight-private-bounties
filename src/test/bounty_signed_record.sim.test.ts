// In-memory tests for the signed-record bounty. The escrow, deadline and
// refund circuits are the same as bounty_preimage's (see its tests); these
// cover what this template adds: an in-circuit Schnorr signature check, a
// schema tag, and a threshold on one field of the record.

import { describe, expect, it } from 'vitest';
import { Sim, assertNotInPublicState, expectRejects } from '@midnight-ntwrk/example-sim';
import { Contract, ledger, pureCircuits, Status } from '../../contract/managed/bounty_signed_record/contract/index.js';
import {
  bountyWitnesses,
  createBountyPrivateState,
  randomScalar,
  type SchnorrSignature,
} from '../../contract/witnesses.js';
import { JUBJUB_ORDER, signRecord } from '../../contract/signing.js';

const REWARD = 100n;
const STAKE = 10n;
const TITLE = 'Income of at least 3,000';
const DETAILS = 'A bank statement record signed by the test issuer, with an amount of at least 3,000.';
const POSTER_PK = 'b0'.repeat(32);
const SOLVER_PK = 'a0'.repeat(32);
const SCHEMA = BigInt('0x' + Buffer.from('pb:bank-statement:v1').toString('hex'));
const FIELD = 1n; // record[1] holds the amount
const THRESHOLD = 3000n;
const TWO_248 = 1n << 248n;
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

const color = rand32();
const freshCoin = (value: bigint) => ({ nonce: rand32(), color, value });
// [schema tag, amount, issued at, subject]
const recordWithAmount = (amount: bigint, schema: bigint = SCHEMA): bigint[] => [schema, amount, nowSec(), randomScalar()];

function setup(witnesses = bountyWitnesses) {
  const posterSk = rand32();
  const solverSk = rand32();
  const posterKey = randomScalar();
  const issuerSk = randomScalar();
  const issuerPk = pureCircuits.publicKey(issuerSk);
  const sim = Sim.deploy({
    contract: new Contract(witnesses),
    ledger,
    privateState: createBountyPrivateState(posterSk),
    args: [color],
    coinPublicKey: POSTER_PK,
  });
  const id = rand32();
  const post = (bountyId: Uint8Array, issuer = issuerPk, field = FIELD) =>
    sim
      .as(POSTER_PK)
      .call('postBounty', bountyId, freshCoin(REWARD), pureCircuits.publicKey(posterKey), issuer, SCHEMA, field, THRESHOLD, nowSec() + 3600n, TITLE, DETAILS);
  post(id);
  const submitAs = (record: bigint[], signature: SchnorrSignature) => {
    sim.as(SOLVER_PK).privateState = createBountyPrivateState(solverSk, record, signature);
    return sim.call('submit', id, freshCoin(STAKE));
  };
  return { sim, id, posterSk, solverSk, posterKey, issuerSk, issuerPk, post, submitAs };
}

describe('bounty_signed_record (in memory)', () => {
  it('pays for an issuer-signed record of the right type that meets the threshold', () => {
    const f = setup();
    const record = recordWithAmount(5000n);
    const signature = signRecord(f.issuerSk, record);
    f.submitAs(record, signature);
    const l = f.sim.ledger();
    expect(l.bounties.lookup(f.id).status).toEqual(Status.SOLVED);
    expect(l.bounties.lookup(f.id).schema).toEqual(SCHEMA);
    expect(l.listings.lookup(f.id)).toEqual({ title: TITLE, details: DETAILS });
    const paid = (f.sim.lastContext?.currentZswapLocalState.outputs ?? []).filter(
      (o) => o.recipient.is_left && hex(o.recipient.left.bytes) === SOLVER_PK && o.coinInfo.value === REWARD + STAKE,
    );
    expect(paid).toHaveLength(1);
    expect(pureCircuits.decrypt(l.deliveries.lookup(f.id), f.posterKey, f.id)).toEqual(record);

    const secrets: Record<string, Uint8Array> = {
      posterSk: f.posterSk,
      solverSk: f.solverSk,
      posterKey: fieldBytes(f.posterKey),
      issuerSk: fieldBytes(f.issuerSk),
      signatureResponse: fieldBytes(signature.response),
    };
    record.slice(1).forEach((v, i) => (secrets[`record[${i + 1}]`] = fieldBytes(v)));
    assertNotInPublicState(l, secrets);
  });

  it('accepts a record exactly at the threshold', () => {
    const f = setup();
    const record = recordWithAmount(THRESHOLD);
    f.submitAs(record, signRecord(f.issuerSk, record));
    expect(f.sim.ledger().bounties.lookup(f.id).status).toEqual(Status.SOLVED);
  });

  it('rejects a properly signed record below the threshold', () => {
    const f = setup();
    const record = recordWithAmount(THRESHOLD - 1n);
    expectRejects(() => f.submitAs(record, signRecord(f.issuerSk, record)), 'Wrong answer');
    expect(f.sim.ledger().bounties.lookup(f.id).status).toEqual(Status.OPEN);
  });

  it('rejects a record signed by a different issuer', () => {
    const f = setup();
    const record = recordWithAmount(5000n);
    expectRejects(() => f.submitAs(record, signRecord(randomScalar(), record)), 'Invalid attestation signature');
  });

  it('rejects a record changed after signing', () => {
    const f = setup();
    const record = recordWithAmount(1000n);
    const signature = signRecord(f.issuerSk, record);
    const inflated = [...record];
    inflated[1] = 5000n;
    expectRejects(() => f.submitAs(inflated, signature), 'Invalid attestation signature');
    expect(f.sim.ledger().deliveries.member(f.id)).toBe(false);
  });

  it("rejects the issuer's signature on another kind of record (audit L4)", () => {
    const f = setup();
    // Same issuer, valid signature, but signed for something else: a zk-loan
    // style attestation [score, income, months, user] or another record type.
    const attestation = [720n, 5000n, 36n, randomScalar()];
    expectRejects(() => f.submitAs(attestation, signRecord(f.issuerSk, attestation)), 'Wrong record type');
    const other = recordWithAmount(5000n, SCHEMA + 1n);
    expectRejects(() => f.submitAs(other, signRecord(f.issuerSk, other)), 'Wrong record type');
  });

  it('rejects bounties that check the schema tag or a field outside the record', () => {
    const f = setup();
    expectRejects(() => f.post(rand32(), f.issuerPk, 0n), 'Field must be 1 to 3');
    expectRejects(() => f.post(rand32(), f.issuerPk, 4n), 'Field must be 1 to 3');
  });

  it('rejects an issuer key nobody should trust (audit L1)', () => {
    const f = setup();
    expectRejects(() => f.post(rand32(), { x: 0n, y: 1n }), 'Invalid public key');
  });

  it('rejects a non-canonical challenge reduction', () => {
    // A prover who supplies the second of two valid (q, r) representations of
    // the challenge hash is stopped. The reduction is checked before the
    // signature, so the announcement needn't belong to a valid signature.
    const cheat = setup({
      ...bountyWitnesses,
      getSchnorrReduction: ({ privateState }, h: bigint) => [privateState, [(h + R) / TWO_248, (h + R) % TWO_248]],
    });
    const announcement = pureCircuits.publicKey(randomScalar());
    // Find a record whose hash h has a second representation h + p below
    // 116 * 2^248. About 1 hash in 1,700 does.
    let record: bigint[] = [];
    for (let i = 0; i < 100_000 && record.length === 0; i++) {
      const candidate = recordWithAmount(5000n);
      const h = pureCircuits.recordChallenge(announcement.x, announcement.y, cheat.issuerPk.x, cheat.issuerPk.y, candidate);
      if (h + R < 116n * TWO_248) record = candidate;
    }
    expect(record).toHaveLength(4);
    expectRejects(() => cheat.submitAs(record, { announcement, response: 1n }), 'Non-canonical challenge reduction');
  });

  it('meetsThreshold matches the in-circuit threshold check', () => {
    expect(pureCircuits.meetsThreshold(recordWithAmount(5000n), FIELD, THRESHOLD)).toBe(true);
    expect(pureCircuits.meetsThreshold(recordWithAmount(2999n), FIELD, THRESHOLD)).toBe(false);
  });
});

describe('issuer signing (audit H1)', () => {
  it('draws Schnorr nonces uniformly, not from a 248-bit range', () => {
    const sk = randomScalar();
    const pk = pureCircuits.publicKey(sk);
    let above = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const rec = recordWithAmount(BigInt(i));
      const { announcement, response } = signRecord(sk, rec);
      const c = pureCircuits.recordChallenge(announcement.x, announcement.y, pk.x, pk.y, rec) % TWO_248;
      const k = (((response - c * sk) % JUBJUB_ORDER) + JUBJUB_ORDER) % JUBJUB_ORDER;
      if (k >= TWO_248) above++;
    }
    // A uniform nonce is at least 2^248 about 93% of the time; the old 248-bit
    // nonce never was.
    expect(above / n).toBeGreaterThan(0.85);
  });
});
