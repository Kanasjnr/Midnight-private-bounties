// The color theme: the system's, or one the user picked. The pick is a
// per-browser convenience in localStorage, applied to <html> as data-theme
// before the first render (main.tsx) so the page never flashes the other one.
import { storage } from "@/lib/storage";
import { useLocalValue } from "~/hooks/use-local-value";

export type Theme = "system" | "light" | "dark";
const KEY = "private-bounties-app:theme";

function read(v: string | null): Theme {
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(t: Theme): void {
  if (typeof document === "undefined") return;
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

/** Applies the remembered theme; call once before rendering. */
export function applySavedTheme(): void {
  applyTheme(read(storage.get(KEY)));
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [raw, write] = useLocalValue(KEY);
  return [
    read(raw),
    (t) => {
      write(t === "system" ? null : t);
      applyTheme(t);
    },
  ];
}
