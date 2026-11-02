import { useMemo } from "react";
import { constantStore, externalStore, useStore, type Store } from "~/lib/store";

export type ProofServerStatus = "checking" | "ready" | "unreachable";

interface Probe {
  store: Store<ProofServerStatus>;
  recheck: () => void;
}

function probe(url: string, intervalMs: number): Probe {
  let check: (() => void) | null = null;
  const store = externalStore<ProofServerStatus>("checking", (set) => {
    let live = true;
    check = () => {
      let health: string;
      try {
        health = new URL("/health", url).toString();
      } catch {
        set("unreachable");
        return;
      }
      fetch(health, { mode: "no-cors", cache: "no-store" })
        .then(() => live && set("ready"))
        .catch(() => live && set("unreachable"));
    };
    check();
    const id = window.setInterval(check, intervalMs);
    return () => {
      live = false;
      check = null;
      window.clearInterval(id);
    };
  });
  return { store, recheck: () => check?.() };
}

const IDLE: Probe = { store: constantStore<ProofServerStatus>("checking"), recheck: () => {} };

/**
 * Whether a proof server answers at `url`, checked every `intervalMs`. It asks
 * for /health (what the spike benchmarks wait on). The request is no-cors: a
 * reply of any kind means the server is up, and the page only needs to know
 * that before it sends a proof there.
 */
export function useProofServer(url: string | null, intervalMs = 10_000): { status: ProofServerStatus; recheck: () => void } {
  const p = useMemo(() => (url ? probe(url, intervalMs) : IDLE), [url, intervalMs]);
  return { status: useStore(p.store), recheck: p.recheck };
}
