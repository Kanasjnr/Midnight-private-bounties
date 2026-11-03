// The board's recent activity, from the indexer's history of each contract
// (spike Q14): `contract(address) { actions(limit) }` lists the latest
// actions, newest first, each with the circuit that ran, its block time and
// the whole contract state after it. An action doesn't say which bounty it
// touched, so each state is decoded and compared with the one before it.
// Everything here is public: titles, rewards and statuses, never who acted.
import { ContractState } from "@midnight-ntwrk/midnight-js-protocol/compact-runtime";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { bountyViews } from "@/midnight/private-bounties-api";
import { ledger as answerLedger } from "@/midnight/contract";
import { workLedger, workViews } from "~/midnight/work-api";
import { templateViews, TEMPLATES } from "~/midnight/verified-api";

export type FeedKind = "answer" | "work" | "factor" | "signed";

/** What the feed needs of a bounty in one state. */
export interface Snapshot {
  title: string;
  reward: bigint | null;
  status: number;
}

/** One action on a contract, decoded: the state after it, as bounties by ID. */
export interface Step {
  kind: FeedKind;
  address: string;
  /** The circuit, or "deploy". */
  circuit: string;
  /** Block time, in milliseconds. */
  at: number;
  hash: string;
  bounties: Map<string, Snapshot>;
}

export interface ActivityEvent {
  key: string;
  kind: FeedKind;
  address: string;
  idHex: string | null;
  title: string | null;
  reward: bigint | null;
  text: string;
  at: number;
}

const ANSWER_TEXT: Record<string, string> = {
  postBounty: "New bounty",
  submit: "Solved and paid",
  refund: "Reward taken back",
};

const WORK_TEXT: Record<string, string> = {
  postWork: "New work",
  claim: "Claimed",
  assign: "Someone was assigned",
  release: "Claim released",
  submit: "Work delivered",
  approve: "Work approved",
  reject: "Work rejected",
  overturn: "Rejection overturned",
  reopen: "Reopened",
  collect: "Reward collected",
  refund: "Reward taken back",
};

/** The bounties in one contract state, for any of the four contracts. */
export function snapshot(kind: FeedKind, address: string, data: ContractState["data"]): Map<string, Snapshot> {
  const views =
    kind === "answer"
      ? bountyViews(answerLedger(data), address, null)
      : kind === "work"
        ? workViews(workLedger(data), address, null)
        : templateViews(kind, TEMPLATES[kind].ledger(data), address, null);
  return new Map(views.map((v) => [v.idHex, { title: v.title, reward: v.reward, status: Number(v.status) }]));
}

/**
 * Events from one contract's steps, newest first. Each step is compared with
 * the next (older) one, so the oldest step is only context; a deploy needs no
 * comparison.
 */
export function eventsFrom(steps: Step[]): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  steps.forEach((s, i) => {
    const before = steps[i + 1];
    const base = { kind: s.kind, address: s.address, at: s.at };
    if (s.circuit === "deploy") {
      out.push({ ...base, key: `${s.hash}:deploy`, idHex: null, title: null, reward: null, text: s.kind === "answer" ? "Board started" : `${label(s.kind)} added to the board` });
      return;
    }
    if (!before) return;
    const texts = s.kind === "work" ? WORK_TEXT : ANSWER_TEXT;
    for (const [id, b] of s.bounties) {
      const was = before.bounties.get(id);
      if (was && was.status === b.status) continue;
      out.push({ ...base, key: `${s.hash}:${id}`, idHex: id, title: b.title, reward: b.reward, text: texts[s.circuit] ?? s.circuit });
    }
  });
  return out;
}

function label(kind: FeedKind): string {
  return kind === "work" ? "Reviewed work" : kind === "factor" ? "Factor bounties" : kind === "signed" ? "Signed-record bounties" : "Verified answers";
}

interface RawAction {
  __typename: "ContractDeploy" | "ContractCall" | "ContractUpdate";
  entryPoint?: string;
  state: string;
  transaction: { hash: string; block: { timestamp: number } };
}

const QUERY = `query Activity($address: HexEncoded!, $limit: Int!) {
  contract(address: $address) {
    actions(limit: $limit) {
      __typename
      ... on ContractCall { entryPoint }
      state
      transaction { hash block { timestamp } }
    }
  }
}`;

/** The last `limit` actions on one contract, decoded. A state this app can't decode (an older contract version) ends the list there. */
export async function fetchSteps(indexerUrl: string, kind: FeedKind, address: string, limit = 15): Promise<Step[]> {
  const res = await fetch(indexerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { address, limit } }),
  });
  if (!res.ok) throw new Error(`The indexer answered ${res.status}`);
  const body = (await res.json()) as { data?: { contract: { actions: RawAction[] } | null }; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error(body.errors[0]!.message);
  const steps: Step[] = [];
  for (const a of body.data?.contract?.actions ?? []) {
    let bounties: Map<string, Snapshot>;
    try {
      bounties = snapshot(kind, address, ContractState.deserialize(fromHex(a.state)).data);
    } catch {
      break;
    }
    const circuit = a.__typename === "ContractDeploy" ? "deploy" : (a.entryPoint ?? "update");
    steps.push({ kind, address, circuit, at: a.transaction.block.timestamp, hash: a.transaction.hash, bounties });
  }
  return steps;
}

/** Every contract's events, merged newest first. One contract failing leaves the others. */
export async function boardActivity(indexerUrl: string, contracts: { kind: FeedKind; address: string }[], max = 12): Promise<ActivityEvent[]> {
  const all = await Promise.all(contracts.map((c) => fetchSteps(indexerUrl, c.kind, c.address).then(eventsFrom, () => [] as ActivityEvent[])));
  return all.flat().sort((a, b) => b.at - a.at).slice(0, max);
}
