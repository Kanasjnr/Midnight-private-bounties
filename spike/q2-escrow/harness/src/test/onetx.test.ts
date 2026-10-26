// Spike Q3b and Q5: the one-transaction submit, on a local devnet.
//
// Runs inside a midnight-examples checkout (examples/bounty-escrow-spike).
//
//   B6  Q3b: submitOneTx pays out, and the same leak checks as Q2's B1 hold:
//       the solver's fresh coin nonce and the payout nonce never reach public
//       state, the payout nonce differs from the escrow nonce, and neither
//       wallet's coin key appears.
//   B7  Q5: two solvers call submitOneTx on the same bounty at the same time,
//       each with its own private-state store. One must win. Records what
//       happens to the loser's coin: does it stay in their wallet, or does the
//       losing transaction still pay it into the contract?

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
const COIN = 10n;

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

describe(`Spike Q3b and Q5: one-transaction submit (${config.networkId})`, () => {
  let alice: Party; // poster
  let bob: Party; // solver
  let charlie: Party; // second solver
  let address: ContractAddress;
  let color: TokenColor;

  const B6 = newId();
  const B7 = newId();

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

  async function post(id: Uint8Array, label: string) {
    const coin = freshCoin(color, REWARD);
    await call(alice, label, 'postBounty', [id, coin, BigInt(nowSec() + 3600)]);
    await syncWallet(logger, alice.wallet.wallet, 600_000);
    return coin;
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
    const make = async (role: 'ALICE' | 'BOB' | 'CHARLIE', name: string): Promise<Party> => {
      const setup = resolveWallet(config.networkId === 'undeployed' ? 'local' : config.networkId, role);
      const wallet = await MidnightWalletProvider.build(logger, env, setup.secret, { fastSync: setup.fastSync });
      await wallet.start();
      await syncWallet(logger, wallet.wallet, 600_000);
      // A separate store, and so a separate LevelDB directory, per party.
      const prov = buildProviders(wallet, bountyZkConfigPath, config, `onetx-${name}`);
      return { name, wallet, prov, psId: `OneTx${name}`, sk: new Uint8Array(randomBytes(32)) };
    };
    alice = await make('ALICE', 'alice');
    bob = await make('BOB', 'bob');
    charlie = await make('CHARLIE', 'charlie');

    const t0 = Date.now();
    const deployed = await (deployContract as any)(alice.prov, {
      compiledContract: CompiledBountyContract,
      privateStateId: alice.psId,
      initialPrivateState: createBountyPrivateState(alice.sk),
    });
    address = deployed.deployTxData.public.contractAddress;
    timings.push({ step: 'deploy', seconds: Math.round((Date.now() - t0) / 100) / 10 });
    color = tokenColor('bounty:test-token', address);
    for (const p of [alice, bob, charlie]) p.prov.privateStateProvider.setContractAddress(address);

    const keys = encryptionKeys(alice.wallet, bob.wallet, charlie.wallet);
    for (const [to, amount] of [[alice, 3n * REWARD], [bob, 3n * COIN], [charlie, 3n * COIN]] as const) {
      await alice.prov.privateStateProvider.set(alice.psId, createBountyPrivateState(alice.sk));
      await (submitCallTx as any)(alice.prov, {
        compiledContract: CompiledBountyContract,
        contractAddress: address,
        privateStateId: alice.psId,
        circuitId: 'mintTestTokens',
        args: [amount, mintNonce(), recipientOf(to.wallet)],
        additionalCoinEncPublicKeyMappings: keys,
      });
      await syncWallet(logger, alice.wallet.wallet, 600_000);
    }
    await waitForShieldedBalance(alice.wallet, color, 3n * REWARD, { logger });
    await waitForShieldedBalance(bob.wallet, color, 3n * COIN, { logger });
    await waitForShieldedBalance(charlie.wallet, color, 3n * COIN, { logger });
  }, LONG);

  afterAll(async () => {
    results['finishedAt'] = new Date().toISOString();
    results['timings'] = timings;
    writeFileSync('onetx-results.json', json(results));
    for (const p of [alice, bob, charlie]) if (p) await p.wallet.stop().catch(() => undefined);
  });

  it('B6 (Q3b): the one-transaction payout passes the Q2 leak checks', async () => {
    const reward = await post(B6, 'B6 postBounty');
    const bobBefore = await balance(bob);
    const fresh = freshCoin(color, COIN);
    await call(bob, 'B6 submitOneTx (bob)', 'submitOneTx', [B6, 6n, fresh]);

    const bobAfter = await waitForShieldedBalance(bob.wallet, color, bobBefore + REWARD, { logger });
    const l = await query();
    const payout = (await shieldedCoins(bob.wallet, color)).find((c) => c.value === REWARD + COIN);

    // Every byte array in the public ledger.
    const pool: { label: string; bytes: Uint8Array }[] = [];
    for (const [k, b] of l.bounties) pool.push({ label: 'bounties.key', bytes: k }, { label: 'bounties.poster', bytes: b.poster });
    for (const [k, c] of l.escrows) pool.push({ label: 'escrows.key', bytes: k }, { label: 'escrows.nonce', bytes: c.nonce }, { label: 'escrows.color', bytes: c.color });
    for (const [k, v] of l.stakes) pool.push({ label: 'stakes.key', bytes: k }, { label: 'stakes.value', bytes: v });
    for (const [k] of l.deliveries) pool.push({ label: 'deliveries.key', bytes: k });
    const leak = (t: Uint8Array) => pool.find((x) => hex(x.bytes) === hex(t))?.label ?? null;

    const r = {
      solverDelta: bobAfter - bobBefore,
      status: Status[l.bounties.lookup(B6).status],
      delivery: l.deliveries.lookup(B6),
      payoutCoinFound: Boolean(payout),
      freshNonceLeak: leak(fresh.nonce),
      payoutNonceLeak: payout ? leak(payout.nonce) : 'payout coin not found',
      payoutNonceEqualsEscrowNonce: payout ? hex(payout.nonce) === hex(reward.nonce) : null,
      payoutNonceEqualsFreshNonce: payout ? hex(payout.nonce) === hex(fresh.nonce) : null,
      solverCoinPkLeak: leak(encodeCoinPublicKey(bob.wallet.getCoinPublicKey())),
      posterCoinPkLeak: leak(encodeCoinPublicKey(alice.wallet.getCoinPublicKey())),
      solverSkLeak: leak(bob.sk),
      byteFieldsChecked: pool.length,
    };
    results['b6'] = r;
    logger.info(`B6 result: ${json(r)}`);

    expect(r.solverDelta).toEqual(REWARD);
    expect(r.payoutCoinFound).toBe(true);
    expect(r.freshNonceLeak).toBeNull();
    expect(r.payoutNonceLeak).toBeNull();
    expect(r.payoutNonceEqualsEscrowNonce).toBe(false);
    expect(r.solverCoinPkLeak).toBeNull();
    expect(r.posterCoinPkLeak).toBeNull();
    expect(r.solverSkLeak).toBeNull();
  }, LONG);

  it('B7 (Q5): two solvers race on chain; one wins, and we record what the loser keeps', async () => {
    await post(B7, 'B7 postBounty');
    const bobBefore = await balance(bob);
    const charlieBefore = await balance(charlie);

    const settled = await Promise.allSettled([
      call(bob, 'B7 submitOneTx (bob, race)', 'submitOneTx', [B7, 71n, freshCoin(color, COIN)]),
      call(charlie, 'B7 submitOneTx (charlie, race)', 'submitOneTx', [B7, 72n, freshCoin(color, COIN)]),
    ]);
    const outcome = settled.map((s, i) => ({
      who: i === 0 ? 'bob' : 'charlie',
      status: s.status,
      error: s.status === 'rejected' ? errText(s.reason) : undefined,
    }));
    const winners = outcome.filter((o) => o.status === 'fulfilled').map((o) => o.who);

    // Give the chain time to settle before reading balances.
    const l = await query();
    const bobDelta = (await balance(bob)) - bobBefore;
    const charlieDelta = (await balance(charlie)) - charlieBefore;
    const r = {
      outcome,
      winners,
      status: Status[l.bounties.lookup(B7).status],
      delivery: l.deliveries.member(B7) ? l.deliveries.lookup(B7) : null,
      bobDelta,
      charlieDelta,
      // Where the loser's coin went: 0 means it never left their wallet;
      // -COIN means the losing transaction still paid it into the contract.
      loserDelta: winners.length === 1 ? (winners[0] === 'bob' ? charlieDelta : bobDelta) : null,
      escrowStillPresent: l.escrows.member(B7),
    };
    results['b7'] = r;
    logger.info(`B7 result: ${json(r)}`);

    expect(winners.length).toBe(1);
    expect(l.bounties.lookup(B7).status).toEqual(Status.SOLVED);
    const winnerDelta = winners[0] === 'bob' ? bobDelta : charlieDelta;
    expect(winnerDelta).toEqual(REWARD);
  }, LONG);
});
