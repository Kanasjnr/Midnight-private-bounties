// Spike Q2 witnesses for bounty_escrow.compact.
//
// Runs inside a midnight-examples checkout (examples/bounty-escrow-spike), using
// its workspace packages. Pattern follows examples/shielded-chips.

import type { WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { Ledger } from './managed/bounty_escrow/contract/index.js';

/** A coin the contract holds, as the ledger needs it in order to spend it. */
export type QualifiedCoin = {
  nonce: Uint8Array;
  color: Uint8Array;
  value: bigint;
  mt_index: bigint;
};

// The private state holds one stake at a time: the test sets the salt before
// `stake` and records the coin (with its mt_index) right after.
export type BountyPrivateState = {
  sk: Uint8Array;
  stakeSalt: Uint8Array;
  stakeCoin: QualifiedCoin;
};

const ZERO_32 = new Uint8Array(32);

/** A coin shaped placeholder, used before a stake has been made. */
export const NO_COIN: QualifiedCoin = {
  nonce: ZERO_32,
  color: ZERO_32,
  value: 0n,
  mt_index: 0n,
};

export const createBountyPrivateState = (
  sk: Uint8Array,
  stakeSalt: Uint8Array = ZERO_32,
): BountyPrivateState => ({ sk, stakeSalt, stakeCoin: NO_COIN });

/**
 * Record the coin a solver just staked, so `submit`/`withdrawStake` can reopen
 * the on-chain commitment. `mt_index` is only known once the stake transaction
 * lands, so it is read back off the chain and supplied here.
 */
export const rememberStake = (
  state: BountyPrivateState,
  coin: QualifiedCoin,
): BountyPrivateState => ({ ...state, stakeCoin: coin });

export const bountyWitnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, BountyPrivateState>): [BountyPrivateState, Uint8Array] => [
    privateState,
    privateState.sk,
  ],

  stakeSalt: ({
    privateState,
  }: WitnessContext<Ledger, BountyPrivateState>): [BountyPrivateState, Uint8Array] => [
    privateState,
    privateState.stakeSalt,
  ],

  stakeCoin: ({
    privateState,
  }: WitnessContext<Ledger, BountyPrivateState>): [BountyPrivateState, QualifiedCoin] => [
    privateState,
    privateState.stakeCoin,
  ],
};
