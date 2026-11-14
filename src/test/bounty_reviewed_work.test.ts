// Devnet tests for reviewed work: real proofs, real transactions, real block
// time. The windows are checked against block timestamps here, not the
// simulator's wall clock, with the 15-minute slack the design proposes.
//
//   W5  setup: work is submitted and nobody reviews or collects it.
//   W1  Applicant mode: the poster assigns, the contributor submits a link
//       encrypted to the poster, the poster approves, and the contributor
//       collects with a fresh coin of their own. The poster decrypts the link,
//       and nothing secret (keys, link, coin nonces, wallet keys) is public.
//   W2  Silence pays: once the review window passes with no review, the
//       contributor collects without an approval.
//   W3  First to claim: a window end past now + window is rejected; one
//       contributor claims, the poster releases the claim, another claims.
//   W5  Once review-by plus the collect-by window has passed, the contributor
//       can't collect and the poster takes the reward back.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import {
  CompactTypeBytes,
  CompactTypeVector,
  type ContractAddress,
  encodeCoinPublicKey,
  encodeContractAddress,
  persistentHash,
} from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
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
} from './coins.js';
import { assertNotInPublicState } from './sim.js';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';
import { WebSocket } from 'ws';

import { getConfig } from '../config.js';
import { MidnightWalletProvider, resolveWallet, syncWallet, waitForNightThenDust } from '../wallet.js';
import { buildProviders, ledgerState, type BountyProviders } from '../providers.js';
import {
  CompiledBountyReviewedWorkContract,
  CompiledTestTokenContract,
  bountyReviewedWorkLedger,
  bountyReviewedWorkPureCircuits as pure,
  bountyReviewedWorkZkConfigPath,
  testTokenZkConfigPath,
  WorkStatus as Status,
  type BountyReviewedWorkLedger,
  type Terms,
} from '../../contract/index.js';
import { createBountyPrivateState, randomScalar, NO_ANSWER } from '../../contract/witnesses.js';
import { posterKeyFor } from '../../contract/keys.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });
const config = getConfig();
const NETWORK = process.env['MIDNIGHT_NETWORK'] ?? 'local';
const REMOTE = NETWORK !== 'local';
const LONG = 45 * 60_000;
const REWARD = 100n;
const STAKE = 10n;
const MIN_REWARD = 1n;
const MIN_WINDOW = 0n;
// The slack the design proposes: a call has up to 15 minutes to land.
const SLACK = 900n;
// Short, so W5 can wait it out: approved or unreviewed work is collectable for
// 5 minutes after its review-by.
const COLLECT = 300n;
const HOUR = 3600n;
// W2's and W5's review window: long enough for the submit to land, short
// enough to wait out.
const SHORT_REVIEW = 120n;
const TITLE = 'Write a migration guide for the latest SDK';
const DETAILS = 'Cover every breaking change, with a before and after for each. Link the PR when done.';
// W5, W1, W2 and W3 each escrow one reward.
const WORKS = 4n;

const nowSec = (): bigint => BigInt(Math.floor(Date.now() / 1000));
// A minute back, so a block clock running slightly behind can't reject it.
const postedAt = (): bigint => nowSec() - 60n;
// A window end a minute short of now + window: inside [now + window - slack,
// now + window] even if the block clock lags the test's by up to a minute.
const windowEnd = (window: bigint): bigint => nowSec() + window - 60n;
const newId = (): Uint8Array => new Uint8Array(randomBytes(32));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = async (t: bigint) => {
  const wait = Number(t - nowSec()) * 1000;
  if (wait > 0) await sleep(wait);
};
const fieldBytes = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return b;
};
const pad32 = (label: string): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label));
  return out;
};
const randomLink = (): bigint[] => [randomScalar(), randomScalar(), randomScalar(), randomScalar()];

type Party = {
  name: string;
  wallet: MidnightWalletProvider;
  prov: BountyProviders;
  psId: string;
  sk: Uint8Array;
};

describe(`bounty_reviewed_work on ${config.networkId}`, () => {
  let alice: Party; // poster
  let bob: Party; // contributor
  let charlie: Party; // a second contributor
  let tokenProv: BountyProviders;
  let tokenAddress: ContractAddress;
  let address: ContractAddress;
  let color: TokenColor;

  const posterSeed = new Uint8Array(randomBytes(32));
  let W5: Uint8Array;
  let w5ReviewBy = 0n;

  async function query(): Promise<BountyReviewedWorkLedger> {
    const s = await alice.prov.publicDataProvider.queryContractState(address);
    expect(s).not.toBeNull();
    return bountyReviewedWorkLedger(ledgerState(s));
  }

  async function balance(p: Party): Promise<bigint> {
    await syncWallet(logger, p.wallet.wallet, 600_000);
    return shieldedBalance(p.wallet, color);
  }

  async function call(p: Party, label: string, circuitId: string, args: unknown[], link: bigint[] = NO_ANSWER) {
    await p.prov.privateStateProvider.forContract(address).set(p.psId, createBountyPrivateState(p.sk, link));
    const t0 = Date.now();
    const tx = await (submitCallTx as any)(p.prov, {
      compiledContract: CompiledBountyReviewedWorkContract,
      contractAddress: address,
      privateStateId: p.psId,
      circuitId,
      args,
    });
    logger.info(`${label}: ok in ${Math.round((Date.now() - t0) / 100) / 10}s (tx ${tx.public.txId.slice(0, 16)}…)`);
    return tx;
  }

  const terms = (t: Partial<Terms> = {}): Terms => ({
    firstToClaim: false,
    deliveryWindow: HOUR,
    reviewWindow: HOUR,
    appealWindow: 0n,
    deadline: nowSec() + 2n * HOUR,
    hasArbiter: false,
    arbiter: new Uint8Array(32),
    ...t,
  });

  async function post(t: Partial<Terms>, label: string) {
    const salt = newId();
    const id = pure.bountyIdFor(salt, alice.sk);
    const reward = freshCoin(color, REWARD);
    const key = await posterKeyFor(posterSeed, address, id);
    const tt = terms(t);
    await call(alice, label, 'postWork', [salt, reward, pure.posterPublicKey(key), tt, TITLE, DETAILS, postedAt()]);
    await syncWallet(logger, alice.wallet.wallet, 600_000);
    return { id, reward, key, terms: tt };
  }

  /** A contributor's per-bounty pseudonym, worked out off chain as an applicant would. */
  const pseudonym = (id: Uint8Array, sk: Uint8Array): Uint8Array =>
    persistentHash(new CompactTypeVector(4, new CompactTypeBytes(32)), [
      pad32('bounty:contributor'),
      encodeContractAddress(address),
      id,
      sk,
    ]);

  /** Post in applicant mode, assign Bob, and have him submit `link`. */
  async function submitted(t: Partial<Terms>, link: bigint[], tag: string) {
    const p = await post(t, `${tag} postWork`);
    await call(alice, `${tag} assign`, 'assign', [p.id, pseudonym(p.id, bob.sk), windowEnd(p.terms.deliveryWindow)]);
    const reviewBy = windowEnd(p.terms.reviewWindow);
    await call(bob, `${tag} submit`, 'submit', [p.id, reviewBy], link);
    return { ...p, reviewBy };
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
      const setup = resolveWallet(NETWORK, role);
      const wallet = await MidnightWalletProvider.build(logger, env, setup.secret);
      await wallet.start();
      await syncWallet(logger, wallet.wallet, REMOTE ? 60 * 60_000 : 600_000);
      // Synced is not funded: on a remote network, wait for NIGHT and register it for DUST.
      if (REMOTE) await waitForNightThenDust(logger, wallet.wallet, wallet.unshieldedKeystore, env, config.faucet, { label: setup.role });
      const prov = buildProviders(wallet, bountyReviewedWorkZkConfigPath, config, `rw-${name}`);
      return { name, wallet, prov, psId: `RW${name}`, sk: new Uint8Array(randomBytes(32)) };
    };
    alice = await make('ALICE', 'alice');
    bob = await make('BOB', 'bob');
    charlie = await make('CHARLIE', 'charlie');
    tokenProv = buildProviders(alice.wallet, testTokenZkConfigPath, config, 'rw-alice-token');

    const token = await (deployContract as any)(tokenProv, { compiledContract: CompiledTestTokenContract });
    tokenAddress = token.deployTxData.public.contractAddress;
    color = tokenColor('bounty:test-token', tokenAddress);
    const work = await (deployContract as any)(alice.prov, {
      compiledContract: CompiledBountyReviewedWorkContract,
      privateStateId: alice.psId,
      initialPrivateState: createBountyPrivateState(alice.sk),
      args: [color.bytes, MIN_REWARD, MIN_WINDOW, SLACK, COLLECT],
    });
    address = work.deployTxData.public.contractAddress;
    logger.info(`token ${tokenAddress}, reviewed-work contract ${address}`);

    // Alice funds the rewards. Bob brings a small coin of his own to collect
    // with, as a contributor may; W2 collects with a zero-value one.
    const keys = encryptionKeys(alice.wallet, bob.wallet, charlie.wallet);
    for (const [to, amount] of [[alice, (WORKS + 1n) * REWARD], [bob, 2n * STAKE]] as const) {
      await (submitCallTx as any)(tokenProv, {
        compiledContract: CompiledTestTokenContract,
        contractAddress: tokenAddress,
        circuitId: 'mint',
        args: [amount, mintNonce(), recipientOf(to.wallet)],
        additionalCoinEncPublicKeyMappings: keys,
      });
      await syncWallet(logger, alice.wallet.wallet, 600_000);
    }
    await waitForShieldedBalance(alice.wallet, color, (WORKS + 1n) * REWARD, { logger });
    await waitForShieldedBalance(bob.wallet, color, 2n * STAKE, { logger });
  }, LONG);

  afterAll(async () => {
    for (const p of [alice, bob, charlie]) if (p) await p.wallet.stop().catch(() => undefined);
  });

  it('W5 setup: work is submitted with a short review window, then left alone', async () => {
    const p = await submitted({ reviewWindow: SHORT_REVIEW }, randomLink(), 'W5');
    W5 = p.id;
    w5ReviewBy = p.reviewBy;
    const w = (await query()).works.lookup(W5);
    expect(w.status).toEqual(Status.SUBMITTED);
    expect(w.until).toEqual(w5ReviewBy);
  }, LONG);

  it('W1: assign, submit, approve and an unlinkable collect; the poster decrypts; nothing secret is public', async () => {
    const link = randomLink();
    const p = await submitted({}, link, 'W1');
    let l = await query();
    expect(l.works.lookup(p.id).status).toEqual(Status.SUBMITTED);
    expect(Buffer.from(l.works.lookup(p.id).contributor).equals(Buffer.from(pseudonym(p.id, bob.sk)))).toBe(true);
    expect(l.listings.lookup(p.id)).toMatchObject({ title: TITLE, details: DETAILS, reward: REWARD });
    expect(pure.decrypt(l.submissions.lookup(p.id), p.key, p.id)).toEqual(link);

    await expect(call(bob, 'W1 approve by contributor', 'approve', [p.id])).rejects.toThrow(/Only the poster can approve/);
    await call(alice, 'W1 approve', 'approve', [p.id]);

    const bobBefore = await balance(bob);
    const stake = freshCoin(color, STAKE);
    await call(bob, 'W1 collect', 'collect', [p.id, stake]);
    const bobAfter = await waitForShieldedBalance(bob.wallet, color, bobBefore + REWARD, { logger });
    expect(bobAfter - bobBefore).toEqual(REWARD); // reward in, own coin back

    l = await query();
    expect(l.works.lookup(p.id).status).toEqual(Status.PAID);
    expect(l.escrows.member(p.id)).toBe(false);
    const payout = (await shieldedCoins(bob.wallet, color)).find((c) => c.value === REWARD + STAKE);
    expect(payout).toBeDefined();
    const secrets: Record<string, Uint8Array> = {
      posterSk: alice.sk,
      contributorSk: bob.sk,
      posterKey: fieldBytes(p.key),
      posterSeed,
      stakeNonce: stake.nonce,
      payoutNonce: payout!.nonce,
      contributorCoinKey: encodeCoinPublicKey(bob.wallet.getCoinPublicKey()),
      posterCoinKey: encodeCoinPublicKey(alice.wallet.getCoinPublicKey()),
    };
    link.forEach((m, i) => (secrets[`link[${i}]`] = fieldBytes(m)));
    assertNotInPublicState(l, secrets);
    expect(Buffer.from(payout!.nonce).equals(Buffer.from(p.reward.nonce))).toBe(false);
  }, LONG);

  it('W2: silence pays once the review window has passed on chain', async () => {
    const p = await submitted({ reviewWindow: SHORT_REVIEW }, randomLink(), 'W2');
    await expect(call(bob, 'W2 early collect', 'collect', [p.id, freshCoin(color, 0n)])).rejects.toThrow(
      /review window is still open/,
    );
    // Past review-by by a margin, so the block time is past it too.
    await sleepUntil(p.reviewBy + 30n);
    await expect(call(alice, 'W2 late reject', 'reject', [p.id, 0n])).rejects.toThrow(/Deadline has passed/);
    const bobBefore = await balance(bob);
    await call(bob, 'W2 collect without approval', 'collect', [p.id, freshCoin(color, 0n)]);
    expect((await waitForShieldedBalance(bob.wallet, color, bobBefore + REWARD, { logger })) - bobBefore).toEqual(REWARD);
    expect((await query()).works.lookup(p.id).status).toEqual(Status.PAID);
  }, LONG);

  it('W3: first to claim: a too-late window end is rejected; a claim is released and claimed by someone else', async () => {
    const p = await post({ firstToClaim: true }, 'W3 postWork');
    await expect(call(charlie, 'W3 claim too late', 'claim', [p.id, nowSec() + HOUR + 600n])).rejects.toThrow(
      /Window end is too late/,
    );
    await call(charlie, 'W3 claim (charlie)', 'claim', [p.id, windowEnd(HOUR)]);
    await expect(call(bob, 'W3 second claim', 'claim', [p.id, windowEnd(HOUR)])).rejects.toThrow(/Not open/);
    await call(alice, 'W3 release', 'release', [p.id]);
    expect((await query()).works.lookup(p.id).status).toEqual(Status.OPEN);
    await call(bob, 'W3 claim (bob)', 'claim', [p.id, windowEnd(HOUR)]);
    const w = (await query()).works.lookup(p.id);
    expect(w.status).toEqual(Status.ASSIGNED);
    expect(Buffer.from(w.contributor).equals(Buffer.from(pseudonym(p.id, bob.sk)))).toBe(true);
  }, LONG);

  it('W5: past the collect-by time the contributor can no longer collect, and the poster takes the reward back', async () => {
    await sleepUntil(w5ReviewBy + COLLECT + 30n);
    await expect(call(bob, 'W5 late collect', 'collect', [W5, freshCoin(color, 0n)])).rejects.toThrow(
      /Past the collect-by time/,
    );
    await expect(call(bob, 'W5 refund by contributor', 'refund', [W5])).rejects.toThrow(/Only the poster can refund/);
    const aliceBefore = await balance(alice);
    await call(alice, 'W5 refund (poster)', 'refund', [W5]);
    expect((await waitForShieldedBalance(alice.wallet, color, aliceBefore + REWARD, { logger })) - aliceBefore).toEqual(REWARD);
    expect((await query()).works.lookup(W5).status).toEqual(Status.REFUNDED);
  }, LONG);
});
