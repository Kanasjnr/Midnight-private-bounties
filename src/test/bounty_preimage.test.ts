// Devnet tests for the preimage bounty: real proofs, real transactions.
//
//   D1  A solver submits in one transaction and is paid; the poster reads the
//       delivery from the chain and decrypts it; nothing secret reaches public
//       state.
//   D2  A wrong answer is rejected before anything is proved, and changes
//       nothing.
//   D3  Two solvers race: one is paid, and the node rejects the other's
//       transaction whole, so they keep their coin.
//   D4  Refund: rejected before the deadline and for a non-poster; after the
//       deadline the poster gets the reward back.
//   D5  A submit started before the deadline but landing after it is rejected
//       whole: the bounty stays open and the solver keeps their coin.
//
// The poster derives a separate encryption key for every bounty (keys.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
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
import { assertNotInPublicState } from '@midnight-ntwrk/example-sim';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';
import { WebSocket } from 'ws';

import { getConfig } from '../config.js';
import { MidnightWalletProvider, syncWallet } from '../wallet.js';
import { buildProviders, type BountyProviders } from '../providers.js';
import {
  CompiledBountyPreimageContract,
  CompiledTestTokenContract,
  bountyPreimageLedger,
  bountyPreimagePureCircuits as pure,
  bountyPreimageZkConfigPath,
  testTokenZkConfigPath,
  Status,
  type BountyPreimageLedger,
} from '../../contract/index.js';
import { createBountyPrivateState, randomScalar, NO_ANSWER } from '../../contract/witnesses.js';
import { posterKeyFor } from '../../contract/keys.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });
const config = getConfig();
const LONG = 45 * 60_000;
const REWARD = 100n;
const STAKE = 10n;
// D4, D1, D2, D3 and D5 each escrow one reward; D2's and D5's stay locked.
const BOUNTIES = 5n;

const nowSec = (): number => Math.floor(Date.now() / 1000);
const newId = (): Uint8Array => new Uint8Array(randomBytes(32));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fieldBytes = (x: bigint): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return b;
};
const randomAnswer = (): bigint[] => [randomScalar(), randomScalar(), randomScalar(), randomScalar()];

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
  prov: BountyProviders; // for the bounty contract
  psId: string;
  sk: Uint8Array;
};

describe(`bounty_preimage on ${config.networkId}`, () => {
  let alice: Party; // poster
  let bob: Party; // solver
  let charlie: Party; // second solver
  let tokenProv: BountyProviders; // Alice's providers for the test token
  let tokenAddress: ContractAddress;
  let address: ContractAddress;
  let color: TokenColor;

  const posterSeed = new Uint8Array(randomBytes(32)); // derives the poster's key per bounty
  const D4 = newId();
  let d4Deadline = 0;

  async function query(): Promise<BountyPreimageLedger> {
    const s = await alice.prov.publicDataProvider.queryContractState(address);
    expect(s).not.toBeNull();
    return bountyPreimageLedger(s!.data);
  }

  async function balance(p: Party): Promise<bigint> {
    await syncWallet(logger, p.wallet.wallet, 600_000);
    return shieldedBalance(p.wallet, color);
  }

  async function call(p: Party, label: string, circuitId: string, args: unknown[], answer: bigint[] = NO_ANSWER) {
    await p.prov.privateStateProvider.set(p.psId, createBountyPrivateState(p.sk, answer));
    const t0 = Date.now();
    const tx = await (submitCallTx as any)(p.prov, {
      compiledContract: CompiledBountyPreimageContract,
      contractAddress: address,
      privateStateId: p.psId,
      circuitId,
      args,
    });
    logger.info(`${label}: ok in ${Math.round((Date.now() - t0) / 100) / 10}s (tx ${tx.public.txId.slice(0, 16)}…)`);
    return tx;
  }

  async function post(id: Uint8Array, answer: bigint[], deadline: number, label: string) {
    const reward = freshCoin(color, REWARD);
    const key = await posterKeyFor(posterSeed, address, id);
    await call(alice, label, 'postBounty', [id, reward, pure.posterPublicKey(key), pure.answerHash(answer), BigInt(deadline)]);
    await syncWallet(logger, alice.wallet.wallet, 600_000);
    return { reward, key };
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
      // One store, and so one LevelDB directory, per party.
      const prov = buildProviders(wallet, bountyPreimageZkConfigPath, config, `pb-${name}`);
      return { name, wallet, prov, psId: `PB${name}`, sk: new Uint8Array(randomBytes(32)) };
    };
    alice = await make('ALICE', 'alice');
    bob = await make('BOB', 'bob');
    charlie = await make('CHARLIE', 'charlie');
    tokenProv = buildProviders(alice.wallet, testTokenZkConfigPath, config, 'pb-alice-token');

    // The test token, then the bounty contract that accepts it.
    const token = await (deployContract as any)(tokenProv, { compiledContract: CompiledTestTokenContract });
    tokenAddress = token.deployTxData.public.contractAddress;
    color = tokenColor('bounty:test-token', tokenAddress);
    const bounty = await (deployContract as any)(alice.prov, {
      compiledContract: CompiledBountyPreimageContract,
      privateStateId: alice.psId,
      initialPrivateState: createBountyPrivateState(alice.sk),
      args: [color.bytes],
    });
    address = bounty.deployTxData.public.contractAddress;
    for (const p of [alice, bob, charlie]) p.prov.privateStateProvider.setContractAddress(address);
    logger.info(`token ${tokenAddress}, bounty contract ${address}`);

    const keys = encryptionKeys(alice.wallet, bob.wallet, charlie.wallet);
    for (const [to, amount] of [[alice, (BOUNTIES + 1n) * REWARD], [bob, 3n * STAKE], [charlie, 3n * STAKE]] as const) {
      await (submitCallTx as any)(tokenProv, {
        compiledContract: CompiledTestTokenContract,
        contractAddress: tokenAddress,
        circuitId: 'mint',
        args: [amount, mintNonce(), recipientOf(to.wallet)],
        additionalCoinEncPublicKeyMappings: keys,
      });
      await syncWallet(logger, alice.wallet.wallet, 600_000);
    }
    await waitForShieldedBalance(alice.wallet, color, (BOUNTIES + 1n) * REWARD, { logger });
    await waitForShieldedBalance(bob.wallet, color, 3n * STAKE, { logger });
    await waitForShieldedBalance(charlie.wallet, color, 3n * STAKE, { logger });
  }, LONG);

  afterAll(async () => {
    for (const p of [alice, bob, charlie]) if (p) await p.wallet.stop().catch(() => undefined);
  });

  it('D4 setup: posts a short-deadline bounty; an early refund is rejected', async () => {
    // Long enough to cover D1 to D3, which run while this deadline passes.
    d4Deadline = nowSec() + 300;
    await post(D4, randomAnswer(), d4Deadline, 'D4 postBounty');
    await expect(call(alice, 'D4 early refund', 'refund', [D4])).rejects.toThrow(/Deadline has not passed/);
  }, LONG);

  it('D1: one-transaction submit pays the solver; the poster decrypts; nothing secret is public', async () => {
    const id = newId();
    const answer = randomAnswer();
    const { reward, key } = await post(id, answer, nowSec() + 3600, 'D1 postBounty');

    const bobBefore = await balance(bob);
    const stake = freshCoin(color, STAKE);
    await call(bob, 'D1 submit (bob)', 'submit', [id, stake], answer);
    const bobAfter = await waitForShieldedBalance(bob.wallet, color, bobBefore + REWARD, { logger });
    expect(bobAfter - bobBefore).toEqual(REWARD); // reward in, own coin back

    const l = await query();
    expect(l.bounties.lookup(id).status).toEqual(Status.SOLVED);
    expect(l.escrows.member(id)).toBe(false);
    const delivery = l.deliveries.lookup(id);
    expect(pure.decrypt(delivery, key, id)).toEqual(answer);

    const payout = (await shieldedCoins(bob.wallet, color)).find((c) => c.value === REWARD + STAKE);
    expect(payout).toBeDefined();
    const secrets: Record<string, Uint8Array> = {
      posterSk: alice.sk,
      solverSk: bob.sk,
      posterKey: fieldBytes(key),
      posterSeed,
      stakeNonce: stake.nonce,
      payoutNonce: payout!.nonce,
      solverCoinKey: encodeCoinPublicKey(bob.wallet.getCoinPublicKey()),
      posterCoinKey: encodeCoinPublicKey(alice.wallet.getCoinPublicKey()),
    };
    answer.forEach((m, i) => (secrets[`answer[${i}]`] = fieldBytes(m)));
    assertNotInPublicState(l, secrets);
    expect(Buffer.from(payout!.nonce).equals(Buffer.from(reward.nonce))).toBe(false);
  }, LONG);

  it('D2: a wrong answer is rejected before proving and changes nothing', async () => {
    const id = newId();
    const answer = randomAnswer();
    await post(id, answer, nowSec() + 3600, 'D2 postBounty');
    const wrong = [...answer];
    wrong[3] += 1n;
    await expect(call(bob, 'D2 wrong answer', 'submit', [id, freshCoin(color, STAKE)], wrong)).rejects.toThrow(/Wrong answer/);
    const l = await query();
    expect(l.bounties.lookup(id).status).toEqual(Status.OPEN);
    expect(l.deliveries.member(id)).toBe(false);
    expect(l.escrows.member(id)).toBe(true);
  }, LONG);

  it('D3: two solvers race; one is paid, the other keeps their coin', async () => {
    const id = newId();
    const answer = randomAnswer();
    await post(id, answer, nowSec() + 3600, 'D3 postBounty');
    const bobBefore = await balance(bob);
    const charlieBefore = await balance(charlie);

    const settled = await Promise.allSettled([
      call(bob, 'D3 submit (bob, race)', 'submit', [id, freshCoin(color, STAKE)], answer),
      call(charlie, 'D3 submit (charlie, race)', 'submit', [id, freshCoin(color, STAKE)], answer),
    ]);
    const winners = settled.flatMap((s, i) => (s.status === 'fulfilled' ? [i === 0 ? 'bob' : 'charlie'] : []));
    settled.forEach((s, i) => s.status === 'rejected' && logger.info(`D3 loser ${i === 0 ? 'bob' : 'charlie'}: ${errText(s.reason).slice(0, 300)}`));
    expect(winners).toHaveLength(1);

    const bobDelta = (await balance(bob)) - bobBefore;
    const charlieDelta = (await balance(charlie)) - charlieBefore;
    logger.info(`D3 winner ${winners[0]}: bob ${bobDelta}, charlie ${charlieDelta}`);
    expect(winners[0] === 'bob' ? [bobDelta, charlieDelta] : [charlieDelta, bobDelta]).toEqual([REWARD, 0n]);
    expect((await query()).bounties.lookup(id).status).toEqual(Status.SOLVED);
  }, LONG);

  it('D4: after the deadline a non-poster refund is rejected and the poster is refunded', async () => {
    const wait = (d4Deadline + 10 - nowSec()) * 1000;
    if (wait > 0) await sleep(wait);
    await expect(call(bob, 'D4 refund by non-poster', 'refund', [D4])).rejects.toThrow(/Only the poster can refund/);

    const aliceBefore = await balance(alice);
    await call(alice, 'D4 refund (poster)', 'refund', [D4]);
    const aliceAfter = await waitForShieldedBalance(alice.wallet, color, aliceBefore + REWARD, { logger });
    expect(aliceAfter - aliceBefore).toEqual(REWARD);
    expect((await query()).bounties.lookup(D4).status).toEqual(Status.REFUNDED);
  }, LONG);

  it('D5: a submit landing after the deadline is rejected whole; the solver keeps their coin', async () => {
    const id = newId();
    const answer = randomAnswer();
    // Long enough for the post to land (about 36 s here), short enough that a
    // proven submit (about 65 s) lands after it.
    await post(id, answer, nowSec() + 60, 'D5 postBounty');
    const bobBefore = await balance(bob);

    let outcome = 'accepted';
    try {
      await call(bob, 'D5 late submit', 'submit', [id, freshCoin(color, STAKE)], answer);
    } catch (e) {
      const msg = errText(e);
      outcome = /Deadline has passed/.test(msg) ? 'rejected before proving' : 'rejected by the node';
      logger.info(`D5: ${outcome}: ${msg.slice(0, 300)}`);
    }
    expect(outcome).not.toEqual('accepted');
    expect((await balance(bob)) - bobBefore).toEqual(0n);
    const l = await query();
    expect(l.bounties.lookup(id).status).toEqual(Status.OPEN);
    expect(l.deliveries.member(id)).toBe(false);
  }, LONG);
});
