import { useCallback, useEffect, useState } from "react";
import { storage } from "@/lib/storage";

/**
 * A set of strings kept in localStorage under `key`: per-browser marks like
 * "hidden", "answer read" or "solved here". Losing it loses only the mark,
 * never funds or keys, so browser storage is fine for it.
 */
export function useLocalSet(key: string): { set: ReadonlySet<string>; add: (v: string) => void; remove: (v: string) => void } {
  const read = useCallback((): Set<string> => {
    try {
      const v = JSON.parse(storage.get(key) ?? "[]") as unknown;
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }, [key]);
  const [set, setSet] = useState<Set<string>>(read);
  useEffect(() => setSet(read()), [read]);

  const write = useCallback(
    (change: (s: Set<string>) => void) =>
      setSet((prev) => {
        const next = new Set(prev);
        change(next);
        storage.set(key, JSON.stringify([...next]));
        return next;
      }),
    [key],
  );
  const add = useCallback((v: string) => write((s) => s.add(v)), [write]);
  const remove = useCallback((v: string) => write((s) => s.delete(v)), [write]);
  return { set, add, remove };
}
