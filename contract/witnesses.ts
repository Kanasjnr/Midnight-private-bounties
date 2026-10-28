// Witnesses for the bounty contracts: the private inputs each circuit reads
// from the caller's device. Each returns [nextPrivateState, value].
//
// One set serves every template. The functions are generic over the ledger
// and private state, and a template simply never calls the witnesses it
// doesn't declare (only bounty_signed_record reads `signature` and
// `getSchnorrReduction`).

import { type JubjubPoint, type WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

/** A Schnorr signature on Jubjub, as zk-loan's schnorr module expects it. */
export type SchnorrSignature = { announcement: JubjubPoint; response: bigint };

export type BountyPrivateState = {
  // Identity secret. The poster's pseudonym is derived from it in-circuit.
  // Separate from the poster's encryption key, which never enters a circuit.
  sk: Uint8Array;
  // The answer (or record) a solver is about to submit: four field elements.
  answer: bigint[];
  // For bounty_signed_record: the issuer's signature over `answer`.
  signature: SchnorrSignature;
  // Optional: the poster's key seed (see keys.ts). Never read by a circuit;
  // kept here so a backup of the private state also backs up the poster's
  // ability to decrypt deliveries.
  posterSeed?: Uint8Array;
};

export const NO_ANSWER: bigint[] = [0n, 0n, 0n, 0n];
export const NO_SIGNATURE: SchnorrSignature = { announcement: { x: 0n, y: 0n }, response: 0n };

export const createBountyPrivateState = (
  sk: Uint8Array,
  answer: bigint[] = NO_ANSWER,
  signature: SchnorrSignature = NO_SIGNATURE,
): BountyPrivateState => ({ sk, answer, signature });

/** A uniform random value below 2^248: a valid field element and Jubjub scalar. */
export const randomScalar = (): bigint => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(31));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
};

// 2^248: the schnorr module truncates its challenge hash to 248 bits so the
// challenge is a valid Jubjub scalar.
const TWO_248 = 1n << 248n;

type Ctx<PS> = WitnessContext<unknown, PS>;

export const bountyWitnesses = {
  localSecretKey: <PS extends BountyPrivateState>({ privateState }: Ctx<PS>): [PS, Uint8Array] => {
    if (privateState.sk.length !== 32) throw new Error('The secret key must be 32 bytes');
    return [privateState, privateState.sk];
  },

  answer: <PS extends BountyPrivateState>({ privateState }: Ctx<PS>): [PS, bigint[]] => [
    privateState,
    privateState.answer,
  ],

  // Fresh for every submission and never stored: the poster recovers the
  // shared key from e·G, and the solver has no further use for e.
  ephemeralScalar: <PS extends BountyPrivateState>({ privateState }: Ctx<PS>): [PS, bigint] => [
    privateState,
    randomScalar(),
  ],

  signature: <PS extends BountyPrivateState>({ privateState }: Ctx<PS>): [PS, SchnorrSignature] => [
    privateState,
    privateState.signature,
  ],

  // Division is cheap here and expensive in-circuit; the circuit only checks
  // that challengeHash == q * 2^248 + r with q bounded (see schnorr.compact).
  getSchnorrReduction: <PS extends BountyPrivateState>(
    { privateState }: Ctx<PS>,
    challengeHash: bigint,
  ): [PS, [bigint, bigint]] => [privateState, [challengeHash / TWO_248, challengeHash % TWO_248]],
};

// The name midnight-examples' UI generator (`yarn new:ui`) imports.
export const witnesses = bountyWitnesses;
