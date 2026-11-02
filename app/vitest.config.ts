import path from "node:path";
import { defineConfig } from "vitest/config";

// Unit tests only: jsdom, no wallet, network or proof server.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../ui/src"),
      "~": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
