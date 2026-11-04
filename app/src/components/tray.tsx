// The progress tray: transactions in flight and just finished, pinned to the
// corner so a proof (which can take minutes on a busy laptop) never blocks
// the page. Each step comes from the instrumented providers (~/tx).
import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { clockStore, useStore } from "~/lib/store";
import { PHASES, useTx, type TxEntry, type TxPhase } from "~/tx";
import { Button, cx, Dot } from "~/components/ui";

function phaseText(phase: TxPhase, wallet: boolean): string {
  switch (phase) {
    case "preparing":
      return "running the circuit in your browser";
    case "proving":
      return wallet ? "the wallet is making the proof" : "making the proof on your machine";
    case "wallet":
      return "approve it in your wallet";
    case "sending":
      return "sending to the network";
    case "confirming":
      return "waiting for a block";
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const ticker = clockStore(1_000, (ms) => ms);

/** How long a transaction has run. Only this text ticks, not the tray around it. */
function Elapsed({ from, to }: { from: number; to?: number }) {
  return <span className="font-mono text-xs text-faint">{to === undefined ? <Ticking from={from} /> : clock(to - from)}</span>;
}

function Ticking({ from }: { from: number }) {
  return <>{clock(useStore(ticker) - from)}</>;
}

export function Tray() {
  const { entries, dismiss } = useTx();
  const { proving } = useMidnightProviders();
  // Collapsing remembers the newest entry; a newer one opens the tray again.
  const [collapsedAt, setCollapsedAt] = useState<number | null>(null);
  const running = entries.find((e) => e.state === "running");
  const open = collapsedAt === null || collapsedAt !== entries[0]?.id;

  if (entries.length === 0) return null;
  const wallet = proving.mode === "wallet";

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded="false"
        onClick={() => setCollapsedAt(null)}
        className="fixed right-4 bottom-4 z-30 inline-flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-full border border-line-strong bg-surface py-2.5 pr-4 pl-3.5 text-sm shadow-pop"
      >
        <Dot tone={running ? "private" : entries[0]?.state === "failed" ? "bad" : "ok"} className={running ? "animate-pulse" : ""} />
        {running ? (
          <span className="truncate">
            <strong className="font-medium">{running.label}</strong> <span className="text-muted">· {phaseText(running.phase, wallet)}</span>
          </span>
        ) : (
          <span className="font-medium">Transactions</span>
        )}
        {running && <Elapsed from={running.startedAt} />}
        <span className="rounded bg-chip px-1.5 font-mono text-xs">{entries.length}</span>
      </button>
    );
  }

  return (
    <section
      aria-label="Transactions"
      className="fixed right-4 bottom-4 z-30 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-line-strong bg-surface shadow-pop"
    >
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="text-sm font-medium">Transactions</span>
        <button type="button" aria-label="Collapse" aria-expanded="true" onClick={() => setCollapsedAt(entries[0]?.id ?? null)} className="rounded-md p-1 text-muted hover:bg-chip hover:text-fg">
          <ChevronDown className="size-4" />
        </button>
      </header>
      <ul className="m-0 flex max-h-[60vh] list-none flex-col overflow-y-auto p-0">
        {entries.map((e) => (
          <Row key={e.id} e={e} wallet={wallet} onDismiss={() => dismiss(e.id)} />
        ))}
      </ul>
      {running && <footer className="border-t border-line px-4 py-2.5 text-xs text-faint">Keep this tab open while a proof runs. You can keep browsing.</footer>}
    </section>
  );
}

function Row({ e, wallet, onDismiss }: { e: TxEntry; wallet: boolean; onDismiss: () => void }) {
  const step = PHASES.indexOf(e.phase);
  return (
    <li className="flex flex-col gap-2 border-b border-line-soft px-4 py-3 last:border-b-0">
      <div className="flex items-start gap-3">
        <Dot tone={e.state === "running" ? "private" : e.state === "failed" ? "bad" : "ok"} className={cx("mt-2", e.state === "running" && "animate-pulse")} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">{e.state === "failed" ? `${e.label}: failed` : e.state === "done" ? doneLabel(e.label) : e.label}</span>
          <span className="truncate text-[13px] text-muted">{e.subject}</span>
        </span>
        <Elapsed from={e.startedAt} to={e.endedAt} />
        {e.state !== "running" && (
          <button type="button" aria-label="Dismiss" onClick={onDismiss} className="rounded p-0.5 text-faint hover:text-fg">
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {e.state === "running" && (
        <>
          <span aria-hidden="true" className="flex gap-1">
            {PHASES.map((p, i) => (
              <span key={p} className={cx("h-1 flex-1 rounded-full", i < step ? "bg-private" : i === step ? "animate-pulse bg-private/70" : "bg-chip")} />
            ))}
          </span>
          <span className="text-[13px] text-muted" role="status">
            Step {step + 1} of {PHASES.length} · {phaseText(e.phase, wallet)}
          </span>
        </>
      )}
      {e.state === "failed" && (
        <>
          <p className="m-0 text-[13px] break-words text-bad">{e.error}</p>
          <p className="m-0 text-[13px] text-muted">{failedNote(e.phase)}</p>
          {e.retry && (
            <div>
              <Button size="sm" variant="ghost" onClick={e.retry}>
                Retry
              </Button>
            </div>
          )}
        </>
      )}
      {e.state === "done" && e.href && (
        <a href={e.href} className="text-[13px] font-medium text-link no-underline hover:text-link-hover">
          View
        </a>
      )}
    </li>
  );
}

/** Whether anything could have been spent, from how far the call got. */
function failedNote(phase: TxPhase): string {
  if (phase === "confirming") return "It was sent, but the page couldn't see it land. Check the board before retrying.";
  if (phase === "sending") return "It may or may not have been sent. Check the board before retrying.";
  return "Nothing was sent, so nothing was spent.";
}

function doneLabel(label: string): string {
  const done: Record<string, string> = {
    "Posting bounty": "Bounty posted",
    "Submitting answer": "Answer submitted, reward paid",
    "Claiming refund": "Refund claimed",
    "Minting test tokens": "Test tokens minted",
    "Deploying the test token": "Test token deployed",
    "Starting a board": "Board started",
  };
  return done[label] ?? `${label}: done`;
}
