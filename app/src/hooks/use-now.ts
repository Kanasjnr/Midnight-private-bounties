import { clockStore, useStore, type Store } from "~/lib/store";

const clocks = new Map<number, Store<bigint>>();

/**
 * Seconds since the Unix epoch, refreshed every `intervalMs`. Wall-clock time
 * stands in for block time. Only the component that calls it rerenders on a
 * tick, so live countdowns read a fast clock and everything else a slow one.
 */
export function useNow(intervalMs = 10_000): bigint {
  let clock = clocks.get(intervalMs);
  if (!clock) {
    clock = clockStore(intervalMs, (ms) => BigInt(Math.floor(ms / 1000)));
    clocks.set(intervalMs, clock);
  }
  return useStore(clock);
}
