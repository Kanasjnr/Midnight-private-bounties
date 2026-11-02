import { useEffect, useState } from "react";

export type ProofServerStatus = "checking" | "ready" | "unreachable";

/**
 * Whether a proof server answers at `url`, checked every `intervalMs`. It asks
 * for /health (what the spike benchmarks wait on). The request is no-cors: a
 * reply of any kind means the server is up, and the page only needs to know
 * that before it sends a proof there.
 */
export function useProofServer(url: string | null, intervalMs = 10_000): { status: ProofServerStatus; recheck: () => void } {
  const [status, setStatus] = useState<ProofServerStatus>("checking");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const check = () => {
      let health: string;
      try {
        health = new URL("/health", url).toString();
      } catch {
        setStatus("unreachable");
        return;
      }
      fetch(health, { mode: "no-cors", cache: "no-store" })
        .then(() => !cancelled && setStatus("ready"))
        .catch(() => !cancelled && setStatus("unreachable"));
    };
    setStatus("checking");
    check();
    const id = window.setInterval(check, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [url, intervalMs, tick]);

  return { status, recheck: () => setTick((t) => t + 1) };
}
