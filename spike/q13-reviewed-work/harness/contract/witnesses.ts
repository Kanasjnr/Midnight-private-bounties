// Witnesses for the reviewed-work spike: the same three the bounty templates
// declare (see contract/witnesses.ts at the repo root), so the real app can
// share one set.

import { type WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

export type WorkPrivateState = {
  // Identity secret: the poster's, contributor's or arbiter's id comes from it.
  sk: Uint8Array;
  // The submission a contributor is about to send: four field elements.
  answer: bigint[];
};

export const NO_ANSWER: bigint[] = [0n, 0n, 0n, 0n];

export const createWorkPrivateState = (sk: Uint8Array, answer: bigint[] = NO_ANSWER): WorkPrivateState => ({
  sk,
  answer,
});

/** A uniform random value below 2^248: a valid field element and Jubjub scalar. */
export const randomScalar = (): bigint => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(31));
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
};

type Ctx<PS> = WitnessContext<unknown, PS>;

export const workWitnesses = {
  localSecretKey: <PS extends WorkPrivateState>({ privateState }: Ctx<PS>): [PS, Uint8Array] => {
    if (privateState.sk.length !== 32) throw new Error('The secret key must be 32 bytes');
    return [privateState, privateState.sk];
  },
  answer: <PS extends WorkPrivateState>({ privateState }: Ctx<PS>): [PS, bigint[]] => [
    privateState,
    privateState.answer,
  ],
  ephemeralScalar: <PS extends WorkPrivateState>({ privateState }: Ctx<PS>): [PS, bigint] => [
    privateState,
    randomScalar(),
  ],
};
