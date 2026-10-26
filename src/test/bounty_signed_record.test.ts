// Devnet test for the signed-record bounty: a solver holding an issuer-signed
// record above the threshold is paid in one transaction, the signature is
// verified in-circuit, and the poster decrypts the record from the chain. The
// escrow, race and refund behaviour is shared with bounty_preimage and tested
// there.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { type ContractAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  encryptionKeys,
  freshCoin,
  mintNonce,
  recipientOf,
  shieldedBalance,
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
  CompiledBountySignedRecordContract,
  CompiledTestTokenContract,
  bountySignedRecordLedger,
  bountySignedRecordPureCircuits as pure,
  bountySignedRecordZkConfigPath,
  testTokenZkConfigPath,
  Status,
} from '../../contract/index.js';
import {
  createBountyPrivateState,
  randomScalar,
  NO_ANSWER,
  NO_SIGNATURE,
  type SchnorrSignature,
} from '../../contract/witnesses.js';
import { signRecord } from '../../contract/signing.js';

globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });
const config = getConfig();
const LONG = 45 * 60_000;
const REWARD = 100n;
const STAKE = 10n;
const FIELD = 1n; // the record's second field holds the amount
const THRESHOLD = 3000n;

type Party = { name: string; wallet: MidnightWalletProvider; prov: BountyProviders; psId: string; sk: Uint8Array };

describe(`bounty_signed_record on ${config.networkId}`, () => {
  let alice: Party; // poster
  let bob: Party; // solver
  let address: ContractAddress;
  let color: TokenColor;
  const posterKey = randomScalar();
  const issuerSk = randomScalar();

  async function call(
    p: Party,
    label: string,
    circuitId: string,
    args: unknown[],
    answer: bigint[] = NO_ANSWER,
    signature: SchnorrSignature = NO_SIGNATURE,
  ) {
    await p.prov.privateStateProvider.set(p.psId, createBountyPrivateState(p.sk, answer, signature));
    const t0 = Date.now();
    const tx = await (submitCallTx as any)(p.prov, {
      compiledContract: CompiledBountySignedRecordContract,
      contractAddress: address,
      privateStateId: p.psId,
      circuitId,
      args,
    });
    logger.info(`${label}: ok in ${Math.round((Date.now() - t0) / 100) / 10}s (tx ${tx.public.txId.slice(0, 16)}…)`);
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
      const prov = buildProviders(wallet, bountySignedRecordZkConfigPath, config, `ps-${name}`);
      return { name, wallet, prov, psId: `PS${name}`, sk: new Uint8Array(randomBytes(32)) };
    };
    alice = await make('ALICE', 'alice');
    bob = await make('BOB', 'bob');
    const tokenProv = buildProviders(alice.wallet, testTokenZkConfigPath, config, 'ps-alice-token');

    const token = await (deployContract as any)(tokenProv, { compiledContract: CompiledTestTokenContract });
    const tokenAddress: ContractAddress = token.deployTxData.public.contractAddress;
    color = tokenColor('bounty:test-token', tokenAddress);
    const bounty = await (deployContract as any)(alice.prov, {
      compiledContract: CompiledBountySignedRecordContract,
      privateStateId: alice.psId,
      initialPrivateState: createBountyPrivateState(alice.sk),
      args: [color.bytes],
    });
    address = bounty.deployTxData.public.contractAddress;
    for (const p of [alice, bob]) p.prov.privateStateProvider.setContractAddress(address);

    const keys = encryptionKeys(alice.wallet, bob.wallet);
    for (const [to, amount] of [[alice, REWARD], [bob, STAKE]] as const) {
      await (submitCallTx as any)(tokenProv, {
        compiledContract: CompiledTestTokenContract,
        contractAddress: tokenAddress,
        circuitId: 'mint',
        args: [amount, mintNonce(), recipientOf(to.wallet)],
        additionalCoinEncPublicKeyMappings: keys,
      });
      await syncWallet(logger, alice.wallet.wallet, 600_000);
    }
    await waitForShieldedBalance(alice.wallet, color, REWARD, { logger });
    await waitForShieldedBalance(bob.wallet, color, STAKE, { logger });
  }, LONG);

  afterAll(async () => {
    for (const p of [alice, bob]) if (p) await p.wallet.stop().catch(() => undefined);
  });

  it('pays for an issuer-signed record above the threshold; the poster decrypts it', async () => {
    const id = new Uint8Array(randomBytes(32));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const issuerPk = pure.publicKey(issuerSk);
    await call(alice, 'post', 'postBounty', [
      id, freshCoin(color, REWARD), pure.publicKey(posterKey), issuerPk, FIELD, THRESHOLD, deadline,
    ]);
    // [subject, amount, issued at, nonce], signed by the issuer off-chain.
    const record = [randomScalar(), 5000n, BigInt(Math.floor(Date.now() / 1000)), randomScalar()];
    const signature = signRecord(issuerSk, record);

    await syncWallet(logger, bob.wallet.wallet, 600_000);
    const before = await shieldedBalance(bob.wallet, color);
    await call(bob, 'submit (bob)', 'submit', [id, freshCoin(color, STAKE)], record, signature);
    const after = await waitForShieldedBalance(bob.wallet, color, before + REWARD, { logger });
    expect(after - before).toEqual(REWARD);

    const s = await alice.prov.publicDataProvider.queryContractState(address);
    const l = bountySignedRecordLedger(s!.data);
    expect(l.bounties.lookup(id).status).toEqual(Status.SOLVED);
    expect(pure.decrypt(l.deliveries.lookup(id), posterKey, id)).toEqual(record);
  }, LONG);
});
