import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The same bundler setup as ../ui (see the comments in ../ui/vite.config.ts
// for why each plugin and exclusion is there). The app has its own design but
// reuses ../ui/src for the wallet, providers, private state and contract
// calls, so `@` points there, the way those files import each other, and the
// app's own files are under `~`.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
    topLevelAwait(),
    nodePolyfills({
      include: ["buffer", "process", "util", "crypto", "stream"],
      globals: { Buffer: true, process: true },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../ui/src"),
      "~": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    exclude: [
      "@midnight-ntwrk/ledger-v8",
      "@midnight-ntwrk/onchain-runtime-v3",
      "@midnight-ntwrk/midnight-js-protocol",
    ],
  },
  server: {
    fs: {
      // ../ui/src and ../contract/managed are outside this package's root.
      allow: [path.resolve(__dirname, "..")],
    },
  },
  build: {
    target: "esnext",
  },
});
