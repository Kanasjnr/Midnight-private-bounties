// The factor and signed-record templates (contract/bounty_factor.compact,
// contract/bounty_signed_record.compact). They work like the preimage one in
// ../ui's api file, with their own checker parameters and answers:
//
//   factor         N on chain; the answer is two factors [p, q, 0, 0], p < 2^64.
//   signed record  an issuer's key, a record type, a field and a threshold on
//                  chain; the answer is a record [type, f1, f2, f3] the issuer
//                  signed, and the signature is a second private input.
//
// Record types are an app convention: a type's name, as UTF-8, is the
// record's first element, and each type names its three fields. The contract
// only compares the first element with the bounty's.
import { deployContract, findDeployedContract, type FoundContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import type { ContractAddress } from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { map, type Observable } from "rxjs";
import * as Factor from "../../../contract/managed/bounty_factor/contract/index.js";
import * as Signed from "../../../contract/managed/bounty_signed_record/contract/index.js";
import { posterKeyFor } from "../../../contract/keys.js";
import { signRecord } from "../../../contract/signing.js";
import { NO_ANSWER, NO_SIGNATURE, randomScalar, witnesses, type SchnorrSignature } from "../../../contract/witnesses.js";
import { PRIVATE_STATE_ID, type PrivateBountiesPrivateState } from "@/midnight/contract";
import type { ContractProviders } from "@/midnight/providers";
import {
  freshCoin,
  listingError,
  MIN_REWARD,
  MIN_WINDOW,
  newPrivateState,
  posterPseudonym,
  postTime,
  randomBytes32,
  Status,
} from "@/midnight/private-bounties-api";

export type Template = "factor" | "signed";
type FactorContract = Factor.Contract<PrivateBountiesPrivateState>;
type SignedContract = Signed.Contract<PrivateBountiesPrivateState>;
export type TemplateCircuits = (keyof FactorContract["provableCircuits"] | keyof SignedContract["provableCircuits"]) & string;
export type TemplateProviders = ContractProviders<TemplateCircuits>;
export type TemplateContract = FoundContract<FactorContract> | FoundContract<SignedContract>;
export type TemplateLedger = Factor.Ledger | Signed.Ledger;

export const TEMPLATES = {
  factor: {
    name: "Factor",
    zk: "managed/bounty_factor",
    compiled: CompiledContract.make("BountyFactorContract", Factor.Contract).pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets("managed/bounty_factor"),
    ),
    ledger: Factor.ledger,
  },
  signed: {
    name: "Signed record",
    zk: "managed/bounty_signed_record",
    compiled: CompiledContract.make("BountySignedRecordContract", Signed.Contract).pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets("managed/bounty_signed_record"),
    ),
    ledger: Signed.ledger,
  },
} as const;

export async function deployTemplate(t: Template, providers: TemplateProviders, colorBytes: Uint8Array) {
  const deployed = await deployContract(providers as never, {
    compiledContract: TEMPLATES[t].compiled as never,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: newPrivateState(),
    args: [colorBytes, MIN_REWARD, MIN_WINDOW],
  } as never);
  return { contract: deployed as unknown as TemplateContract, address: (deployed as { deployTxData: { public: { contractAddress: string } } }).deployTxData.public.contractAddress };
}

/** Join by address, reusing this browser's private state for it when there is one. */
export async function joinTemplate(t: Template, providers: TemplateProviders, address: ContractAddress): Promise<TemplateContract> {
  providers.privateStateProvider.setContractAddress(address);
  const stored = await providers.privateStateProvider.get(PRIVATE_STATE_ID);
  const found = await findDeployedContract(providers as never, {
    compiledContract: TEMPLATES[t].compiled as never,
    contractAddress: address,
    privateStateId: PRIVATE_STATE_ID,
    ...(stored === null ? { initialPrivateState: newPrivateState() } : {}),
  } as never);
  return found as unknown as TemplateContract;
}

export async function readTemplateState(providers: TemplateProviders, address: ContractAddress): Promise<PrivateBountiesPrivateState | null> {
  providers.privateStateProvider.setContractAddress(address);
  return providers.privateStateProvider.get(PRIVATE_STATE_ID);
}

export function template$(t: Template, providers: TemplateProviders, address: ContractAddress): Observable<TemplateLedger> {
  return providers.publicDataProvider.contractStateObservable(address, { type: "latest" }).pipe(map((s) => TEMPLATES[t].ledger(s.data)));
}

// ---- record types ----

export interface RecordType {
  name: string;
  fields: [string, string, string];
}

/** The record types the post form offers. Any other name works too, with numbered fields. */
export const RECORD_TYPES: RecordType[] = [
  { name: "Bank statement v1", fields: ["Amount", "Issued at", "Subject"] },
  { name: "Age attestation v1", fields: ["Age", "Issued at", "Subject"] },
  { name: "Contribution record v1", fields: ["Merged PRs", "Issued at", "Subject"] },
];

/** A type's name as the record's first element: its UTF-8 bytes, big-endian, at most 31. */
export function schemaTag(name: string): bigint {
  const bytes = new TextEncoder().encode(name.trim());
  if (bytes.length === 0 || bytes.length > 31) throw new Error("A record type's name is 1 to 31 bytes");
  return bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
}

/** The inverse of schemaTag, or null when the element isn't a readable name. */
export function schemaName(tag: bigint): string | null {
  const bytes: number[] = [];
  for (let x = tag; x > 0n; x >>= 8n) bytes.unshift(Number(x & 0xffn));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export function fieldNames(tag: bigint): [string, string, string] {
  const name = schemaName(tag);
  return RECORD_TYPES.find((t) => t.name === name)?.fields ?? ["Field 1", "Field 2", "Field 3"];
}

// ---- signed records, as files an issuer hands a holder ----

export interface SignedRecord {
  record: bigint[];
  issuerPk: { x: bigint; y: bigint };
  signature: SchnorrSignature;
}

const FILE_KIND = "private-bounties/signed-record";

export function recordToFile(r: SignedRecord): string {
  const s = (x: bigint) => x.toString();
  return JSON.stringify(
    {
      kind: FILE_KIND,
      v: 1,
      type: schemaName(r.record[0]!) ?? undefined,
      record: r.record.map(s),
      issuer: { x: s(r.issuerPk.x), y: s(r.issuerPk.y) },
      signature: { announcement: { x: s(r.signature.announcement.x), y: s(r.signature.announcement.y) }, response: s(r.signature.response) },
    },
    null,
    2,
  );
}

export function recordFromFile(text: string): SignedRecord {
  let o: {
    kind?: unknown;
    record?: unknown;
    issuer?: { x?: unknown; y?: unknown };
    signature?: { announcement?: { x?: unknown; y?: unknown }; response?: unknown };
  };
  try {
    o = JSON.parse(text) as typeof o;
  } catch {
    throw new Error("That isn't a signed-record file");
  }
  const num = (v: unknown): bigint => {
    if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("That signed-record file is damaged");
    return BigInt(v);
  };
  if (o.kind !== FILE_KIND || !Array.isArray(o.record) || o.record.length !== 4) throw new Error("That isn't a signed-record file");
  return {
    record: o.record.map(num),
    issuerPk: { x: num(o.issuer?.x), y: num(o.issuer?.y) },
    signature: { announcement: { x: num(o.signature?.announcement?.x), y: num(o.signature?.announcement?.y) }, response: num(o.signature?.response) },
  };
}

/** An issuer key pair, made in this browser. */
export function newIssuerKey(): { sk: bigint; pk: { x: bigint; y: bigint } } {
  const sk = randomScalar();
  return { sk, pk: Signed.pureCircuits.publicKey(sk) };
}

export function issuerPublicKey(sk: bigint): { x: bigint; y: bigint } {
  return Signed.pureCircuits.publicKey(sk);
}

/** Issue a signed record: [type, f1, f2, f3], each field below 2^64. */
export async function issueRecord(sk: bigint, type: string, fields: [bigint, bigint, bigint]): Promise<SignedRecord> {
  if (fields.some((f) => f < 0n || f >= 2n ** 64n)) throw new Error("Each field is a whole number below 2^64");
  const record = [schemaTag(type), ...fields];
  return { record, issuerPk: issuerPublicKey(sk), signature: await signRecord(sk, record) };
}

/** An issuer key as one string to copy, and back. */
export const pointText = (p: { x: bigint; y: bigint }) => `${p.x.toString(16)}:${p.y.toString(16)}`;
export function pointFromText(text: string): { x: bigint; y: bigint } | null {
  const m = /^([0-9a-f]+):([0-9a-f]+)$/i.exec(text.trim());
  return m ? { x: BigInt(`0x${m[1]}`), y: BigInt(`0x${m[2]}`) } : null;
}

// ---- the board ----

export interface TemplateView {
  template: Template;
  id: Uint8Array;
  idHex: string;
  title: string;
  details: string;
  status: Status;
  deadline: bigint;
  postedAt: bigint | null;
  reward: bigint | null;
  mine: boolean;
  /** factor: N. */
  n?: bigint;
  /** signed: what a record must show. */
  rule?: { issuerPk: { x: bigint; y: bigint }; schema: bigint; field: number; threshold: bigint };
}

export function templateViews(t: Template, state: TemplateLedger, address: ContractAddress, ps: PrivateBountiesPrivateState | null): TemplateView[] {
  const rows: TemplateView[] = [];
  for (const [id, b] of state.bounties) {
    const listing = state.listings.member(id) ? state.listings.lookup(id) : null;
    const base: TemplateView = {
      template: t,
      id,
      idHex: toHex(id),
      title: listing?.title ?? "",
      details: listing?.details ?? "",
      status: b.status as unknown as Status,
      deadline: b.deadline,
      postedAt: listing?.postedAt ?? null,
      reward: listing?.reward ?? null,
      mine: ps !== null && same(posterPseudonym(address, id, ps.sk), b.poster),
    };
    if (t === "factor") base.n = (b as Factor.Bounty).target;
    else {
      const s = b as Signed.Bounty;
      base.rule = { issuerPk: s.issuerPk, schema: s.schema, field: Number(s.field), threshold: s.threshold };
    }
    rows.push(base);
  }
  return rows;
}

// ---- answers ----

/** Two factors typed by a solver, as the checker wants them: the smaller first. */
export function factorAnswer(a: string, b: string): bigint[] {
  if (!/^\d+$/.test(a.trim()) || !/^\d+$/.test(b.trim())) throw new Error("Enter two whole numbers");
  let p = BigInt(a.trim());
  let q = BigInt(b.trim());
  if (p > q) [p, q] = [q, p];
  return [p, q, 0n, 0n];
}

/**
 * Why submitting `answer` would fail right now, mirroring the circuit in
 * order, or null. For a signed record the signature is checked in the proof;
 * here only that it was made by this bounty's issuer key, which the file
 * names, and the threshold.
 */
export function templateSubmitError(v: TemplateView, now: bigint, answer: bigint[] | null, issuerPk?: { x: bigint; y: bigint }): string | null {
  if (v.status !== Status.OPEN) return "Bounty is closed";
  if (now >= v.deadline) return "Deadline has passed";
  if (!answer) return "Enter an answer";
  if (v.template === "factor") {
    const [p, q] = answer as [bigint, bigint];
    if (p <= 1n || q <= 1n) return "Neither factor can be 1";
    if (p >= 2n ** 64n || q >= 2n ** 128n) return "A factor is too large";
    return p * q === v.n ? null : "Wrong answer";
  }
  const r = v.rule!;
  if (answer[0] !== r.schema) return "Wrong record type";
  if (!issuerPk || issuerPk.x !== r.issuerPk.x || issuerPk.y !== r.issuerPk.y) return "Not signed by this bounty's issuer";
  return Signed.pureCircuits.meetsThreshold(answer, BigInt(r.field), r.threshold) ? null : "Wrong answer";
}

export function templateRefundError(v: TemplateView, now: bigint): string | null {
  if (v.status !== Status.OPEN) return "Bounty is closed";
  if (!v.mine) return "Only the poster can refund";
  return now < v.deadline ? "Deadline has not passed" : null;
}

// ---- calls ----

export interface TemplatePost {
  title: string;
  details: string;
  reward: bigint;
  deadline: bigint;
  colorHex: string;
  postedAt?: bigint;
  n?: bigint;
  rule?: { issuerPk: { x: bigint; y: bigint }; schema: bigint; field: number; threshold: bigint };
}

export function templatePostError(t: Template, state: TemplateLedger, p: TemplatePost, now: bigint): string | null {
  const text = listingError(p.title, p.details);
  if (text) return text;
  if (t === "factor") {
    if (p.n === undefined || p.n < 4n) return "N must be at least 4";
    if (p.n >= 2n ** 128n) return "N must be below 2^128";
  } else {
    if (!p.rule) return "Say what the record must show";
    if (p.rule.field < 1 || p.rule.field > 3) return "Field must be 1 to 3";
    if (p.rule.threshold < 0n || p.rule.threshold >= 2n ** 64n) return "The threshold is a whole number below 2^64";
  }
  const postedAt = p.postedAt ?? postTime(Number(now) * 1000);
  if (p.deadline < postedAt + state.minWindow) return "Deadline is too soon";
  if (p.reward <= 0n) return "Reward has no value";
  if (p.reward < state.minReward) return "Reward is below the minimum";
  return null;
}

export async function postTemplate(t: Template, contract: TemplateContract, providers: TemplateProviders, address: ContractAddress, p: TemplatePost) {
  const ps = await readTemplateState(providers, address);
  if (!ps?.posterSeed) throw new Error("This browser has no poster seed for this contract: rejoin it first.");
  const salt = randomBytes32();
  const id = Factor.pureCircuits.bountyIdFor(salt, ps.sk);
  const key = await posterKeyFor(ps.posterSeed, address, id);
  const posterPk = Factor.pureCircuits.posterPublicKey(key);
  const reward = freshCoin(p.colorHex, p.reward);
  const postedAt = p.postedAt ?? postTime();
  const tx =
    t === "factor"
      ? await (contract as FoundContract<FactorContract>).callTx.postBounty(salt, reward, posterPk, p.n!, p.deadline, p.title.trim(), p.details.trim(), postedAt)
      : await (contract as FoundContract<SignedContract>).callTx.postBounty(
          salt,
          reward,
          posterPk,
          p.rule!.issuerPk,
          p.rule!.schema,
          BigInt(p.rule!.field),
          p.rule!.threshold,
          p.deadline,
          p.title.trim(),
          p.details.trim(),
          postedAt,
        );
  return { id, tx };
}

/** Solve: the answer (and a record's signature) go into private state for the call only. */
export async function submitTemplate(
  contract: TemplateContract,
  providers: TemplateProviders,
  address: ContractAddress,
  v: TemplateView,
  answer: bigint[],
  signature: SchnorrSignature = NO_SIGNATURE,
  colorHex: string,
) {
  const base = await readTemplateState(providers, address);
  if (!base) throw new Error("No private state for this contract: rejoin it first.");
  const write = async (s: PrivateBountiesPrivateState) => {
    providers.privateStateProvider.setContractAddress(address);
    await providers.privateStateProvider.set(PRIVATE_STATE_ID, s);
  };
  await write({ ...base, answer, signature });
  try {
    return await (contract as FoundContract<FactorContract>).callTx.submit(v.id, freshCoin(colorHex, 0n));
  } finally {
    await write({ ...base, answer: NO_ANSWER, signature: NO_SIGNATURE });
  }
}

export const refundTemplate = (contract: TemplateContract, v: TemplateView) => (contract as FoundContract<FactorContract>).callTx.refund(v.id);

/** The poster decrypts what the solver delivered: the factors, or the record. */
export async function readTemplateAnswer(state: TemplateLedger, address: ContractAddress, v: TemplateView, posterSeed: Uint8Array): Promise<bigint[]> {
  const key = await posterKeyFor(posterSeed, address, v.id);
  const mine = Factor.pureCircuits.posterPublicKey(key);
  const posted = state.bounties.lookup(v.id).posterPk;
  if (mine.x !== posted.x || mine.y !== posted.y) throw new Error("This browser's key doesn't match the bounty's: it was posted from another seed");
  return Factor.pureCircuits.decrypt(state.deliveries.lookup(v.id), key, v.id);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
