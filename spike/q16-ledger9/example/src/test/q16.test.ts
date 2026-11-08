// Spike Q16: does the preimage bounty work on Ledger 9 (toolchain 0.36.0,
// Midnight.js 5, proof server 9.0.0)? Run on Preview:
//
//   Q16-1  post a bounty (the reward coin goes into escrow)
//   Q16-2  a solver submits: their fresh coin is merged with the escrow coin and
//          paid out in one transaction (Escrow_payMerged). Ledger 9 has an open
//          issue (midnight-ledger#839) for spending a held coin and writing change
//          back; this checks our merge-then-send isn't caught by it.
//   Q16-3  a short-deadline bounty is refunded to the poster (Escrow_payOut)
//
// Each call's wall time is logged, to compare with the Ledger 8 numbers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import type { ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';
import { WebSocket } from 'ws';

import { encryptionKeys, freshCoin, mintNonce, recipientOf, shieldedBalance, tokenColor, waitForShieldedBalance, type TokenColor } from './coins.js';
import { getConfig } from '../config.js';
import { MidnightWalletProvider, resolveWallet, syncWallet, waitForNightThenDust } from '../wallet.js';
import { buildProviders, ledgerState, type BountyProviders } from '../providers.js';
import {
  CompiledBountyPreimageContract,
  CompiledTestTokenContract,
  bountyPreimageLedger,
  bountyPreimagePureCircuits as pure,
  bountyPreimageZkConfigPath,
  testTokenZkConfigPath,
  Status,
} from '../../contract/index.js';
import { createBountyPrivateState, randomScalar, NO_ANSWER } from '../../contract/witnesses.js';
import { posterKeyFor } from '../../contract/keys.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });
const network = process.env['MIDNIGHT_NETWORK'] ?? 'local';
const config = getConfig();
const LONG = 60 * 60_000;
const REWARD = 100n;
const STAKE = 10n;
const nowSec = () => Math.floor(Date.now() / 1000);
const postedAt = () => BigInt(nowSec() - 60);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomAnswer = (): bigint[] => [randomScalar(), randomScalar(), randomScalar(), randomScalar()];
const timings: Record<string, number> = {};

type Party = { name: string; wallet: MidnightWalletProvider; prov: BountyProviders; psId: string; sk: Uint8Array };

describe(`Q16: preimage bounty on Ledger 9 (${network})`, () => {
  let alice: Party;
  let bob: Party;
  let tokenProv: BountyProviders;
  let tokenAddress: ContractAddress;
  let address: ContractAddress;
  let color: TokenColor;
  const posterSeed = new Uint8Array(randomBytes(32));

  async function query() {
    return bountyPreimageLedger(ledgerState(await alice.prov.publicDataProvider.queryContractState(address)));
  }

  async function call(p: Party, label: string, circuitId: string, args: unknown[], answer: bigint[] = NO_ANSWER) {
    await p.prov.privateStateProvider.forContract(address).set(p.psId, createBountyPrivateState(p.sk, answer));
    const t0 = Date.now();
    const tx = await (submitCallTx as any)(p.prov, { compiledContract: CompiledBountyPreimageContract, contractAddress: address, privateStateId: p.psId, circuitId, args });
    timings[label] = (Date.now() - t0) / 1000;
    logger.info(`${label}: ok in ${timings[label]}s`);
    return tx;
  }

  async function post(answer: bigint[], deadline: number, label: string) {
    const salt = new Uint8Array(randomBytes(32));
    const id = pure.bountyIdFor(salt, alice.sk);
    const key = await posterKeyFor(posterSeed, address, id);
    await call(alice, label, 'postBounty', [salt, freshCoin(color, REWARD), pure.posterPublicKey(key), pure.answerHash(answer), BigInt(deadline), 'Q16', 'Ledger 9 spike', postedAt()]);
    await syncWallet(logger, alice.wallet.wallet, 600_000);
    return { id, key };
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
      const setup = resolveWallet(network, role);
      const wallet = await MidnightWalletProvider.build(logger, env, setup.secret);
      await wallet.start();
      await syncWallet(logger, wallet.wallet, LONG);
      if (network !== 'local') await waitForNightThenDust(logger, wallet.wallet, wallet.unshieldedKeystore, env, config.faucet, { label: setup.role });
      return { name, wallet, prov: buildProviders(wallet, bountyPreimageZkConfigPath, config, `q16-${name}`), psId: `Q16${name}`, sk: new Uint8Array(randomBytes(32)) };
    };
    alice = await make('ALICE', 'alice');
    bob = await make('BOB', 'bob');
    tokenProv = buildProviders(alice.wallet, testTokenZkConfigPath, config, 'q16-token');

    let t0 = Date.now();
    const token = await (deployContract as any)(tokenProv, { compiledContract: CompiledTestTokenContract });
    timings['deploy token'] = (Date.now() - t0) / 1000;
    tokenAddress = token.deployTxData.public.contractAddress;
    color = tokenColor('bounty:test-token', tokenAddress);
    t0 = Date.now();
    const bounty = await (deployContract as any)(alice.prov, {
      compiledContract: CompiledBountyPreimageContract,
      privateStateId: alice.psId,
      initialPrivateState: createBountyPrivateState(alice.sk),
      args: [color.bytes, 1n, 0n],
    });
    timings['deploy bounty'] = (Date.now() - t0) / 1000;
    address = bounty.deployTxData.public.contractAddress;
    logger.info(`token ${tokenAddress}, bounty ${address}`);

    const keys = encryptionKeys(alice.wallet, bob.wallet);
    for (const [to, amount] of [[alice, 2n * REWARD], [bob, STAKE]] as const) {
      t0 = Date.now();
      await (submitCallTx as any)(tokenProv, { compiledContract: CompiledTestTokenContract, contractAddress: tokenAddress, circuitId: 'mint', args: [amount, mintNonce(), recipientOf(to.wallet)], additionalCoinEncPublicKeyMappings: keys });
      timings[`mint to ${to.name}`] = (Date.now() - t0) / 1000;
      await syncWallet(logger, alice.wallet.wallet, 600_000);
    }
    await waitForShieldedBalance(alice.wallet, color, 2n * REWARD, { logger, timeoutMs: 600_000 });
  }, LONG);

  afterAll(async () => {
    logger.info(`Q16 timings (s): ${JSON.stringify(timings)}`);
    for (const p of [alice, bob]) if (p) await p.wallet.stop().catch(() => undefined);
  });

  it('Q16-3 setup: posts a short-deadline bounty', async () => {
    (globalThis as any).refundBounty = { ...(await post(randomAnswer(), nowSec() + 240, 'post (refund bounty)')), deadline: nowSec() + 240 };
  }, LONG);

  it('Q16-1, Q16-2: post, then a submit merges the solver coin with the escrow and pays out', async () => {
    const answer = randomAnswer();
    const { id, key } = await post(answer, nowSec() + 3600, 'post');
    await syncWallet(logger, bob.wallet.wallet, 600_000);
    const before = await shieldedBalance(bob.wallet, color);
    await call(bob, 'submit (merged payout)', 'submit', [id, freshCoin(color, STAKE)], answer);
    const after = await waitForShieldedBalance(bob.wallet, color, before + REWARD, { logger, timeoutMs: 600_000 });
    expect(after - before).toEqual(REWARD);
    const l = await query();
    expect(l.bounties.lookup(id).status).toEqual(Status.SOLVED);
    expect(pure.decrypt(l.deliveries.lookup(id), key, id)).toEqual(answer);
  }, LONG);

  it('Q16-3: after the deadline the poster is refunded', async () => {
    const { id, deadline } = (globalThis as any).refundBounty as { id: Uint8Array; deadline: number };
    const wait = (deadline + 15 - nowSec()) * 1000;
    if (wait > 0) await sleep(wait);
    await syncWallet(logger, alice.wallet.wallet, 600_000);
    const before = await shieldedBalance(alice.wallet, color);
    await call(alice, 'refund', 'refund', [id]);
    const after = await waitForShieldedBalance(alice.wallet, color, before + REWARD, { logger, timeoutMs: 600_000 });
    expect(after - before).toEqual(REWARD);
    expect((await query()).bounties.lookup(id).status).toEqual(Status.REFUNDED);
  }, LONG);
});
