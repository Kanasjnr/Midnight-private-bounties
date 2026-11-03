import { useMemo, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { boardRows, duplicates, isActive, totals, yours, type Phase, type Sort } from "~/lib/board";
import { amount, short } from "~/lib/format";
import { href } from "~/router";
import { useSession } from "~/session";
import { useProofServer } from "~/hooks/use-proof-server";
import { BountyTable } from "~/components/bounty-table";
import { networkName } from "~/components/top-bar";
import { Amount, CopyButton, cx, Dot, LinkButton, Panel } from "~/components/ui";

export function BoardPage() {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { deployment, state } = useSession();

  if (status !== "connected" || locked || !deployment.address) return <Welcome />;
  if (!state) return <Loading what={deployment.error ? null : "Reading the board from the indexer"} error={deployment.error} />;
  return <Board key={deployment.address} address={deployment.address} />;
}

function Board({ address }: { address: string }) {
  const { views, now, hidden, read, solvedHere } = useSession();
  const { networkId } = useWallet();
  const [phase, setPhase] = useState<Phase>("active");
  const [sort, setSort] = useState<Sort>("newest");
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);

  const t = totals(views, now);
  const you = yours(views, now, solvedHere.set, read.set);
  const copies = useMemo(() => duplicates(views), [views]);
  const noneHidden = useMemo(() => new Set<string>(), []);
  const rows = boardRows(views, { phase, query, sort }, now, showHidden ? noneHidden : hidden.set);
  const hiddenHere = views.filter((b) => hidden.set.has(b.idHex) && isActive(b, now) === (phase === "active")).length;
  const count = (p: Phase) => views.filter((b) => isActive(b, now) === (p === "active") && !hidden.set.has(b.idHex)).length;

  const needs = [
    you.answersToRead > 0 && `${you.answersToRead === 1 ? "an answer" : `${you.answersToRead} answers`} to read`,
    you.refundCount > 0 && `${you.refundCount === 1 ? "a refund" : `${you.refundCount} refunds`} to claim`,
  ].filter((x): x is string => typeof x === "string");

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-x-12 gap-y-6">
        <div className="flex max-w-[640px] flex-col gap-2">
          <h1 className="m-0 text-4xl leading-tight font-semibold tracking-tight">Bounties</h1>
          <p className="m-0 text-base text-muted">
            Questions a zero-knowledge proof can check. Every reward is held by the contract and paid to the solver in the same
            transaction that proves the answer.
          </p>
        </div>
        <dl aria-label="Board totals" className="m-0 grid grid-cols-3 rounded-lg border border-line">
          <Stat label="In escrow" value={<Amount value={amount(t.inEscrow)} />} />
          <Stat label="Active" value={<span className="font-mono font-medium">{t.active}</span>} border />
          <Stat label="Paid out" value={<Amount value={amount(t.paidOut)} />} border />
        </dl>
      </header>

      {needs.length > 0 && (
        <Panel tone="navy" className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4.5 py-3.5">
          <Dot tone="private" />
          <span role="status" className="flex-[1_1_320px]">
            {needs.length === 1 ? "One thing needs you: " : "Two things need you: "}
            <strong className="font-semibold">{needs.join(" and ")}</strong>.
          </span>
          <a href={href({ name: "mine" })} className="font-semibold text-link no-underline hover:text-link-hover">
            Open my bounties
          </a>
        </Panel>
      )}

      <div className="flex flex-wrap items-start gap-8">
        <section aria-label="Bounties" className="flex min-w-0 flex-[999_1_660px] flex-col gap-4">
          <div role="group" aria-label="Phase" className="flex gap-6 border-b border-line">
            {(["active", "done"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={phase === p}
                onClick={() => setPhase(p)}
                className={cx(
                  "-mb-px inline-flex h-11 items-center gap-1.5 border-b-2 text-[15px] font-semibold transition-colors",
                  phase === p ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {p === "active" ? "Open" : "Closed"} <span className="font-mono text-xs text-faint">{count(p)}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <label className="flex h-9 flex-[1_1_260px] items-center gap-2 rounded-lg border border-line bg-surface px-3 text-faint transition-colors hover:border-line-hover focus-within:border-focus">
              <Search aria-hidden="true" className="size-4" />
              <span className="sr-only">Search bounties</span>
              <input
                type="search"
                placeholder="Search titles and questions"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-fg outline-none"
              />
            </label>
            <label className="flex h-9 items-center gap-2 rounded-lg border border-line px-2.5 text-sm text-muted transition-colors hover:border-line-hover">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="border-0 bg-transparent text-fg outline-none">
                <option value="newest">Newest</option>
                <option value="reward">Highest reward</option>
                <option value="ending">Ending soon</option>
              </select>
            </label>
          </div>

          <BountyTable
            rows={rows}
            address={address}
            now={now}
            copies={copies}
            empty={query ? "No bounties match that search." : phase === "active" ? "No open bounties right now." : "Nothing closed yet."}
            footer={
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-[13px] text-faint">
                <span>
                  Showing {rows.length} · read live from the {networkName(networkId)} indexer
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
              <SideRow label="Waiting for answers" value={String(you.waiting)} />
              <SideRow label="Answers to read" value={String(you.answersToRead)} />
              <SideRow label="Refund ready" value={`${amount(you.refundReady)} TEST`} />
              <SideRow label="Earned here" value={`${amount(you.earned)} TEST`} last />
            </dl>
            <a href={href({ name: "mine" })} className="mt-1.5 text-sm font-semibold text-link no-underline hover:text-link-hover">
              My bounties
            </a>
          </section>
          <ProvingCard />
          <BoardCard address={address} />
        </aside>
      </div>

      <WhatTheChainSees />
    </div>
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

function BoardCard({ address }: { address: string }) {
  return (
    <section aria-labelledby="board-title" className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <h2 id="board-title" className="m-0 text-[15px] font-semibold">
        This board
      </h2>
      <span className="flex items-center gap-1 font-mono text-[13px] text-fg-2">
        {short(address, 10, 8)}
        <CopyButton text={address} label="Copy the board's contract address" />
      </span>
      <span className="text-[13px] text-muted">One bounty contract. Share its address so others can join it.</span>
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
