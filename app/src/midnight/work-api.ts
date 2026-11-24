// Contract operations for reviewed work (contract/bounty_reviewed_work.compact),
// the browser side of src/test/bounty_reviewed_work.test.ts. The wiring is
// the same as ../ui's api file for the preimage template: fresh coins as
// circuit arguments, the poster's key derived per bounty from the poster seed
// (contract/keys.ts), and the submission written to private state just
// before `submit` and cleared right after.
import {
  deployContract,
  findDeployedContract,
  type FoundContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/v9/compact-js";
import {
  CompactTypeBytes,
  CompactTypeVector,
  encodeContractAddress,
  persistentHash,
  type ContractAddress,
} from "@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { map, type Observable } from "rxjs";
import {
  Contract,
  ledger,
  pureCircuits,
  Status,
  type Ledger,
  type Terms,
  type Work,
} from "../../../contract/managed/bounty_reviewed_work/contract/index.js";
import { posterKeyFor } from "../../../contract/keys.js";
import { NO_ANSWER, randomScalar, witnesses } from "../../../contract/witnesses.js";
import { PRIVATE_STATE_ID, type PrivateBountiesPrivateState } from "@/midnight/contract";
import { contractStateData, type ContractProviders } from "@/midnight/providers";
import {
  decodeAnswer,
  encodeAnswer,
  freshCoin,
  listingError,
  MIN_REWARD,
  MIN_WINDOW,
  newPrivateState,
  posterPseudonym,
  postTime,
  randomBytes32,
} from "@/midnight/private-bounties-api";

export { Status as WorkStatus, pureCircuits as workCircuits, ledger as workLedger, type Ledger as WorkLedger, type Terms, type Work };

/** Where copy-zk.mjs serves this contract's keys and zkir. */
export const WORK_ZK_ASSETS_PATH = "managed/bounty_reviewed_work";

export type WorkCircuits = keyof Contract["provableCircuits"] & string;
export type WorkProviders = ContractProviders<WorkCircuits>;
export type WorkContract = FoundContract<Contract<PrivateBountiesPrivateState>>;

export const CompiledWorkContract = CompiledContract.make("BountyReviewedWorkContract", Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(WORK_ZK_ASSETS_PATH),
);

/**
 * How long a call has to land after its window end was picked: 15 minutes,
 * which held on a devnet (ARCHITECTURE.md section 5). Calls took 24 to 67 s.
 */
export const SLACK = 15n * 60n;
/** How long approved or unreviewed work stays collectable after its review-by. */
export const COLLECT_WINDOW = 90n * 86_400n;
/** The contract's cap on every window. */
export const MAX_WINDOW = 365n * 86_400n;

export async function deployWork(
  providers: WorkProviders,
  colorBytes: Uint8Array,
): Promise<{ contract: WorkContract; address: ContractAddress }> {
  const deployed = await deployContract(providers, {
    compiledContract: CompiledWorkContract,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: newPrivateState(),
    args: [colorBytes, MIN_REWARD, MIN_WINDOW, SLACK, COLLECT_WINDOW],
  });
  return { contract: deployed as unknown as WorkContract, address: deployed.deployTxData.public.contractAddress };
}

/** Join by address, reusing this browser's private state for it when there is one (as joinPrivateBounties does). */
export async function joinWork(providers: WorkProviders, address: ContractAddress): Promise<WorkContract> {
  const stored = await providers.privateStateProvider.forContract(address).get(PRIVATE_STATE_ID);
  const found = await findDeployedContract(providers, {
    compiledContract: CompiledWorkContract,
    contractAddress: address,
    privateStateId: PRIVATE_STATE_ID,
    ...(stored === null ? { initialPrivateState: newPrivateState() } : {}),
  });
  return found as unknown as WorkContract;
}

export async function readWorkState(providers: WorkProviders, address: ContractAddress): Promise<PrivateBountiesPrivateState | null> {
  return providers.privateStateProvider.forContract(address).get(PRIVATE_STATE_ID);
}

export function work$(providers: WorkProviders, address: ContractAddress): Observable<Ledger> {
  return providers.publicDataProvider.contractStateObservable(address, { type: "latest" }).pipe(map(({ value }) => ledger(contractStateData(value))));
}

const PSEUDONYM_TYPE = new CompactTypeVector(4, new CompactTypeBytes(32));

function pad32(label: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode(label));
  return out;
}

/** The contributor's per-bounty pseudonym, as `claim` stores it and as an applicant sends it. */
export function contributorPseudonym(address: ContractAddress, id: Uint8Array, sk: Uint8Array): Uint8Array {
  return persistentHash(PSEUDONYM_TYPE, [pad32("bounty:contributor"), encodeContractAddress(address), id, sk]);
}

/**
 * A window end to pass for a window starting now: a minute short of
 * now + window, so a block clock up to a minute behind still accepts it. The
 * contract accepts anything from now + window − SLACK to now + window.
 */
export function windowEnd(window: bigint, now: bigint): bigint {
  return now + window - 60n;
}

// ---- reading the board ----

export interface WorkView {
  id: Uint8Array;
  idHex: string;
  title: string;
  details: string;
  status: Status;
  terms: Terms;
  /** ASSIGNED: deliver by; SUBMITTED and APPROVED: review by; REJECTED: appeal by. */
  until: bigint;
  reward: bigint | null;
  postedAt: bigint | null;
  /** Posted from this browser's identity secret. */
  mine: boolean;
  /** Assigned to this browser's identity secret. */
  assignedToMe: boolean;
  /** This browser's secret is the bounty's arbiter. */
  arbiterMe: boolean;
}

export function workViews(state: Ledger, address: ContractAddress, ps: PrivateBountiesPrivateState | null): WorkView[] {
  const rows: WorkView[] = [];
  const myArbiterId = ps ? pureCircuits.arbiterId(ps.sk) : null;
  for (const [id, w] of state.works) {
    const listing = state.listings.member(id) ? state.listings.lookup(id) : null;
    rows.push({
      id,
      idHex: toHex(id),
      title: listing?.title ?? "",
      details: listing?.details ?? "",
      status: w.status,
      terms: w.terms,
      until: w.until,
      reward: listing?.reward ?? null,
      postedAt: listing?.postedAt ?? null,
      mine: ps !== null && same(posterPseudonym(address, id, ps.sk), w.poster),
      assignedToMe: ps !== null && w.status !== Status.OPEN && same(contributorPseudonym(address, id, ps.sk), w.contributor),
      arbiterMe: myArbiterId !== null && w.terms.hasArbiter && same(myArbiterId, w.terms.arbiter),
    });
  }
  return rows;
}

export type WorkAction = "claim" | "assign" | "release" | "submit" | "approve" | "reject" | "overturn" | "reopen" | "collect" | "refund";

/**
 * Why `action` would fail right now, mirroring the circuit's asserts in
 * order; null when it would pass. `now` stands in for block time, so a call
 * right at a window's edge can still go either way on chain.
 */
export function workActionError(action: WorkAction, state: Ledger, v: WorkView, now: bigint): string | null {
  const t = v.terms;
  const collectBy = v.until + state.collectWindow;
  switch (action) {
    case "claim":
      if (!t.firstToClaim) return "The poster assigns this work";
      if (v.status !== Status.OPEN) return "Not open";
      if (windowEnd(t.deliveryWindow, now) > t.deadline) return "Claims have closed: a full delivery window no longer fits before the deadline";
      return null;
    case "assign":
      if (t.firstToClaim) return "This work is first to claim";
      if (!v.mine) return "Only the poster can assign";
      if (v.status !== Status.OPEN) return "Not open";
      if (windowEnd(t.deliveryWindow, now) > t.deadline) return "A full delivery window no longer fits before the deadline";
      return null;
    case "release":
      if (!t.firstToClaim) return "Only first-to-claim work can be released";
      if (!v.mine) return "Only the poster can release";
      return v.status === Status.ASSIGNED ? null : "Nothing to release";
    case "submit":
      if (v.status !== Status.ASSIGNED) return "Not assigned";
      if (!v.assignedToMe) return "Only the assigned contributor can submit";
      return now < v.until ? null : "The delivery window has passed";
    case "approve":
      if (!v.mine) return "Only the poster can approve";
      return v.status === Status.SUBMITTED ? null : "Nothing to approve";
    case "reject":
      if (!v.mine) return "Only the poster can reject";
      if (v.status !== Status.SUBMITTED) return "Nothing to reject";
      return now < v.until ? null : "The review window has passed";
    case "overturn":
      if (!v.arbiterMe) return "Only the arbiter can overturn";
      if (v.status !== Status.REJECTED) return "Nothing to overturn";
      return now < v.until ? null : "The appeal window has passed";
    case "reopen":
      if (v.status !== Status.ASSIGNED && v.status !== Status.REJECTED) return "Nothing to reopen";
      return now >= v.until ? null : "Its window hasn't run out";
    case "collect":
      if (!v.assignedToMe) return "Only the contributor can collect";
      if (!(v.status === Status.APPROVED || (v.status === Status.SUBMITTED && now >= v.until))) return "Not approved, and the review window is still open";
      return now < collectBy ? null : "Past the collect-by time";
    case "refund": {
      if (!v.mine) return "Only the poster can refund";
      if (v.status === Status.SUBMITTED || v.status === Status.APPROVED) return now >= collectBy ? null : "Still collectable";
      if (now < t.deadline) return "The deadline hasn't passed";
      const ok = v.status === Status.OPEN || v.status === Status.ASSIGNED || (v.status === Status.REJECTED && now >= v.until);
      return ok ? null : "Not refundable";
    }
  }
}

// ---- posting ----

export interface NewWork {
  title: string;
  details: string;
  reward: bigint;
  colorHex: string;
  firstToClaim: boolean;
  deliveryWindow: bigint;
  reviewWindow: bigint;
  deadline: bigint;
  /** An arbiter's id (arbiterId), or null for none. */
  arbiter: Uint8Array | null;
  appealWindow: bigint;
  postedAt?: bigint;
}

/** Why these terms can't be posted, or null. Mirrors postWork's asserts, after the listing check. */
export function termsError(state: Ledger, w: NewWork, now: bigint): string | null {
  const text = listingError(w.title, w.details);
  if (text) return text;
  const postedAt = w.postedAt ?? postTime(Number(now) * 1000);
  if (w.deadline <= now) return "The deadline has to be in the future";
  if (w.deadline < postedAt + state.minWindow) return "Deadline is too soon";
  if (w.deliveryWindow <= 0n || w.reviewWindow <= 0n) return "Windows must be positive";
  if (w.arbiter && w.appealWindow <= 0n) return "An arbiter needs an appeal window";
  if ([w.deliveryWindow, w.reviewWindow, w.appealWindow].some((x) => x > MAX_WINDOW)) return "Windows can be a year at most";
  if (windowEnd(w.deliveryWindow, now) > w.deadline) return "The delivery window doesn't fit before the deadline";
  if (w.reward <= 0n) return "Reward has no value";
  if (w.reward < state.minReward) return "Reward is below the minimum";
  return null;
}

export async function postWork(contract: WorkContract, providers: WorkProviders, address: ContractAddress, w: NewWork) {
  const ps = await readWorkState(providers, address);
  if (!ps?.posterSeed) throw new Error("This browser has no poster seed for this contract: rejoin it first.");
  const salt = randomBytes32();
  const id = pureCircuits.bountyIdFor(salt, ps.sk);
  const key = await posterKeyFor(ps.posterSeed, address, id);
  const terms: Terms = {
    firstToClaim: w.firstToClaim,
    deliveryWindow: w.deliveryWindow,
    reviewWindow: w.reviewWindow,
    appealWindow: w.arbiter ? w.appealWindow : 0n,
    deadline: w.deadline,
    hasArbiter: w.arbiter !== null,
    arbiter: w.arbiter ?? new Uint8Array(32),
  };
  const tx = await contract.callTx.postWork(
    salt,
    freshCoin(w.colorHex, w.reward),
    pureCircuits.posterPublicKey(key),
    terms,
    w.title.trim(),
    w.details.trim(),
    w.postedAt ?? postTime(),
  );
  return { id, tx };
}

// ---- the other calls ----

export const claim = (c: WorkContract, v: WorkView, now: bigint) => c.callTx.claim(v.id, windowEnd(v.terms.deliveryWindow, now));
export const assign = (c: WorkContract, v: WorkView, pseudonym: Uint8Array, now: bigint) =>
  c.callTx.assign(v.id, pseudonym, windowEnd(v.terms.deliveryWindow, now));
export const release = (c: WorkContract, v: WorkView) => c.callTx.release(v.id);
export const approve = (c: WorkContract, v: WorkView) => c.callTx.approve(v.id);
/** With an arbiter, the appeal window starts now; without one, the work reopens and the argument is unused. */
export const reject = (c: WorkContract, v: WorkView, now: bigint) =>
  c.callTx.reject(v.id, v.terms.hasArbiter ? windowEnd(v.terms.appealWindow, now) : 0n);
export const overturn = (c: WorkContract, v: WorkView) => c.callTx.overturn(v.id);
export const reopen = (c: WorkContract, v: WorkView) => c.callTx.reopen(v.id);
/** The contributor's coin is worth zero: they need no reward tokens, only DUST. */
export const collect = (c: WorkContract, v: WorkView, colorHex: string) => c.callTx.collect(v.id, freshCoin(colorHex, 0n));
export const refundWork = (c: WorkContract, v: WorkView) => c.callTx.refund(v.id);

/** Submit a link (up to 124 bytes), encrypted to the poster. The review window starts now. */
export async function submitWork(contract: WorkContract, providers: WorkProviders, address: ContractAddress, v: WorkView, link: string, now: bigint) {
  const answer = encodeAnswer(link);
  const base = await readWorkState(providers, address);
  if (!base) throw new Error("No private state for this contract: rejoin it first.");
  await providers.privateStateProvider.forContract(address).set(PRIVATE_STATE_ID, { ...base, answer });
  try {
    return await contract.callTx.submit(v.id, windowEnd(v.terms.reviewWindow, now));
  } finally {
    await providers.privateStateProvider.forContract(address).set(PRIVATE_STATE_ID, { ...base, answer: NO_ANSWER });
  }
}

/** The poster's key for one bounty, checked against the key it was posted with. */
export async function checkedPosterKey(state: Ledger, address: ContractAddress, id: Uint8Array, posterSeed: Uint8Array): Promise<bigint> {
  const key = await posterKeyFor(posterSeed, address, id);
  const mine = pureCircuits.posterPublicKey(key);
  const posted = state.works.lookup(id).posterPk;
  if (mine.x !== posted.x || mine.y !== posted.y) {
    throw new Error("This browser's key doesn't match the bounty's: it was posted from another seed");
  }
  return key;
}

/** The poster decrypts the submitted link. */
export async function readSubmission(state: Ledger, address: ContractAddress, id: Uint8Array, posterSeed: Uint8Array): Promise<string> {
  const key = await checkedPosterKey(state, address, id, posterSeed);
  return decodeAnswer(pureCircuits.decrypt(state.submissions.lookup(id), key, id));
}

// ---- application codes (ARCHITECTURE.md section 5, "Applications") ----

/** What an applicant tells the poster. Only the poster can read it. */
export interface Application {
  /** The applicant's per-bounty pseudonym, which the poster assigns. */
  pseudonym: Uint8Array;
  plan: string;
  name: string;
  links: string[];
}

export const PLAN_MAX = 2000;
const CODE_PREFIX = "pbapp1.";

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** A copy backed by a plain ArrayBuffer, which WebCrypto's types ask for. */
const buf = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);

function fieldBytes(x: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((x >> BigInt(8 * i)) & 0xffn);
  return b;
}

/** AES-GCM key from the shared field element: SHA-256 over a label and its bytes. */
async function aesKey(shared: bigint, usage: KeyUsage): Promise<CryptoKey> {
  const label = new TextEncoder().encode("pb:application-aes");
  const material = new Uint8Array(label.length + 32);
  material.set(label);
  material.set(fieldBytes(shared), label.length);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [usage]);
}

const hexToBig = (h: string) => BigInt(`0x${h}`);
const bigToHex = (x: bigint) => x.toString(16);

/**
 * An application code for one bounty: the application encrypted to the
 * poster's key for it, under the key `e` (fresh by default; the chat passes
 * the applicant's per-bounty contact key, so the code also opens the chat). The bounty ID is bound in
 * both the key and the AES associated data, so a code can't be replayed on
 * another bounty.
 */
export async function makeApplication(v: WorkView, posterPk: { x: bigint; y: bigint }, app: Application, e: bigint = randomScalar()): Promise<string> {
  const ePk = pureCircuits.posterPublicKey(e);
  const key = await aesKey(pureCircuits.applicationKey(e, posterPk, v.id), "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new TextEncoder().encode(
    JSON.stringify({ p: toHex(app.pseudonym), plan: app.plan.trim(), name: app.name.trim(), links: app.links.map((l) => l.trim()).filter(Boolean) }),
  );
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: buf(v.id) }, key, body));
  const head = JSON.stringify({ b: v.idHex, x: bigToHex(ePk.x), y: bigToHex(ePk.y) });
  return `${CODE_PREFIX}${b64url(new TextEncoder().encode(head))}.${b64url(iv)}.${b64url(ct)}`;
}

/** An opened application, with the applicant's public key from the code (the other end of the chat). */
export interface OpenedApplication extends Application {
  contact: { x: bigint; y: bigint };
}

/** The poster opens an application code for one of their bounties. Throws with a readable reason. */
export async function openApplication(state: Ledger, address: ContractAddress, v: WorkView, posterSeed: Uint8Array, code: string): Promise<OpenedApplication> {
  const parts = code.trim().replace(/\s+/g, "").split(".");
  if (parts.length !== 4 || `${parts[0]}.` !== CODE_PREFIX) throw new Error("That isn't an application code");
  let head: { b?: unknown; x?: unknown; y?: unknown };
  try {
    head = JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as typeof head;
  } catch {
    throw new Error("That application code is damaged");
  }
  if (head.b !== v.idHex) throw new Error("This code is for another bounty");
  if (typeof head.x !== "string" || typeof head.y !== "string" || !/^[0-9a-f]+$/.test(head.x + head.y)) throw new Error("That application code is damaged");
  const key = await checkedPosterKey(state, address, v.id, posterSeed);
  let plain: ArrayBuffer;
  try {
    const shared = pureCircuits.applicationKey(key, { x: hexToBig(head.x), y: hexToBig(head.y) }, v.id);
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromB64url(parts[2]!)), additionalData: buf(v.id) }, await aesKey(shared, "decrypt"), buf(fromB64url(parts[3]!)));
  } catch {
    throw new Error("This code wasn't made for your key, or it was changed");
  }
  const body = JSON.parse(new TextDecoder().decode(plain)) as { p?: unknown; plan?: unknown; name?: unknown; links?: unknown };
  if (typeof body.p !== "string" || !/^[0-9a-f]{64}$/.test(body.p)) throw new Error("That application has no valid pseudonym");
  return {
    pseudonym: Uint8Array.from(body.p.match(/../g)!, (h) => parseInt(h, 16)),
    plan: typeof body.plan === "string" ? body.plan : "",
    name: typeof body.name === "string" ? body.name : "",
    links: Array.isArray(body.links) ? body.links.filter((l): l is string => typeof l === "string") : [],
    contact: { x: hexToBig(head.x), y: hexToBig(head.y) },
  };
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
