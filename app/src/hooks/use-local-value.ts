import { useMemo } from "react";
import { storage } from "@/lib/storage";
import { externalStore, useStore, type Store } from "~/lib/store";

// One store per localStorage key, so every component reading a key sees a
// write at once. Values are strings, which compare by value, so an unchanged
// key never rerenders anyone.
const stores = new Map<string, { store: Store<string | null>; set: (v: string | null) => void }>();

function entry(key: string) {
  let e = stores.get(key);
  if (!e) {
    let publish: ((v: string | null) => void) | null = null;
    const store = externalStore<string | null>(storage.get(key), (set) => {
      publish = set;
      set(storage.get(key));
      return () => {
        publish = null;
      };
    });
    e = {
      store,
      set: (v) => {
        if (v === null) storage.remove(key);
        else storage.set(key, v);
        publish?.(v);
      },
    };
    stores.set(key, e);
  }
  return e;
}

/** A localStorage value, and a way to change it (null removes it). */
export function useLocalValue(key: string): [string | null, (v: string | null) => void] {
  const e = entry(key);
  return [useStore(e.store), e.set];
}

/**
 * A set of strings kept in localStorage under `key`: per-browser marks like
 * "hidden", "answer read" or "solved here". Losing it loses only the mark,
 * never funds or keys, so browser storage is fine for it.
 */
export function useLocalSet(key: string): { set: ReadonlySet<string>; add: (v: string) => void; remove: (v: string) => void } {
  const [raw, write] = useLocalValue(key);
  const set = useMemo(() => {
    try {
      const v = JSON.parse(raw ?? "[]") as unknown;
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set<string>();
    }
  }, [raw]);
  return useMemo(
    () => ({
      set,
      add: (v: string) => write(JSON.stringify([...new Set([...set, v])])),
      remove: (v: string) => write(JSON.stringify([...set].filter((x) => x !== v))),
    }),
    [set, write],
  );
}
