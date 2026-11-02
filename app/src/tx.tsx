// Transactions in flight, for the progress tray.
//
// midnight-js runs every call and deploy as the same four steps:
// proofProvider.proveTx, walletProvider.balanceTx, midnightProvider.submitTx,
// then publicDataProvider.watchForTxData until the block is final
// (submitTxCore in @midnight-ntwrk/midnight-js-contracts 4.1.1). `instrument`
// wraps those providers so each step reports itself, which is how the tray
// knows a call is proving, waiting on the wallet or waiting for a block.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { MidnightProvider, ProofProvider, WalletProvider } from "@midnight-ntwrk/midnight-js-types";
import { errorMessage } from "@/lib/errors";

export const PHASES = ["preparing", "proving", "wallet", "sending", "confirming"] as const;
export type TxPhase = (typeof PHASES)[number];

export interface TxEntry {
  id: number;
  /** What's happening, as a verb phrase: "Submitting answer". */
  label: string;
  /** What it's about: the bounty's title. */
  subject: string;
  phase: TxPhase;
  state: "running" | "done" | "failed";
  startedAt: number;
  endedAt?: number;
  error?: string;
  /** Where to look at the result. */
  href?: string;
  retry?: () => void;
}

interface TxContextValue {
  entries: TxEntry[];
  /** Runs `fn` as a tracked transaction; resolves to its result, or rethrows its error. */
  track: <T>(label: string, subject: string, fn: () => Promise<T>, opts?: { href?: (r: T) => string; retry?: () => void }) => Promise<T>;
  /** Called by instrumented providers as the running call moves on. */
  report: (phase: TxPhase) => void;
  dismiss: (id: number) => void;
}

const TxContext = createContext<TxContextValue | null>(null);

export function TxProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<TxEntry[]>([]);
  const current = useRef<number | null>(null);
  const nextId = useRef(1);

  const patch = useCallback((id: number, change: Partial<TxEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...change } : e)));
  }, []);

  const report = useCallback(
    (phase: TxPhase) => {
      if (current.current !== null) patch(current.current, { phase });
    },
    [patch],
  );

  const track = useCallback<TxContextValue["track"]>(
    async (label, subject, fn, opts) => {
      const id = nextId.current++;
      current.current = id;
      // Newest first, and keep the tray short.
      setEntries((prev) => [
        { id, label, subject, phase: "preparing", state: "running", startedAt: Date.now() },
        ...prev.filter((e) => e.state === "running" || prev.indexOf(e) < 5),
      ]);
      try {
        const result = await fn();
        patch(id, { state: "done", endedAt: Date.now(), href: opts?.href?.(result) });
        return result;
      } catch (err: unknown) {
        patch(id, { state: "failed", endedAt: Date.now(), error: errorMessage(err, `${label} failed`), retry: opts?.retry });
        throw err;
      } finally {
        if (current.current === id) current.current = null;
      }
    },
    [patch],
  );

  const dismiss = useCallback((id: number) => setEntries((prev) => prev.filter((e) => e.id !== id)), []);

  const value = useMemo(() => ({ entries, track, report, dismiss }), [entries, track, report, dismiss]);
  return <TxContext.Provider value={value}>{children}</TxContext.Provider>;
}

export function useTx(): TxContextValue {
  const ctx = useContext(TxContext);
  if (!ctx) throw new Error("useTx must be used within a TxProvider");
  return ctx;
}

interface Steps {
  proofProvider: ProofProvider;
  walletProvider: WalletProvider;
  midnightProvider: MidnightProvider;
}

/** The same providers, reporting each step of a call to `report`. */
export function instrument<P extends Steps>(p: P, report: (phase: TxPhase) => void): P {
  return {
    ...p,
    proofProvider: {
      proveTx: (...args: Parameters<ProofProvider["proveTx"]>) => {
        report("proving");
        return p.proofProvider.proveTx(...args);
      },
    },
    walletProvider: {
      ...p.walletProvider,
      balanceTx: (...args: Parameters<WalletProvider["balanceTx"]>) => {
        report("wallet");
        return p.walletProvider.balanceTx(...args);
      },
    },
    midnightProvider: {
      submitTx: async (...args: Parameters<MidnightProvider["submitTx"]>) => {
        report("sending");
        const txId = await p.midnightProvider.submitTx(...args);
        report("confirming");
        return txId;
      },
    },
  };
}
