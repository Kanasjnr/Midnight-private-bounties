// Contract operations the UI calls. Each one is the browser counterpart of a
// step in the Node test (examples/private-bounties/src/test/bounty_preimage.test.ts);
// the only difference is where `providers` came from.
//
//  1. **Coin arguments.** The DApp Connector can't list a wallet's coins, and
//     doesn't need to: a `ShieldedCoinInfo` that a circuit receives describes
//     the output the transaction creates for the contract, so a fresh coin
//     (random nonce) works, and the wallet funds it while balancing. The
//     poster's reward is funded that way. The solver's coin is worth zero
//     (spike Q12), so the wallet adds nothing but fees.
//  2. **Who gets the payout.** `submit` and `refund` pay `ownPublicKey()`, the
//     caller's coin key. midnight-js encrypts an output to the wallet's own
//     coin key with the wallet's own encryption key, so the wallet finds it.
//  3. **Answers in private state.** The `answer` witness reads private state,
//     so `submitAnswer` writes the answer there just before the call and
//     clears it right after (audit S3), whether the call succeeded or not.
//
// Two contracts: the UI was generated for bounty_preimage (`./contract`, the
// template's providers). The test token is wired here, with its own
// CompiledContract and its own providers bundle from
// `useMidnightProviders().providersFor(TOKEN_ZK_ASSETS_PATH)`.
//
// Seed file: generated once by `yarn new:ui` from contract-info.json, then
// yours to edit. The drift check ignores it.
import {
  deployContract,
  findDeployedContract,
  submitCallTx,
  type FoundContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import {
  CompactTypeBytes,
  CompactTypeVector,
  encodeCoinPublicKey,
  encodeContractAddress,
  encodeRawTokenType,
  encodeShieldedCoinInfo,
  persistentHash,
  rawTokenType,
  type ContractAddress,
} from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";
import { createShieldedCoinInfo } from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { map, type Observable } from "rxjs";
import { Contract as TestTokenContractClass } from "../../../contract/managed/test_token/contract/index.js";
import { Status, type Delivery } from "../../../contract/managed/bounty_preimage/contract/index.js";
import { posterKeyFor } from "../../../contract/keys.js";
import { NO_ANSWER } from "../../../contract/witnesses.js";
import {
  CompiledPrivateBountiesContract,
  createInitialPrivateState,
  type PrivateBountiesPrivateState,
  PRIVATE_STATE_ID,
  pureCircuits,
  type Contract,
  ledger,
  type Ledger,
} from "./contract";
import type { ContractProviders, PrivateBountiesProviders } from "./providers";

export { Status, type Delivery };

/** 32 bytes from the browser's CSPRNG: secret keys, seeds, bounty ids, mint nonces. */
export function randomBytes32(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function pad32(label: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label));
  return out;
}

// --- the test token (second contract) ----------------------------------------

/** Where copy-zk.mjs serves the token's keys and zkir. */
export const TOKEN_ZK_ASSETS_PATH = "managed/test_token";

/** Every provable token circuit, i.e. every key set served for it. */
export type TokenCircuits = keyof TestTokenContractClass["provableCircuits"] & string;
export type TokenProviders = ContractProviders<TokenCircuits>;

/** Same construction as CompiledTestTokenContract in contract/index.ts. */
export const CompiledTestTokenContract = CompiledContract.make("TestTokenContract", TestTokenContractClass).pipe(
  CompiledContract.withVacantWitnesses,
  CompiledContract.withCompiledFileAssets(TOKEN_ZK_ASSETS_PATH),
);

/** test_token.compact's domain separator: pad(32, "bounty:test-token"). */
export const TOKEN_DOMAIN = pad32("bounty:test-token");

/** Deploy a test token. Anyone can mint it; it carries no value. */
export async function deployTestToken(providers: TokenProviders): Promise<ContractAddress> {
  const deployed = await deployContract(providers, { compiledContract: CompiledTestTokenContract });
  return deployed.deployTxData.public.contractAddress;
}

/**
 * The token's color: `tokenType(domain, tokenAddress)`, computed off chain as
 * in the Node test. Hex is how wallets key their balances; bytes are what the
 * bounty contract's constructor takes.
 */
export function tokenColor(tokenAddress: ContractAddress): { hex: string; bytes: Uint8Array } {
  const hex = rawTokenType(TOKEN_DOMAIN, tokenAddress);
  return { hex, bytes: encodeRawTokenType(hex) };
}

/**
 * Mint `amount` test tokens to the connected wallet. The nonce is fresh: the
 * same nonce would mint the same coin again. No encryption-key mapping is
 * needed for the wallet's own coin key (midnight-js adds it).
 */
export async function mintTestTokens(providers: TokenProviders, tokenAddress: ContractAddress, amount: bigint) {
  return submitCallTx(providers, {
    compiledContract: CompiledTestTokenContract,
    contractAddress: tokenAddress,
    circuitId: "mint",
    args: [amount, randomBytes32(), { bytes: encodeCoinPublicKey(providers.walletProvider.getCoinPublicKey()) }],
  });
}

/** A fresh coin of `value`, in circuit-argument form (random nonce). */
export function freshCoin(colorHex: string, value: bigint) {
  return encodeShieldedCoinInfo(createShieldedCoinInfo(colorHex, value));
}

// --- the bounty contract (the UI's own) ----------------------------------------

export type PrivateBountiesContract = FoundContract<Contract>;

/**
 * A new private state for this wallet account at one bounty contract: a fresh
 * identity secret (the poster's pseudonym is derived from it) and a fresh
 * poster seed (each bounty's encryption key is derived from it, keys.ts).
 * Both live only in this browser's encrypted store.
 */
export function newPrivateState(): PrivateBountiesPrivateState {
  return { ...createInitialPrivateState(randomBytes32()), posterSeed: randomBytes32() };
}

/** Deploy a bounty contract whose rewards are paid in the token of `colorBytes`. */
export async function deployPrivateBounties(
  providers: PrivateBountiesProviders,
  colorBytes: Uint8Array,
): Promise<{ contract: PrivateBountiesContract; address: ContractAddress }> {
  const deployed = await deployContract(providers, {
    compiledContract: CompiledPrivateBountiesContract,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: newPrivateState(),
    args: [colorBytes],
  });
  return {
    contract: deployed,
    address: deployed.deployTxData.public.contractAddress,
  };
}

/**
 * Attach to an existing deployment by address. findDeployedContract fetches
 * the on-chain state and checks that its verifier keys match the ones we serve
 * (a wrong address or a different contract fails here, before any tx).
 *
 * Private state: findDeployedContract *overwrites* whatever is stored under
 * PRIVATE_STATE_ID whenever it is given an `initialPrivateState`. So reuse the
 * stored state when there is one (a reload, or the deployer re-joining with a
 * persistent store) and only create a new one otherwise.
 */
export async function joinPrivateBounties(
  providers: PrivateBountiesProviders,
  address: ContractAddress,
): Promise<PrivateBountiesContract> {
  providers.privateStateProvider.setContractAddress(address);
  const stored = await providers.privateStateProvider.get(PRIVATE_STATE_ID);
  if (stored !== null) {
    return findDeployedContract(providers, {
      compiledContract: CompiledPrivateBountiesContract,
      contractAddress: address,
      privateStateId: PRIVATE_STATE_ID,
    });
  }
  return findDeployedContract(providers, {
    compiledContract: CompiledPrivateBountiesContract,
    contractAddress: address,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: newPrivateState(),
  });
}

/** This browser's private state for the contract at `address`, if any. */
export async function readPrivateState(
  providers: PrivateBountiesProviders,
  address: ContractAddress,
): Promise<PrivateBountiesPrivateState | null> {
  providers.privateStateProvider.setContractAddress(address);
  return providers.privateStateProvider.get(PRIVATE_STATE_ID);
}

async function writePrivateState(
  providers: PrivateBountiesProviders,
  address: ContractAddress,
  state: PrivateBountiesPrivateState,
): Promise<void> {
  providers.privateStateProvider.setContractAddress(address);
  await providers.privateStateProvider.set(PRIVATE_STATE_ID, state);
}

/**
 * A circuit's arguments without its leading CircuitContext, i.e. what
 * `contract.callTx.<circuit>(...)` takes. Not `Parameters<callTx[c]>`: callTx
 * members are overloaded, and `Parameters` picks the last overload, whose
 * first parameter is a TransactionContext.
 */
export type CircuitArgs<K extends keyof Contract["provableCircuits"]> =
  Parameters<Contract["provableCircuits"][K]> extends [unknown, ...infer A] ? A : never;

/** Circuit `postBounty(id, reward, posterPk, target, deadline, title, details)`. */
export async function postBounty(
  contract: PrivateBountiesContract,
  ...args: CircuitArgs<"postBounty">
) {
  return contract.callTx.postBounty(...args);
}

/** Circuit `submit(id, stake)`. */
export async function submit(
  contract: PrivateBountiesContract,
  ...args: CircuitArgs<"submit">
) {
  return contract.callTx.submit(...args);
}

/** Circuit `refund(id)`. */
export async function refund(
  contract: PrivateBountiesContract,
  ...args: CircuitArgs<"refund">
) {
  return contract.callTx.refund(...args);
}

/** Longest title and question the page accepts. The contract sets no limit; every character is public and paid for. */
export const TITLE_MAX = 80;
export const DETAILS_MAX = 1000;

/** Why a title and question can't be posted, or null. Both are trimmed first. */
export function listingError(title: string, details: string): string | null {
  const t = title.trim();
  const d = details.trim();
  if (t === "") return "Give the bounty a title";
  if ([...t].length > TITLE_MAX) return `Title is over ${TITLE_MAX} characters`;
  if (d === "") return "Write the question";
  if ([...d].length > DETAILS_MAX) return `Question is over ${DETAILS_MAX} characters`;
  return null;
}

/** What a poster fills in. `deadline` is in seconds since the Unix epoch (block time). */
export interface NewBounty {
  /** Public, shown on the board. */
  title: string;
  /** Public: the question the answer must solve. */
  details: string;
  answer: string;
  reward: bigint;
  deadline: bigint;
  colorHex: string;
}

/**
 * Post a bounty: escrow a fresh reward coin (the wallet funds it from the
 * tokens it holds), publish the answer's hash, and the poster's encryption
 * key for this bounty. The answer itself is never stored or sent.
 */
export async function postNewBounty(
  contract: PrivateBountiesContract,
  providers: PrivateBountiesProviders,
  address: ContractAddress,
  input: NewBounty,
) {
  const invalid = listingError(input.title, input.details);
  if (invalid) throw new Error(invalid);
  const ps = await readPrivateState(providers, address);
  if (!ps?.posterSeed) throw new Error("This browser has no poster seed for this contract: rejoin it first.");
  const answer = encodeAnswer(input.answer);
  const id = randomBytes32();
  const key = await posterKeyFor(ps.posterSeed, address, id);
  const tx = await postBounty(
    contract,
    id,
    freshCoin(input.colorHex, input.reward),
    pureCircuits.posterPublicKey(key),
    pureCircuits.answerHash(answer),
    input.deadline,
    input.title.trim(),
    input.details.trim(),
  );
  return { id, tx };
}

/**
 * Solve a bounty: one transaction that checks the answer, stores it encrypted
 * to the poster, and pays the reward to this wallet. The solver's coin is
 * worth zero, so they need no reward tokens, only DUST for fees.
 */
export async function submitAnswer(
  contract: PrivateBountiesContract,
  providers: PrivateBountiesProviders,
  address: ContractAddress,
  id: Uint8Array,
  answerText: string,
  colorHex: string,
) {
  const answer = encodeAnswer(answerText);
  const base = await readPrivateState(providers, address);
  if (!base) throw new Error("No private state for this contract: rejoin it first.");
  await writePrivateState(providers, address, { ...base, answer });
  try {
    return await submit(contract, id, freshCoin(colorHex, 0n));
  } finally {
    await writePrivateState(providers, address, { ...base, answer: NO_ANSWER });
  }
}

/** Decrypt a solved bounty's delivery with this bounty's poster key. */
export async function readAnswer(
  state: Ledger,
  address: ContractAddress,
  id: Uint8Array,
  posterSeed: Uint8Array,
): Promise<string> {
  const key = await posterKeyFor(posterSeed, address, id);
  return decodeAnswer(pureCircuits.decrypt(state.deliveries.lookup(id), key, id));
}

/**
 * Live view of the public ledger. The indexer pushes each new contract state
 * over its websocket, and the compiler-generated `ledger()` decodes it.
 */
export function ledger$(
  providers: PrivateBountiesProviders,
  address: ContractAddress,
): Observable<Ledger> {
  return providers.publicDataProvider
    .contractStateObservable(address, { type: "latest" })
    .pipe(map((state) => ledger(state.data)));
}

// --- pure helpers (tested against the circuits) ---------------------------------

/** An answer is four field elements of 31 bytes each. */
export const ANSWER_BYTES = 124;

/**
 * Text to the four field elements the circuit hashes: its UTF-8 bytes, after
 * trimming surrounding whitespace, zero-padded to 124 bytes, 31 bytes per
 * element (big-endian), so every element is below 2^248.
 */
export function encodeAnswer(text: string): bigint[] {
  const bytes = new TextEncoder().encode(text.trim());
  if (bytes.length === 0) throw new Error("The answer is empty.");
  if (bytes.length > ANSWER_BYTES) {
    throw new Error(`The answer is ${bytes.length} bytes; at most ${ANSWER_BYTES} fit.`);
  }
  const padded = new Uint8Array(ANSWER_BYTES);
  padded.set(bytes);
  return [0, 1, 2, 3].map((i) =>
    padded.slice(i * 31, i * 31 + 31).reduce((acc, b) => (acc << 8n) | BigInt(b), 0n),
  );
}

/** The inverse of encodeAnswer. Throws when the elements aren't an encoded answer. */
export function decodeAnswer(m: bigint[]): string {
  if (m.length !== 4) throw new Error("An answer has four elements.");
  const out = new Uint8Array(ANSWER_BYTES);
  m.forEach((x, i) => {
    if (x < 0n || x >> 248n !== 0n) throw new Error("Not an encoded answer.");
    for (let j = 30; j >= 0; j--) {
      out[i * 31 + j] = Number(x & 0xffn);
      x >>= 8n;
    }
  });
  let end = out.length;
  while (end > 0 && out[end - 1] === 0) end--;
  return new TextDecoder("utf-8", { fatal: true }).decode(out.slice(0, end));
}

const PSEUDONYM_TYPE = new CompactTypeVector(4, new CompactTypeBytes(32));
const PSEUDONYM_DOMAIN = pad32("bounty:poster");

/** pseudonym.compact's `derive`: the `poster` value a bounty stores. */
export function posterPseudonym(address: ContractAddress, id: Uint8Array, sk: Uint8Array): Uint8Array {
  return persistentHash(PSEUDONYM_TYPE, [PSEUDONYM_DOMAIN, encodeContractAddress(address), id, sk]);
}

/** One row of the bounty board. */
export interface BountyView {
  id: Uint8Array;
  idHex: string;
  title: string;
  details: string;
  status: Status;
  /** Seconds since the Unix epoch. */
  deadline: bigint;
  target: bigint;
  /** The escrowed reward while the bounty is open; null once paid out. */
  reward: bigint | null;
  /** Posted from this browser's identity secret. */
  mine: boolean;
}

/** Every bounty on the ledger, newest deadline first. */
export function bountyViews(
  state: Ledger,
  address: ContractAddress,
  ps: PrivateBountiesPrivateState | null,
): BountyView[] {
  const rows: BountyView[] = [];
  for (const [id, b] of state.bounties) {
    const listing = state.listings.member(id) ? state.listings.lookup(id) : null;
    rows.push({
      id,
      idHex: toHex(id),
      title: listing?.title ?? "",
      details: listing?.details ?? "",
      status: b.status,
      deadline: b.deadline,
      target: b.target,
      reward: state.escrows.member(id) ? state.escrows.lookup(id).value : null,
      mine: ps !== null && sameBytes(posterPseudonym(address, id, ps.sk), b.poster),
    });
  }
  return rows.sort((a, b) => (a.deadline === b.deadline ? 0 : a.deadline > b.deadline ? -1 : 1));
}

export type Action = "submit" | "refund" | "decrypt";

/**
 * Why `action` would fail right now, mirroring the circuit's asserts in
 * order; null when it would pass. `now` is in seconds: wall-clock time
 * stands in for block time, so a call right at the deadline can still go
 * either way on chain.
 */
export function actionError(
  action: Action,
  state: Ledger,
  view: BountyView,
  now: bigint,
  answerText?: string,
): string | null {
  if (!state.bounties.member(view.id)) return "No such bounty";
  if (action === "decrypt") {
    if (!view.mine) return "Only the poster can decrypt";
    return state.deliveries.member(view.id) ? null : "Nothing delivered yet";
  }
  if (view.status !== Status.OPEN) return "Bounty is closed";
  if (action === "refund") {
    if (!view.mine) return "Only the poster can refund";
    return now < view.deadline ? "Deadline has not passed" : null;
  }
  if (now >= view.deadline) return "Deadline has passed";
  let answer: bigint[];
  try {
    answer = encodeAnswer(answerText ?? "");
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  return pureCircuits.checkAnswer(answer, view.target) ? null : "Wrong answer";
}

/** A token amount typed by the user: a positive whole number below 2^64, or null. */
export function parseAmount(text: string): bigint | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const v = BigInt(text.trim());
  return v > 0n && v < 2n ** 64n ? v : null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
