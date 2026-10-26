// Spike Q2: bounty escrow on a local devnet, with real proofs and transactions.
//
// Runs inside a midnight-examples checkout (examples/bounty-escrow-spike) and
// reuses its harness (wallets, providers, example-coins, example-fast-sync),
// following examples/shielded-chips. Records what actually happens, including
// failures, in q2-results.json next to package.json.
//
// Bounties:
//   B3  short deadline: refund before the deadline is rejected; after it, a late
//       submit and a non-poster refund are rejected, the poster refund works,
//       and the solver withdraws the stake.          (Q5, Q7, refund)
//   B1  happy path: stake, submit, payout, privacy checks.   (Q2, Q7)
//   B2  submit with a wrong stake opening is rejected, nothing changes.  (Q5)
//
// B4 (two-step race) and B5 (first one-transaction submit) were removed after
// onetx.test.ts superseded them with B7 and B6. Their results stay in
// RESULTS.md.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { type ContractAddress, encodeCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  contractCoinMtIndex,
  encryptionKeys,
  freshCoin,
  mintNonce,
  recipientOf,
  shieldedBalance,
  shieldedCoins,
  tokenColor,
  waitForShieldedBalance,
  type ShieldedCoinArg,
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
  type BountyContract,
  bountyLedger,
  Status,
  bountyZkConfigPath,
  type BountyLedger,
} from '../../contract/index.js';
import { createBountyPrivateState, type QualifiedCoin } from '../../contract/witnesses.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });
const config = getConfig();
const LONG = 45 * 60_000;

const REWARD = 100n;
const STAKE = 10n;

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');
const nowSec = (): number => Math.floor(Date.now() / 1000);
const newId = (): Uint8Array => new Uint8Array(randomBytes(32));

// Everything the run observes, written to q2-results.json at the end.
const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const timings: { step: string; seconds: number }[] = [];
const txs: { label: string; txId: string }[] = [];

function errText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const m = cur instanceof Error ? cur.message : String(cur);
    parts.push(m);
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

type StakeRecord = { salt: Uint8Array; coin: QualifiedCoin };

describe(`Spike Q2: bounty escrow (${config.networkId})`, () => {
  let alice: Party; // poster
  let bob: Party; // solver
  let charlie: Party; // second solver, and a non-poster
  let address: ContractAddress;
  let color: TokenColor;

  // Per-bounty stake records, by party name and bounty hex.
  const stakes = new Map<string, StakeRecord>();
  const stakeKeyOf = (p: Party, id: Uint8Array) => `${p.name}:${hex(id)}`;

  const B1 = newId();
  const B2 = newId();
  const B3 = newId();
  let b3Deadline = 0n;

  async function query(): Promise<BountyLedger> {
    const s = await alice.prov.publicDataProvider.queryContractState(address);
    expect(s).not.toBeNull();
    return bountyLedger(s!.data);
  }

  async function sync(p: Party) {
    await syncWallet(logger, p.wallet.wallet, 600_000);
  }

  async function balance(p: Party): Promise<bigint> {
    await sync(p);
    return shieldedBalance(p.wallet, color);
  }

  // Set the private state the witnesses read for the next call.
  async function usePrivateState(p: Party, stake?: StakeRecord) {
    const ps = createBountyPrivateState(p.sk, stake?.salt);
    await p.prov.privateStateProvider.set(p.psId, stake ? { ...ps, stakeCoin: stake.coin } : ps);
  }

  async function call(p: Party, label: string, circuitId: string, args: unknown[]) {
    const t0 = Date.now();
    const tx = await (submitCallTx as any)(p.prov, {
      compiledContract: CompiledBountyContract,
      contractAddress: address,
      privateStateId: p.psId,
      circuitId,
      args,
    });
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    timings.push({ step: label, seconds });
    txs.push({ label, txId: tx.public.txId });
    logger.info(`${label}: ok in ${seconds}s (tx ${tx.public.txId.slice(0, 16)}…)`);
    return tx;
  }

  async function post(id: Uint8Array, deadline: bigint, label: string): Promise<ShieldedCoinArg> {
    const coin = freshCoin(color, REWARD);
    await usePrivateState(alice);
    await call(alice, label, 'postBounty', [id, coin, deadline]);
    await sync(alice);
    return coin;
  }

  async function stake(p: Party, id: Uint8Array, label: string): Promise<StakeRecord> {
    const salt = new Uint8Array(randomBytes(32));
    const coin = freshCoin(color, STAKE);
    await usePrivateState(p, { salt, coin: { ...coin, mt_index: 0n } });
    const tx = await call(p, label, 'stake', [id, coin]);
    const mtIndex = await contractCoinMtIndex(config.indexer, tx.public, coin, address);
    const rec: StakeRecord = { salt, coin: { ...coin, mt_index: mtIndex } };
    stakes.set(stakeKeyOf(p, id), rec);
    logger.info(`${label}: stake mt_index=${mtIndex}`);
    await sync(p);
    return rec;
  }

  async function expectRejected(label: string, fn: () => Promise<unknown>): Promise<string> {
    const t0 = Date.now();
    try {
      await fn();
    } catch (e) {
      const msg = errText(e);
      timings.push({ step: `${label} (rejected)`, seconds: Math.round((Date.now() - t0) / 100) / 10 });
      logger.info(`${label}: rejected as expected: ${msg.slice(0, 300)}`);
      return msg;
    }
    throw new Error(`${label}: expected a rejection, but the call succeeded`);
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
      const prov = buildProviders(wallet, bountyZkConfigPath, config, `q2-${name}`);
      return { name, wallet, prov, psId: `Q2${name}`, sk: new Uint8Array(randomBytes(32)) };
    };
    alice = await make('ALICE', 'alice');
    bob = await make('BOB', 'bob');
    charlie = await make('CHARLIE', 'charlie');
  }, LONG);

  afterAll(async () => {
    results['finishedAt'] = new Date().toISOString();
    results['timings'] = timings;
    results['transactions'] = txs;
    writeFileSync('q2-results.json', JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    for (const p of [alice, bob, charlie]) if (p) await p.wallet.stop().catch(() => undefined);
  });

  it('deploys and mints test tokens', async () => {
    const t0 = Date.now();
    const deployed = await (deployContract as any)(alice.prov, {
      compiledContract: CompiledBountyContract,
      privateStateId: alice.psId,
      initialPrivateState: createBountyPrivateState(alice.sk),
    });
    address = deployed.deployTxData.public.contractAddress;
    timings.push({ step: 'deploy', seconds: Math.round((Date.now() - t0) / 100) / 10 });
    txs.push({ label: 'deploy', txId: deployed.deployTxData.public.txId });
    color = tokenColor('bounty:test-token', address);
    results['contractAddress'] = address;
    results['tokenColor'] = color.hex;

    for (const p of [bob, charlie]) {
      p.prov.privateStateProvider.setContractAddress(address);
      await p.prov.privateStateProvider.set(p.psId, createBountyPrivateState(p.sk));
    }
    alice.prov.privateStateProvider.setContractAddress(address);

    const keys = encryptionKeys(alice.wallet, bob.wallet, charlie.wallet);
    const mintTo = async (to: Party, amount: bigint) => {
      const t1 = Date.now();
      const tx = await (submitCallTx as any)(alice.prov, {
        compiledContract: CompiledBountyContract,
        contractAddress: address,
        privateStateId: alice.psId,
        circuitId: 'mintTestTokens',
        args: [amount, mintNonce(), recipientOf(to.wallet)],
        additionalCoinEncPublicKeyMappings: keys,
      });
      timings.push({ step: `mint ${amount} to ${to.name}`, seconds: Math.round((Date.now() - t1) / 100) / 10 });
      txs.push({ label: `mint to ${to.name}`, txId: tx.public.txId });
      await sync(alice);
    };
    await mintTo(alice, 5n * REWARD);
    await mintTo(bob, 5n * STAKE);
    await mintTo(charlie, 5n * STAKE);

    expect(await waitForShieldedBalance(alice.wallet, color, 5n * REWARD, { logger })).toEqual(5n * REWARD);
    expect(await waitForShieldedBalance(bob.wallet, color, 5n * STAKE, { logger })).toEqual(5n * STAKE);
    expect(await waitForShieldedBalance(charlie.wallet, color, 5n * STAKE, { logger })).toEqual(5n * STAKE);
  }, LONG);

  it('B3: posts with a short deadline; an early refund is rejected; Bob stakes', async () => {
    // 6 minutes: long enough for Bob's stake to land on this machine.
    b3Deadline = BigInt(nowSec() + 360);
    results['b3'] = { deadline: b3Deadline, postedAtWallClock: nowSec() };
    await post(B3, b3Deadline, 'B3 postBounty');

    const early = await expectRejected('B3 refund before deadline', async () => {
      await usePrivateState(alice);
      await call(alice, 'B3 refund (early)', 'refund', [B3]);
    });
    (results['b3'] as Record<string, unknown>)['earlyRefund'] = early;
    expect(early).toMatch(/Deadline has not passed/);

    await stake(bob, B3, 'B3 stake (bob)');
    (results['b3'] as Record<string, unknown>)['stakedBeforeDeadline'] = BigInt(nowSec()) < b3Deadline;
  }, LONG);

  it('B1: happy path: post, stake, submit before the deadline, payout to the solver', async () => {
    const deadline = BigInt(nowSec() + 3600);
    const reward = await post(B1, deadline, 'B1 postBounty');

    let l = await query();
    const esc = l.escrows.lookup(B1);
    const r: Record<string, unknown> = {
      deadline,
      escrowNonceIsPublic: hex(esc.nonce) === hex(reward.nonce),
      escrowValueIsPublic: esc.value === REWARD,
      escrowMtIndex: esc.mt_index,
      posterPseudonymPublic: hex(l.bounties.lookup(B1).poster),
    };
    results['b1'] = r;
    expect(r['escrowNonceIsPublic']).toBe(true);

    const bobBefore = await balance(bob);
    const rec = await stake(bob, B1, 'B1 stake (bob)');
    l = await query();
    r['stakeCount'] = l.stakes.size();
    r['stakeMtIndex'] = rec.coin.mt_index;

    await usePrivateState(bob, rec);
    await call(bob, 'B1 submit (bob)', 'submit', [B1, 4242n]);

    const bobAfter = await waitForShieldedBalance(bob.wallet, color, bobBefore + REWARD, { logger });
    r['solverBalanceBefore'] = bobBefore;
    r['solverBalanceAfter'] = bobAfter;
    expect(bobAfter).toEqual(bobBefore + REWARD); // paid stake back + reward

    l = await query();
    r['status'] = Status[l.bounties.lookup(B1).status];
    r['delivery'] = l.deliveries.lookup(B1);
    r['escrowRemoved'] = !l.escrows.member(B1);
    expect(l.bounties.lookup(B1).status).toEqual(Status.SOLVED);
    expect(l.deliveries.lookup(B1)).toEqual(4242n);

    // The payout is one coin of reward + stake.
    const payout = (await shieldedCoins(bob.wallet, color)).find((c) => c.value === REWARD + STAKE);
    r['payoutCoinFound'] = Boolean(payout);

    // ---- Privacy: walk every byte array in the public ledger. ----
    const pool: { label: string; bytes: Uint8Array }[] = [];
    for (const [k, b] of l.bounties) {
      pool.push({ label: 'bounties.key', bytes: k }, { label: 'bounties.poster', bytes: b.poster });
    }
    for (const [k, c] of l.escrows) {
      pool.push({ label: 'escrows.key', bytes: k }, { label: 'escrows.nonce', bytes: c.nonce }, { label: 'escrows.color', bytes: c.color });
    }
    for (const [k, v] of l.stakes) pool.push({ label: 'stakes.key', bytes: k }, { label: 'stakes.value', bytes: v });
    for (const [k] of l.deliveries) pool.push({ label: 'deliveries.key', bytes: k });
    const leak = (t: Uint8Array) => pool.find((x) => hex(x.bytes) === hex(t))?.label ?? null;

    const privacy = {
      stakeNonceLeak: leak(rec.coin.nonce),
      payoutNonceLeak: payout ? leak(payout.nonce) : 'payout coin not found',
      payoutNonceEqualsEscrowNonce: payout ? hex(payout.nonce) === hex(reward.nonce) : null,
      solverCoinPkLeak: leak(encodeCoinPublicKey(bob.wallet.getCoinPublicKey())),
      posterCoinPkLeak: leak(encodeCoinPublicKey(alice.wallet.getCoinPublicKey())),
      solverSkLeak: leak(bob.sk),
      byteFieldsChecked: pool.length,
    };
    r['privacy'] = privacy;
    expect(privacy.stakeNonceLeak).toBeNull();
    expect(privacy.payoutNonceLeak).toBeNull();
    expect(privacy.payoutNonceEqualsEscrowNonce).toBe(false);
    expect(privacy.solverCoinPkLeak).toBeNull();
    expect(privacy.posterCoinPkLeak).toBeNull();
  }, LONG);

  it('B2: submit with a wrong stake opening is rejected and changes nothing', async () => {
    await post(B2, BigInt(nowSec() + 3600), 'B2 postBounty');
    const rec = await stake(charlie, B2, 'B2 stake (charlie)');
    const before = await query();

    const wrong = { ...rec, salt: new Uint8Array(randomBytes(32)) };
    const msg = await expectRejected('B2 submit with wrong salt', async () => {
      await usePrivateState(charlie, wrong);
      await call(charlie, 'B2 submit (wrong salt)', 'submit', [B2, 1n]);
    });
    const after = await query();
    const r = {
      error: msg,
      statusStillOpen: after.bounties.lookup(B2).status === Status.OPEN,
      escrowStillPresent: after.escrows.member(B2),
      noDelivery: !after.deliveries.member(B2),
      stakesUnchanged: after.stakes.size() === before.stakes.size(),
    };
    results['b2'] = r;
    expect(msg).toMatch(/Stake does not match commitment/);
    expect(r.statusStillOpen && r.escrowStillPresent && r.noDelivery && r.stakesUnchanged).toBe(true);
  }, LONG);

  it('B3: after the deadline, late submit and non-poster refund fail; poster refund and stake withdrawal work', async () => {
    const r = results['b3'] as Record<string, unknown>;
    const waitMs = (Number(b3Deadline) + 30 - nowSec()) * 1000;
    if (waitMs > 0) {
      logger.info(`Waiting ${Math.round(waitMs / 1000)}s for the B3 deadline to pass`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    r['checkedAtWallClock'] = nowSec();

    const bobRec = stakes.get(stakeKeyOf(bob, B3))!;
    r['lateSubmit'] = await expectRejected('B3 submit after deadline', async () => {
      await usePrivateState(bob, bobRec);
      await call(bob, 'B3 submit (late)', 'submit', [B3, 7n]);
    });
    expect(r['lateSubmit']).toMatch(/Deadline has passed/);

    r['nonPosterRefund'] = await expectRejected('B3 refund by non-poster', async () => {
      await usePrivateState(charlie);
      await call(charlie, 'B3 refund (charlie)', 'refund', [B3]);
    });
    expect(r['nonPosterRefund']).toMatch(/Only the poster can refund/);

    let l = await query();
    r['afterRejections'] = {
      statusOpen: l.bounties.lookup(B3).status === Status.OPEN,
      escrowPresent: l.escrows.member(B3),
      noDelivery: !l.deliveries.member(B3),
    };

    const aliceBefore = await balance(alice);
    await usePrivateState(alice);
    await call(alice, 'B3 refund (poster)', 'refund', [B3]);
    const aliceAfter = await waitForShieldedBalance(alice.wallet, color, aliceBefore + REWARD, { logger });
    r['posterRefunded'] = aliceAfter - aliceBefore;
    l = await query();
    r['status'] = Status[l.bounties.lookup(B3).status];
    expect(l.bounties.lookup(B3).status).toEqual(Status.REFUNDED);

    const bobBefore = await balance(bob);
    await usePrivateState(bob, bobRec);
    await call(bob, 'B3 withdrawStake (bob)', 'withdrawStake', [B3]);
    const bobAfter = await waitForShieldedBalance(bob.wallet, color, bobBefore + STAKE, { logger });
    r['solverWithdrewStake'] = bobAfter - bobBefore;
  }, LONG);

  it('reads entry points per transaction from the indexer', async () => {
    const query = `query ($id: HexEncoded!) { transactions(offset: { identifier: $id }) {
      __typename ... on RegularTransaction { contractActions { __typename address ... on ContractCall { entryPoint } } } } }`;
    const seen: unknown[] = [];
    for (const t of txs) {
      try {
        const res = await fetch(config.indexer, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { id: t.txId } }),
        });
        const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
        seen.push({ label: t.label, data: body.data, errors: body.errors?.map((e) => e.message) });
      } catch (e) {
        seen.push({ label: t.label, error: errText(e) });
      }
    }
    results['indexer'] = seen;
  }, LONG);
});
