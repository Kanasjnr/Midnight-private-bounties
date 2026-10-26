// Witnesses for the bounty contracts: the private inputs each circuit reads
// from the caller's device. Each returns [nextPrivateState, value].

import { type Ledger } from './managed/bounty_preimage/contract/index.js';
import { type WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

export type BountyPrivateState = {
  // Identity secret. The poster's pseudonym is derived from it in-circuit.
  // Separate from the poster's encryption key, which never enters a circuit.
  sk: Uint8Array;
  // The answer a solver is about to submit: four field elements.
  answer: bigint[];
};

export const NO_ANSWER: bigint[] = [0n, 0n, 0n, 0n];

export const createBountyPrivateState = (sk: Uint8Array, answer: bigint[] = NO_ANSWER): BountyPrivateState => ({
  sk,
  answer,
});

/** A uniform random value below 2^248: a valid field element and Jubjub scalar. */
export const randomScalar = (): bigint => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(31));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
};

type Ctx = WitnessContext<Ledger, BountyPrivateState>;

export const bountyWitnesses = {
  localSecretKey: ({ privateState }: Ctx): [BountyPrivateState, Uint8Array] => [privateState, privateState.sk],

  answer: ({ privateState }: Ctx): [BountyPrivateState, bigint[]] => [privateState, privateState.answer],

  // Fresh for every submission and never stored: the poster recovers the
  // shared key from e·G, and the solver has no further use for e.
  ephemeralScalar: ({ privateState }: Ctx): [BountyPrivateState, bigint] => [privateState, randomScalar()],
};
