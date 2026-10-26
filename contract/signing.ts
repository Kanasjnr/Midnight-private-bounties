// Off-chain Schnorr signing on Jubjub, for issuers of signed records. The
// challenge comes from the contract's own recordChallenge pure circuit, so a
// signature made here is exactly what bounty_signed_record verifies.
// Ported from midnight-examples' zk-loan (attestation-api/signing.ts).

import { ecMulGenerator } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { pureCircuits } from './managed/bounty_signed_record/contract/index.js';
import { type SchnorrSignature } from './witnesses.js';

/** The order of Jubjub's prime-order subgroup. Scalars live below it. */
export const JUBJUB_ORDER = 6554484396890773809930967563523245729705921265872317281365359162392183254199n;
const TWO_248 = 1n << 248n;

const reduce = (x: bigint): bigint => ((x % JUBJUB_ORDER) + JUBJUB_ORDER) % JUBJUB_ORDER;

/**
 * A nonce drawn uniformly from [1, JUBJUB_ORDER): 512 random bits reduced, so
 * the bias is about 2^-260. Schnorr nonces must be uniform. Drawing them from a
 * smaller range (as an earlier version did, with 248 bits) leaks a few bits per
 * signature, and enough signatures then reveal the signing key.
 */
export const uniformNonce = (): bigint => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(64));
  const x = bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  return (x % (JUBJUB_ORDER - 1n)) + 1n;
};

/** Signs a four-field record with issuer secret `sk`. */
export function signRecord(sk: bigint, record: bigint[]): SchnorrSignature {
  sk = reduce(sk);
  const pk = ecMulGenerator(sk);
  const k = uniformNonce();
  const R = ecMulGenerator(k);
  const c = pureCircuits.recordChallenge(R.x, R.y, pk.x, pk.y, record) % TWO_248;
  return { announcement: R, response: reduce(k + c * sk) };
}
