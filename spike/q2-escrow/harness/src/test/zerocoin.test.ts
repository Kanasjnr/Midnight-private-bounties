// Spike Q12: can a solver who holds none of the reward token submit with a
// zero-value coin? Runs inside a midnight-examples checkout
// (examples/bounty-escrow-spike).
//
//   Z1  A fresh deployment mints a fresh test token, so Bob holds none of it.
//       Alice posts a bounty; Bob calls submitOneTx with a zero-value coin.
//       The coin's only job is its secret nonce, which makes the payout
//       unlinkable, so a value of zero would do if zswap and the wallet accept
//       it. The test records what happens either way. On success it checks the
//       payout and runs the Q2 leak checks; on failure, that nothing changed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { type ContractAddress, encodeCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  encryptionKeys,
  freshCoin,
  mintNonce,
  recipientOf,
  shieldedBalance,
  shieldedCoins,
  tokenColor,
  waitForShieldedBalance,
  type TokenColor,
} from '@midnight-ntwrk/example-coins';
import { resolveWallet } from '@midnight-ntwrk/example-fast-sync';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';
import { WebSocket } from 'ws';

import { getConfig } from '../config.js';
import { MidnightWalletProvider, syncWallet } from '../wallet.js';
import { buildProviders, type BountyProviders } from '../providers.js';
import {
  CompiledBountyContract,
  bountyLedger,
  Status,
  bountyZkConfigPath,
  type BountyLedger,
} from '../../contract/index.js';
import { createBountyPrivateState } from '../../contract/witnesses.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });
const config = getConfig();
const LONG = 45 * 60_000;
const REWARD = 100n;

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const nowSec = (): number => Math.floor(Date.now() / 1000);
const newId = (): Uint8Array => new Uint8Array(randomBytes(32));
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const timings: { step: string; seconds: number }[] = [];

function errText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | cause: ').replace(/\s+/g, ' ').slice(0, 1500);
}

type Party = {
  name: string;
  wallet: MidnightWalletProvider;
  prov: BountyProviders;
  psId: string;
  sk: Uint8Array;
};

describe(`Spike Q12: zero-value solver coin (${config.networkId})`, () => {
  let alice: Party; // poster
  let bob: Party; // solver, holding none of the reward token
  let address: ContractAddress;
  let color: TokenColor;
  const Z1 = newId();

  async function query(): Promise<BountyLedger> {
    const s = await alice.prov.publicDataProvider.queryContractState(address);
    expect(s).not.toBeNull();
    return bountyLedger(s!.data);
  }

  async function balance(p: Party): Promise<bigint> {
    await syncWallet(logger, p.wallet.wallet, 600_000);
    return shieldedBalance(p.wallet, color);
  }

  async function call(p: Party, label: string, circuitId: string, args: unknown[]) {
    const t0 = Date.now();
    await p.prov.privateStateProvider.set(p.psId, createBountyPrivateState(p.sk));
    const tx = await (submitCallTx as any)(p.prov, {
      compiledContract: CompiledBountyContract,
      contractAddress: address,
      privateStateId: p.psId,
      circuitId,
      args,
    });
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    timings.push({ step: label, seconds });
    logger.info(`${label}: ok in ${seconds}s (tx ${tx.public.txId.slice(0, 16)}…)`);
    return tx;
  }

  beforeAll(async () => {
    setNetworkId(config.networkId);
    const env: EnvironmentConfiguration = {
      walletNetworkId: config.networkId,
      networkId: config.networkId,
      indexer: config.indexer,
      indexerWS: config.indexerWS,
      node: config.node,
      nodeWS: config.nodeWS,
      faucet: config.faucet,
      proofServer: config.proofServer,
    };
    const make = async (role: 'ALICE' | 'BOB', name: string): Promise<Party> => {
      const setup = resolveWallet(config.networkId === 'undeployed' ? 'local' : config.networkId, role);
      const wallet = await MidnightWalletProvider.build(logger, env, setup.secret, { fastSync: setup.fastSync });
      await wallet.start();
      await syncWallet(logger, wallet.wallet, 600_000);
      const prov = buildProviders(wallet, bountyZkConfigPath, config, `zero-${name}`);
      return { name, wallet, prov, psId: `Zero${name}`, sk: new Uint8Array(randomBytes(32)) };
    };
    alice = await make('ALICE', 'alice');
    bob = await make('BOB', 'bob');

    const deployed = await (deployContract as any)(alice.prov, {
      compiledContract: CompiledBountyContract,
      privateStateId: alice.psId,
      initialPrivateState: createBountyPrivateState(alice.sk),
    });
    address = deployed.deployTxData.public.contractAddress;
    color = tokenColor('bounty:test-token', address);
    for (const p of [alice, bob]) p.prov.privateStateProvider.setContractAddress(address);

    // Only Alice gets the new token.
    await alice.prov.privateStateProvider.set(alice.psId, createBountyPrivateState(alice.sk));
    await (submitCallTx as any)(alice.prov, {
      compiledContract: CompiledBountyContract,
      contractAddress: address,
      privateStateId: alice.psId,
      circuitId: 'mintTestTokens',
      args: [REWARD, mintNonce(), recipientOf(alice.wallet)],
      additionalCoinEncPublicKeyMappings: encryptionKeys(alice.wallet, bob.wallet),
    });
    await waitForShieldedBalance(alice.wallet, color, REWARD, { logger });
  }, LONG);

  afterAll(async () => {
    results['finishedAt'] = new Date().toISOString();
    results['timings'] = timings;
    writeFileSync('zerocoin-results.json', json(results));
    for (const p of [alice, bob]) if (p) await p.wallet.stop().catch(() => undefined);
  });

  it('Z1 (Q12): a solver holding none of the token submits with a zero-value coin', async () => {
    await call(alice, 'Z1 postBounty', 'postBounty', [Z1, freshCoin(color, REWARD), BigInt(nowSec() + 3600)]);
    const reward = (await query()).escrows.lookup(Z1);
    const bobBefore = await balance(bob);
    const zero = freshCoin(color, 0n);
    const r: Record<string, unknown> = { bobTokenBalanceBefore: bobBefore };
    results['z1'] = r;
    expect(bobBefore).toEqual(0n);

    try {
      await call(bob, 'Z1 submitOneTx (bob, zero-value coin)', 'submitOneTx', [Z1, 12n, zero]);
      r['outcome'] = 'succeeded';
    } catch (e) {
      r['outcome'] = 'failed';
      r['error'] = errText(e);
    }

    const l = await query();
    r['status'] = Status[l.bounties.lookup(Z1).status];
    if (r['outcome'] === 'succeeded') {
      const bobAfter = await waitForShieldedBalance(bob.wallet, color, REWARD, { logger });
      const payout = (await shieldedCoins(bob.wallet, color)).find((c) => c.value === REWARD);
      const pool: { label: string; bytes: Uint8Array }[] = [];
      for (const [k, b] of l.bounties) pool.push({ label: 'bounties.key', bytes: k }, { label: 'bounties.poster', bytes: b.poster });
      for (const [k, c] of l.escrows) pool.push({ label: 'escrows.key', bytes: k }, { label: 'escrows.nonce', bytes: c.nonce });
      for (const [k] of l.deliveries) pool.push({ label: 'deliveries.key', bytes: k });
      const leak = (t: Uint8Array) => pool.find((x) => hex(x.bytes) === hex(t))?.label ?? null;
      Object.assign(r, {
        bobTokenBalanceAfter: bobAfter,
        payoutCoinFound: Boolean(payout),
        zeroCoinNonceLeak: leak(zero.nonce),
        payoutNonceLeak: payout ? leak(payout.nonce) : 'payout coin not found',
        payoutNonceEqualsEscrowNonce: payout ? hex(payout.nonce) === hex(reward.nonce) : null,
        solverCoinPkLeak: leak(encodeCoinPublicKey(bob.wallet.getCoinPublicKey())),
      });
      expect(bobAfter).toEqual(REWARD);
      expect(r['payoutNonceLeak']).toBeNull();
      expect(r['payoutNonceEqualsEscrowNonce']).toBe(false);
    } else {
      // A failed submit must leave the bounty untouched.
      r['escrowStillPresent'] = l.escrows.member(Z1);
      r['bobTokenBalanceAfter'] = await balance(bob);
      expect(l.bounties.lookup(Z1).status).toEqual(Status.OPEN);
      expect(l.escrows.member(Z1)).toBe(true);
    }
    logger.info(`Z1 result: ${json(r)}`);
  }, LONG);
});
