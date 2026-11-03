import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { workCircuits } from "~/midnight/work-api";
import { useWallet } from "@/hooks/use-wallet";
import { NETWORK_IDS } from "@/providers/wallet-context";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { duplicates } from "~/lib/board";
import { filterItems, itemTotals, type Kind, type Need } from "~/lib/items";
import { amount, short } from "~/lib/format";
import { href, type Route } from "~/router";
import { useSession } from "~/session";
import { useProofServer } from "~/hooks/use-proof-server";
import { BountyTable } from "~/components/bounty-table";
import { networkName } from "~/components/top-bar";
import { Amount, Button, CopyButton, cx, Dot, LinkButton, Panel } from "~/components/ui";
import { useCanAct } from "~/components/wallet-gate";
import { canBrowse } from "~/midnight/read-only";
import { parseBoardCode } from "~/pages/setup";

export function BoardPage() {
  const { status } = useWallet();
  const { deployment, state, boardAddress, browsing, network } = useSession();

  // With no wallet, a board can still be read where the network has a public indexer.
  if (!boardAddress || (browsing && status !== "connected" && !canBrowse(network))) return <Welcome />;
  if (!state) return <Loading what={deployment.error ? null : "Reading the board from the indexer"} error={deployment.error} />;
  return <Board key={boardAddress} address={boardAddress} />;
}

/** A shared board link (`#/board/<network>/<code>`): opens the board, read-only until a wallet joins it. */
export function OpenBoardPage({ route }: { route: Extract<Route, { name: "open-board" }> }) {
  const { status, setRequestedNetworkId } = useWallet();
  const { network, boardAddress, openBoard, deployment } = useSession();
  const code = parseBoardCode(route.code);
  if (!code || !(NETWORK_IDS as readonly string[]).includes(route.network)) return <Loading what={null} error="That board link is broken. Ask whoever shared it for the board code." />;
  if (boardAddress === code.verified && network === route.network) return <BoardPage />;
  const elsewhere = route.network !== network;
  return (
    <div className="flex flex-col items-start gap-4 py-16">
      <h1 className="m-0 text-3xl font-semibold tracking-tight">Open this board?</h1>
      <p className="m-0 max-w-[560px] text-muted">
        Board <span className="font-mono text-fg-2">{short(code.verified, 10, 8)}</span> on {networkName(route.network)}.
        {boardAddress && !elsewhere ? " It replaces the board you have open now." : ""}
        {elsewhere && status === "connected" ? ` Your wallet is on ${networkName(network)}: switch it to ${networkName(route.network)} and reconnect to open it.` : ""}
      </p>
      {/* Switching the network first: each network keeps its own board addresses. */}
      {elsewhere ? (
        status !== "connected" && (
          <Button size="lg" onClick={() => setRequestedNetworkId(route.network as Parameters<typeof setRequestedNetworkId>[0])}>
            Switch to {networkName(route.network)}
          </Button>
        )
      ) : (
        <Button size="lg" busy={deployment.busy === "joining"} onClick={() => openBoard(code)}>
          Open the board
        </Button>
      )}
    </div>
  );
}

const NEED_TEXT: Record<Need, [string, string]> = {
  read: ["an answer to read", "answers to read"],
  refund: ["a refund to claim", "refunds to claim"],
  review: ["a submission to review", "submissions to review"],
  deliver: ["work to deliver", "pieces of work to deliver"],
  collect: ["a reward to collect", "rewards to collect"],
};

function BrowsingNote() {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const what = status !== "connected" ? "Connect a wallet" : locked ? "Unlock this browser's store" : "Join this board";
  return (
    <Panel className="flex flex-wrap items-center justify-between gap-4 px-4.5 py-3.5">
      <span className="text-muted">You're browsing. {what} to post, solve or apply.</span>
      <LinkButton href={href({ name: "setup" })} variant="ghost">
        {what}
      </LinkButton>
    </Panel>
  );
}

function Board({ address }: { address: string }) {
  const { items, now, hidden, work } = useSession();
  const canAct = useCanAct();
  const { networkId } = useWallet();
  const [kind, setKind] = useState<Kind | "all">("all");
  const [phase, setPhase] = useState<"active" | "done">("active");
  const [sort, setSort] = useState<"newest" | "reward" | "ending">("newest");
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  const t = itemTotals(items);
  const copies = useMemo(() => duplicates(items), [items]);
  const noneHidden = useMemo(() => new Set<string>(), []);
  const rows = filterItems(items, { kind, phase, query, sort }, showHidden ? noneHidden : hidden.set);
  const inPhase = items.filter((b) => b.active === (phase === "active") && !hidden.set.has(b.idHex));
  const hiddenHere = items.filter((b) => hidden.set.has(b.idHex) && b.active === (phase === "active")).length;
  const count = (k: Kind | "all") => inPhase.filter((b) => k === "all" || b.kind === k).length;

  const needCounts = new Map<Need, number>();
  for (const b of items) if (b.needs) needCounts.set(b.needs, (needCounts.get(b.needs) ?? 0) + 1);
  const needs = [...needCounts].map(([n, c]) => (c === 1 ? NEED_TEXT[n][0] : `${c} ${NEED_TEXT[n][1]}`));
  const sumOf = (f: (b: (typeof items)[number]) => boolean) => items.filter(f).reduce((a, b) => a + (b.reward ?? 0n), 0n);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
        <div className="flex max-w-[640px] flex-col gap-2">
          <h1 className="m-0 text-4xl leading-tight font-semibold tracking-tight">Bounties</h1>
          <p className="m-0 text-base text-muted">
            Work you can claim and deliver, and questions a proof can check. Every reward is held by the contract and paid out
            privately.
          </p>
        </div>
        <dl aria-label="Board totals" className="m-0 grid grid-cols-3 rounded-lg border border-line">
          <Stat label="In escrow" value={<Amount value={amount(t.inEscrow)} />} />
          <Stat label="Active" value={<span className="font-mono font-medium">{t.active}</span>} border />
          <Stat label="Paid out" value={<Amount value={amount(t.paidOut)} />} border />
        </dl>
      </header>

      {!canAct && <BrowsingNote />}

      {needs.length > 0 && (
        <Panel tone="navy" className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4.5 py-3.5">
          <Dot tone="private" />
          <span role="status" className="flex-[1_1_320px]">
            {needs.length === 1 ? "One thing needs you: " : "A few things need you: "}
            <strong className="font-semibold">{needs.length === 1 ? needs[0] : `${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`}</strong>.
          </span>
          <a href={href({ name: "mine" })} className="font-semibold text-link no-underline hover:text-link-hover">
            Open my bounties
          </a>
        </Panel>
      )}

      <div className="flex flex-wrap items-start gap-8">
        <section aria-label="Bounties" className="flex min-w-0 flex-[999_1_660px] flex-col gap-4">
          <div role="group" aria-label="Kind" className="flex gap-6 border-b border-line">
            {([["all", "All"], ["work", "Reviewed work"], ["answer", "Verified answers"]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cx(
                  "-mb-px inline-flex h-11 items-center gap-1.5 border-b-2 text-[15px] font-semibold transition-colors",
                  kind === k ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {label} <span className="font-mono text-xs text-faint">{count(k)}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 flex-[1_1_260px] items-center gap-2 rounded-lg border border-line bg-surface px-3 text-faint transition-colors hover:border-line-hover focus-within:border-focus">
              <Search aria-hidden="true" className="size-4" />
              <span className="sr-only">Search bounties</span>
              <input
                type="search"
                placeholder="Search titles and descriptions"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-fg outline-none"
              />
            </label>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-line px-2.5 text-sm text-muted transition-colors hover:border-line-hover">
              Status
              <select value={phase} onChange={(e) => setPhase(e.target.value as "active" | "done")} className="border-0 bg-transparent text-fg outline-none">
                <option value="active">Active</option>
                <option value="done">Done</option>
              </select>
            </label>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-line px-2.5 text-sm text-muted transition-colors hover:border-line-hover">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="border-0 bg-transparent text-fg outline-none">
                <option value="newest">Newest</option>
                <option value="reward">Highest reward</option>
                <option value="ending">Ending soon</option>
              </select>
            </label>
          </div>

          <BountyTable
            rows={rows}
            now={now}
            copies={copies}
            empty={query ? "No bounties match that search." : phase === "active" ? "Nothing active right now." : "Nothing finished yet."}
            footer={
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-[13px] text-faint">
                <span>
                  Showing {rows.length} · read live from the {networkName(networkId)} indexer
                  {!work.address && " · this board has no reviewed-work contract yet"}
                </span>
                {hiddenHere > 0 && (
                  <button type="button" onClick={() => setShowHidden(!showHidden)} className="text-link hover:text-link-hover">
                    {showHidden ? "Leave out hidden ones" : `Show ${hiddenHere} you hid`}
                  </button>
                )}
              </div>
            }
          />
        </section>

        <aside className="flex max-w-[320px] min-w-0 flex-[1_1_280px] flex-col gap-7">
          <section aria-labelledby="you-title" className="flex flex-col gap-1">
            <h2 id="you-title" className="m-0 mb-2 text-[15px] font-semibold">
              You
            </h2>
            <dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] border-t border-line-soft text-sm">
              <SideRow label="Working on" value={String(items.filter((b) => b.needs === "deliver").length)} />
              <SideRow label="To review" value={String(needCounts.get("review") ?? 0)} />
              <SideRow label="Answers to read" value={String(needCounts.get("read") ?? 0)} />
              <SideRow label="Refund ready" value={`${amount(sumOf((b) => b.needs === "refund"))} TEST`} />
              <SideRow label="Earned here" value={`${amount(sumOf((b) => b.earnedHere))} TEST`} last />
            </dl>
            <a href={href({ name: "mine" })} className="mt-1.5 text-sm font-semibold text-link no-underline hover:text-link-hover">
              My bounties
            </a>
          </section>
          <ProvingCard />
          <BoardCard address={address} />
        </aside>
      </div>

      <TwoKinds />
      <WhatTheChainSees />
    </div>
  );
}

function TwoKinds() {
  return (
    <section aria-labelledby="kinds-title" className="flex flex-col gap-5 border-t border-line pt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h2 id="kinds-title" className="m-0 text-2xl font-semibold tracking-tight">
            Two kinds of bounty
          </h2>
          <p className="m-0 text-muted">Pick by who decides the work is done.</p>
        </div>
        <a href={href({ name: "post" })} className="font-semibold text-link no-underline hover:text-link-hover">
          Post a bounty
        </a>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <KindCard to={{ name: "post-work" }} title="Reviewed work" foot="Building, writing, design, events, community work">
          Someone claims it or you pick an applicant, they deliver within a window, and you approve before they're paid. If you
          don't review in time, they're paid anyway.
        </KindCard>
        <KindCard to={{ name: "post-answer" }} title="Verified answer" foot="Puzzles, crypto challenges, verified data">
          A zero-knowledge proof checks the answer and pays the solver in the same transaction. Only you can read the answer.
        </KindCard>
      </div>
    </section>
  );
}

export function KindCard({ to, title, foot, children }: { to: Route; title: string; foot: string; children: ReactNode }) {
  return (
    <a href={href(to)} className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface p-5.5 text-inherit no-underline transition-colors hover:border-line-hover">
      <span className="text-[17px] font-semibold">{title}</span>
      <span className="text-muted">{children}</span>
      <span className="mt-auto border-t border-line-soft pt-3 text-[13px] text-faint">{foot}</span>
    </a>
  );
}

function Stat({ label, value, border = false }: { label: string; value: ReactNode; border?: boolean }) {
  return (
    <div className={cx("flex flex-col gap-0.5 px-5 py-3", border && "border-l border-line")}>
      <dt className="text-[13px] text-faint">{label}</dt>
      <dd className="m-0 text-xl">{value}</dd>
    </div>
  );
}

function SideRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <>
      <dt className={cx("py-2 text-muted", !last && "border-b border-line-soft")}>{label}</dt>
      <dd className={cx("m-0 py-2 text-right font-mono", !last && "border-b border-line-soft")}>{value}</dd>
    </>
  );
}

export function ProvingCard() {
  const { proving } = useMidnightProviders();
  const local = proving.mode === "local";
  const server = useProofServer(local ? proving.proofServerUrl : null);
  return (
    <section aria-labelledby="prover-title" className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <h2 id="prover-title" className="m-0 text-[15px] font-semibold">
        Proving
      </h2>
      <span className="inline-flex items-center gap-2 text-sm">
        <Dot tone={!local ? "warn" : server.status === "ready" ? "ok" : server.status === "checking" ? "muted" : "bad"} />
        {!local
          ? "Your wallet makes the proofs"
          : server.status === "ready"
            ? "Local proof server ready"
            : server.status === "checking"
              ? "Checking the local proof server"
              : "Local proof server not running"}
      </span>
      <span className="text-[13px] text-muted">
        {local
          ? "Every post, solve and refund is proved on this machine, so your answers and keys never leave it."
          : "The wallet, and any service it proves with, sees your answers and keys."}
      </span>
      <a href={href({ name: "setup" })} className="text-sm font-semibold text-link no-underline hover:text-link-hover">
        Setup
      </a>
    </section>
  );
}

/** One string that joins all of a board's contracts (parseBoardCode in setup reads it back). */
export function boardCode(verified: string, work: string | null, factor: string | null = null, signed: string | null = null): string {
  return [verified, work ?? "", factor ?? "", signed ?? ""].join(".").replace(/\.+$/, "");
}

function BoardCard({ address }: { address: string }) {
  const { work, templates, network } = useSession();
  const code = boardCode(address, work.address, templates.factor.address, templates.signed.address);
  const link = `${window.location.origin}${window.location.pathname}${href({ name: "open-board", network, code })}`;
  const arbiter = work.ps ? toHex(workCircuits.arbiterId(work.ps.sk)) : null;
  return (
    <section aria-labelledby="board-title" className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <h2 id="board-title" className="m-0 text-[15px] font-semibold">
        This board
      </h2>
      <span className="flex items-center gap-1 font-mono text-[13px] text-fg-2">
        {short(code, 10, 8)}
        <CopyButton text={code} label="Copy the board code" />
      </span>
      <span className="flex items-center gap-1 text-[13px] text-muted">
        Or share a link anyone can open, even without a wallet
        <CopyButton text={link} label="Copy the board link" />
      </span>
      {arbiter && (
        <span className="flex items-center gap-1 text-[13px] text-muted">
          Your arbiter ID <span className="font-mono text-fg-2">{short(arbiter, 6, 4)}</span>
          <CopyButton text={arbiter} label="Copy your arbiter ID" />
        </span>
      )}
      <a href={href({ name: "setup" })} className="text-sm font-semibold text-link no-underline hover:text-link-hover">
        Change board
      </a>
    </section>
  );
}

export function WhatTheChainSees() {
  return (
    <Panel tone="navy" className="flex flex-wrap gap-x-12 gap-y-8 p-6 sm:p-9">
      <div className="flex max-w-[420px] flex-[1_1_300px] flex-col gap-2.5">
        <h2 className="m-0 text-2xl font-semibold tracking-tight">What the chain sees</h2>
        <p className="m-0 text-muted">
          Rewards are locked up front and paid by the contract, so nobody has to trust a promise to pay. Who solved a bounty, what
          they answered, and where the money went stay off the public record.
        </p>
        <a
          href="https://github.com/Kanasjnr/Midnight-private-bounties/blob/main/ARCHITECTURE.md#14-privacy-model"
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-link no-underline hover:text-link-hover"
        >
          Read the design
        </a>
      </div>
      <div className="grid flex-[999_1_460px] grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-6">
        <div className="flex flex-col gap-2.5">
          <span className="text-[13px] font-semibold text-muted">On chain, for anyone</span>
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4.5 text-fg-2 marker:text-faint">
            <li>The bounty: title, question, reward, deadline</li>
            <li>A hash of the right answer</li>
            <li>Its status: open, solved or refunded</li>
            <li>The answer, as ciphertext only the poster can open</li>
          </ul>
        </div>
        <div className="flex flex-col gap-2.5">
          <span className="text-[13px] font-semibold text-private">Never on chain</span>
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4.5 text-fg-2 marker:text-faint">
            <li>Who posted or solved it: each bounty gets a new identity</li>
            <li>The answer itself</li>
            <li>Where the reward went</li>
            <li>Your wallet's keys and this browser's secrets</li>
          </ul>
        </div>
      </div>
    </Panel>
  );
}

/** Before a wallet, store and board are ready: what the app is, and how to start. */
function Welcome() {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { deployment } = useSession();
  const next = status !== "connected" ? "Connect a wallet" : locked ? "Unlock this browser's store" : deployment.busy === "joining" ? null : "Join a board";
  return (
    <div className="flex flex-col gap-10">
      <header className="flex max-w-[720px] flex-col gap-4 pt-6">
        <h1 className="m-0 text-4xl leading-tight font-semibold tracking-tight sm:text-5xl">Bounties that pay when the proof checks out</h1>
        <p className="m-0 text-lg text-muted">
          Post a question with a reward. A solver proves their answer is right before anything is paid, the contract pays them in
          the same transaction, and only you can read the answer.
        </p>
        <div className="flex flex-wrap items-center gap-4 pt-2">
          {next ? <LinkButton href={href({ name: "setup" })} size="lg">{next}</LinkButton> : <span className="text-muted">Joining the board…</span>}
          <span className="text-sm text-faint">Setup takes a few minutes the first time.</span>
        </div>
        {deployment.error && <p className="m-0 text-sm text-bad">{deployment.error}</p>}
      </header>
      <WhatTheChainSees />
    </div>
  );
}

export function Loading({ what, error }: { what: string | null; error?: string | null }) {
  return (
    <div className="flex flex-col items-start gap-3 py-16">
      {what && (
        <span className="inline-flex items-center gap-3 text-muted">
          <Dot tone="private" className="animate-pulse" />
          {what}
        </span>
      )}
      {error && <p className="m-0 text-sm text-bad">{error}</p>}
      {error && (
        <LinkButton href={href({ name: "setup" })} variant="ghost">
          Go to setup
        </LinkButton>
      )}
    </div>
  );
}
