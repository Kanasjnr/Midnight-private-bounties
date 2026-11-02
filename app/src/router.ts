// Hash routes, so the page never reloads: a proof or a wallet approval in
// flight keeps going while you move around.
import { useMemo } from "react";
import { externalStore, useStore } from "~/lib/store";

export type Route =
  | { name: "board" }
  | { name: "mine" }
  | { name: "setup" }
  | { name: "post" }
  /** A bounty on the board at `address`, which may not be the one this browser has joined. */
  | { name: "bounty"; address: string; id: string };

const HEX = /^[0-9a-f]+$/;

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "mine") return { name: "mine" };
  if (parts[0] === "setup") return { name: "setup" };
  if (parts[0] === "post") return { name: "post" };
  if (parts[0] === "b" && parts.length === 3) {
    const [, address, id] = parts.map((p) => p.toLowerCase());
    if (address && id && HEX.test(address) && HEX.test(id) && id.length === 64) return { name: "bounty", address, id };
  }
  return { name: "board" };
}

export function href(route: Route): string {
  switch (route.name) {
    case "board":
      return "#/";
    case "bounty":
      return `#/b/${route.address}/${route.id}`;
    default:
      return `#/${route.name}`;
  }
}

export function go(route: Route): void {
  window.location.hash = href(route);
}

const hash = externalStore(window.location.hash, (set) => {
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
