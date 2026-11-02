import { useEffect, useState } from "react";

/** Seconds since the Unix epoch, refreshed every `intervalMs`. Wall-clock time stands in for block time. */
export function useNow(intervalMs = 1_000): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = window.setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
