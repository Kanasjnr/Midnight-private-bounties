import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { storage } from "@/lib/storage";
import { DEFAULT_PROOF_SERVER_URL } from "@/midnight/providers";
import { App } from "./App";
import { applySavedTheme } from "./theme";
import "./index.css";

// Spike Q10: every circuit has secret inputs, so prove on a local proof server
// unless the user has chosen otherwise. The template's providers context
// defaults to wallet proving and reads this key when it starts, so on a first
// visit (no choice remembered yet) write the local default before it does.
const PROVING_KEY = "private-bounties-ui:proving";
if (storage.get(PROVING_KEY) === null) {
  storage.set(PROVING_KEY, JSON.stringify({ mode: "local", proofServerUrl: DEFAULT_PROOF_SERVER_URL }));
}

applySavedTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
