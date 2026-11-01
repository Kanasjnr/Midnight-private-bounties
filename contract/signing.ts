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

const bytes32 = (x: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
};

/**
 * A hedged nonce in [1, JUBJUB_ORDER): SHA-512 over the signing key, the record
 * and 64 fresh random bytes, reduced, so the bias is about 2^-260.
 *
 * Schnorr nonces must be uniform. Drawing them from a smaller range (as the
 * first version did, with 248 bits) leaks a few bits per signature, and enough
 * signatures then reveal the signing key. Hashing in the key and the record as
 * well keeps the nonce safe if the random source is weak or repeats (second
 * audit, S3).
 */
export async function hedgedNonce(sk: bigint, record: bigint[]): Promise<bigint> {
  const parts = [new TextEncoder().encode('pb:schnorr-nonce'), bytes32(sk), ...record.map(bytes32),
    globalThis.crypto.getRandomValues(new Uint8Array(64))];
  const input = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    input.set(p, offset);
    offset += p.length;
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-512', input));
  const x = digest.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  return (x % (JUBJUB_ORDER - 1n)) + 1n;
}

/** Signs a four-field record with issuer secret `sk`. */
export async function signRecord(sk: bigint, record: bigint[]): Promise<SchnorrSignature> {
  if (record.length !== 4) throw new Error('A record is four field elements');
  sk = reduce(sk);
  const pk = ecMulGenerator(sk);
  const k = await hedgedNonce(sk, record);
  const R = ecMulGenerator(k);
  const c = pureCircuits.recordChallenge(R.x, R.y, pk.x, pk.y, record) % TWO_248;
  return { announcement: R, response: reduce(k + c * sk) };
}
