// Reading boards with no wallet connected. A wallet normally hands the app its
// indexer, so without one the app uses the network's public indexer, where
// there is one without an API key: Preview, and the local devnet.
// Preprod and Mainnet go through Blockfrost, which needs a project ID, so
// browsing those still needs a wallet.
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { PublicDataProvider } from "@midnight-ntwrk/midnight-js-types";

const INDEXERS: Record<string, { http: string; ws: string }> = {
  preview: {
    http: "https://indexer.preview.midnight.network/api/v4/graphql",
    ws: "wss://indexer.preview.midnight.network/api/v4/graphql/ws",
  },
  undeployed: { http: "http://127.0.0.1:8088/api/v4/graphql", ws: "ws://127.0.0.1:8088/api/v4/graphql/ws" },
};

/** The network's public indexer endpoint (GraphQL over HTTP), if it has one. */
export function publicIndexerUrl(network: string): string | null {
  return INDEXERS[network]?.http ?? null;
}

export function canBrowse(network: string): boolean {
  return network in INDEXERS;
}

const cache = new Map<string, PublicDataProvider>();

/** The network's public indexer, or null where browsing needs a wallet. One per network, so its stores stay stable. */
export function readOnlyIndexer(network: string): PublicDataProvider | null {
  const i = INDEXERS[network];
  if (!i || typeof window === "undefined") return null;
  let p = cache.get(network);
  if (!p) {
    setNetworkId(network);
    p = indexerPublicDataProvider(i.http, i.ws, window.WebSocket as unknown as Parameters<typeof indexerPublicDataProvider>[2]);
    cache.set(network, p);
  }
  return p;
}
