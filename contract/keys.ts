// The poster's encryption keys. Each bounty gets its own key, derived from one
// 32-byte seed, so bounties can't be linked through their public key and one
// backup of the seed still decrypts every delivery.

import { JUBJUB_ORDER } from './signing.js';

const encoder = new TextEncoder();

/**
 * The poster's secret encryption scalar for bounty `id` on contract
 * `contractAddress`: SHA-512(seed, "pb:enc", address, id), reduced into
 * [1, JUBJUB_ORDER). Its public key is the template's posterPublicKey (or
 * publicKey) of this scalar.
 */
export async function posterKeyFor(seed: Uint8Array, contractAddress: string, id: Uint8Array): Promise<bigint> {
  if (seed.length !== 32) throw new Error('The poster seed must be 32 bytes');
  const parts = [seed, encoder.encode('pb:enc'), encoder.encode(contractAddress), id];
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
