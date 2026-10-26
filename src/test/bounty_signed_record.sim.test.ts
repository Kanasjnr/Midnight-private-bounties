// In-memory tests for the signed-record bounty. The escrow, deadline and
// refund circuits are the same as bounty_preimage's (see its tests); these
// cover what this template adds: an in-circuit Schnorr signature check and a
// threshold on one field of the record.

import { describe, expect, it } from 'vitest';
import { Sim, assertNotInPublicState, expectRejects } from '@midnight-ntwrk/example-sim';
import { Contract, ledger, pureCircuits, Status } from '../../contract/managed/bounty_signed_record/contract/index.js';
import {
  bountyWitnesses,
  createBountyPrivateState,
  randomScalar,
  type SchnorrSignature,
} from '../../contract/witnesses.js';
import { signRecord } from '../../contract/signing.js';

const REWARD = 100n;
const STAKE = 10n;
const POSTER_PK = 'b0'.repeat(32);
const SOLVER_PK = 'a0'.repeat(32);
const FIELD = 1n; // the record's second field holds the amount
const THRESHOLD = 3000n;

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
// [subject, amount, issued at, nonce]
const recordWithAmount = (amount: bigint): bigint[] => [randomScalar(), amount, nowSec(), randomScalar()];

function setup() {
  const posterSk = rand32();
  const solverSk = rand32();
  const posterKey = randomScalar();
  const issuerSk = randomScalar();
  const issuerPk = pureCircuits.publicKey(issuerSk);
  const sim = Sim.deploy({
    contract: new Contract(bountyWitnesses),
    ledger,
    privateState: createBountyPrivateState(posterSk),
    args: [color],
    coinPublicKey: POSTER_PK,
  });
  const id = rand32();
  sim.call('postBounty', id, freshCoin(REWARD), pureCircuits.publicKey(posterKey), issuerPk, FIELD, THRESHOLD, nowSec() + 3600n);
  const submitAs = (record: bigint[], signature: SchnorrSignature) => {
    sim.as(SOLVER_PK).privateState = createBountyPrivateState(solverSk, record, signature);
    return sim.call('submit', id, freshCoin(STAKE));
  };
  return { sim, id, posterSk, solverSk, posterKey, issuerSk, issuerPk, submitAs };
}

describe('bounty_signed_record (in memory)', () => {
  it('pays for an issuer-signed record that meets the threshold', () => {
    const f = setup();
    const record = recordWithAmount(5000n);
    const signature = signRecord(f.issuerSk, record);
    f.submitAs(record, signature);
    const l = f.sim.ledger();
    expect(l.bounties.lookup(f.id).status).toEqual(Status.SOLVED);
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
    record.forEach((v, i) => (secrets[`record[${i}]`] = fieldBytes(v)));
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

  it("rejects a record signed by a different issuer", () => {
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

  it('rejects a bounty that checks a field outside the record', () => {
    const f = setup();
    expectRejects(
      () => f.sim.as(POSTER_PK).call('postBounty', rand32(), freshCoin(REWARD), f.issuerPk, f.issuerPk, 4n, THRESHOLD, nowSec() + 3600n),
      'Field must be 0 to 3',
    );
  });

  it('meetsThreshold matches the in-circuit threshold check', () => {
    expect(pureCircuits.meetsThreshold(recordWithAmount(5000n), FIELD, THRESHOLD)).toBe(true);
    expect(pureCircuits.meetsThreshold(recordWithAmount(2999n), FIELD, THRESHOLD)).toBe(false);
  });
});
