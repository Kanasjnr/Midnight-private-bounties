// Off-chain Schnorr signing on Jubjub, for issuers of signed records. The
// challenge comes from the contract's own recordChallenge pure circuit, so a
// signature made here is exactly what bounty_signed_record verifies.
// Ported from midnight-examples' zk-loan (attestation-api/signing.ts).

import { ecMulGenerator } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { pureCircuits } from './managed/bounty_signed_record/contract/index.js';
import { randomScalar, type SchnorrSignature } from './witnesses.js';

/** The order of Jubjub's prime-order subgroup. Scalars live below it. */
export const JUBJUB_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;
const TWO_248 = 1n << 248n;

const reduce = (x: bigint): bigint => ((x % JUBJUB_ORDER) + JUBJUB_ORDER) % JUBJUB_ORDER;

/** Signs a four-field record with issuer secret `sk`. */
export function signRecord(sk: bigint, record: bigint[]): SchnorrSignature {
  sk = reduce(sk);
  const pk = ecMulGenerator(sk);
  const k = reduce(randomScalar());
  const R = ecMulGenerator(k);
  const c = pureCircuits.recordChallenge(R.x, R.y, pk.x, pk.y, record) % TWO_248;
  return { announcement: R, response: reduce(k + c * sk) };
}
