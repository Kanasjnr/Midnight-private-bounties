// Hash routes, so the page never reloads: a proof or a wallet approval in
// flight keeps going while you move around.
import { useMemo } from "react";
import { externalStore, useStore } from "~/lib/store";

export type Route =
  | { name: "board" }
  | { name: "mine" }
  | { name: "setup" }
  | { name: "issue" }
  | { name: "backup" }
  | { name: "post" }
  | { name: "post-answer" }
  | { name: "post-work" }
  /** A bounty on the board at `address`, which may not be the one this browser has joined. */
  | { name: "bounty"; address: string; id: string }
  /** Reviewed work on the reviewed-work contract at `address`. */
  | { name: "work"; address: string; id: string };

const HEX = /^[0-9a-f]+$/;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "mine") return { name: "mine" };
  if (parts[0] === "setup") return { name: "setup" };
  if (parts[0] === "issue") return { name: "issue" };
  if (parts[0] === "backup") return { name: "backup" };
  if (parts[0] === "post") return parts[1] === "answer" ? { name: "post-answer" } : parts[1] === "work" ? { name: "post-work" } : { name: "post" };
  if ((parts[0] === "b" || parts[0] === "w") && parts.length === 3) {
    const [, address, id] = parts.map((p) => p.toLowerCase());
    if (address && id && HEX.test(address) && HEX.test(id) && id.length === 64) return { name: parts[0] === "b" ? "bounty" : "work", address, id };
  }
  return { name: "board" };
}

export function href(route: Route): string {
  switch (route.name) {
    case "board":
      return "#/";
    case "bounty":
      return `#/b/${route.address}/${route.id}`;
    case "work":
      return `#/w/${route.address}/${route.id}`;
    case "post-answer":
      return "#/post/answer";
    case "post-work":
      return "#/post/work";
    default:
      return `#/${route.name}`;
  }
}

export function go(route: Route): void {
  window.location.hash = href(route);
}

// Guarded so this module also loads outside a browser (the Node-run tests).
const hash = externalStore(typeof window === "undefined" ? "" : window.location.hash, (set) => {
  const onChange = () => {
    set(window.location.hash);
    window.scrollTo({ top: 0 });
  };
  set(window.location.hash);
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
});

export function useRoute(): Route {
  const h = useStore(hash);
  return useMemo(() => parseRoute(h), [h]);
}
