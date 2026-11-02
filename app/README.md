# Private Bounties app

The project's own frontend, in Midnight's palette and built from the design
canvas. `../ui` stays the plain, template-generated page (the one spike Q6 ran
on, and the one that can move into midnight-examples). This app reuses
`../ui/src` instead of copying it:

| From `../ui/src` (`@/…`) | What for |
|---|---|
| `providers/wallet-context.tsx`, `providers/midnight-providers.tsx` | Wallet connection, the providers bundle, the passphrase-locked private-state store |
| `hooks/use-deployment.ts`, `use-contract-state.ts`, `use-wallet-balances.ts`, `use-dust-balance.ts` | Join or deploy a board, the live ledger, balances |
| `midnight/private-bounties-api.ts` | Every contract call and pre-check (`postNewBounty`, `submitAnswer`, `readAnswer`, `refund`, `actionError`, `postError`), tested against the compiled circuits |

The app's own code is under `~/…` (`src/`).

## Screens

| Route | Screen |
|---|---|
| `#/` | The board: totals, open and closed bounties, search and sort, what needs you, proving status |
| `#/setup` | The five-step checklist: wallet, private store, proof server, DUST, board (join by address, or deploy a token and a bounty contract, then mint test tokens) |
| `#/post` | Post a preimage bounty: details, then a review of what goes on chain |
| `#/b/<board>/<id>` | One bounty. Solvers check their answer as they type, then prove and submit; posters decrypt the answer here, or claim the refund |
| `#/mine` | Bounties posted from this browser, and the ones it solved |

Every transaction shows in the tray at the bottom right, step by step:
running the circuit, proving, wallet approval, sending, waiting for a block.
The steps come from wrapping the providers (`src/tx.tsx`), in the order
midnight-js 4.1.1 calls them. A failed call says whether anything could have
been sent, and offers a retry (spike Q6 saw first attempts fail in the wallet
and pass on retry).

## What it adds on top of the api file

- **Listing text is treated as untrusted** (second audit, S1). Titles and
  questions are shown with bidi overrides, zero-width and control characters
  removed (`src/lib/sanitize.ts`), and the page says when it removed some. A
  bounty whose text copies an earlier one is flagged on the board. Anyone can
  hide a bounty from their own board (kept in this browser only).
- **Posting checks the answer before it's published.** The strength note warns
  when the answer is short enough to find by hashing guesses, and posting is
  blocked when another bounty on the board has the same answer hash.
- **Decrypted answers are re-checked** against the hash the bounty was posted
  with.
- **Per-browser marks** in localStorage, per network and board: hidden
  bounties, answers already read, bounties solved here. Losing them loses
  only the marks, never keys or funds.
- **Local proving by default** (spike Q10), as in `../ui`. Wallet proving is
  one click away in setup, with the warning shown wherever it applies.
- **Fonts are self-hosted** (Fontsource), so the page makes no request to a
  font CDN.

## Not yet

The factor and signed-record templates, reviewed-work bounties, the inbox, the
activity feed from the indexer (Q14), key backup, light mode and browsing
without a wallet. Its store is separate from `../ui`'s: a different port is a
different origin, so keys made on one page don't show on the other.

## Run

`app/` isn't covered by the examples repo's workspace globs, so add
`"examples/*/app"` to the root `package.json` workspaces there and run
`yarn install` (CI does the same). Then:

```bash
yarn workspace @midnight-ntwrk/example-private-bounties run compile    # contracts, with keys
cd examples/private-bounties && yarn proof:up                            # local proof server
yarn workspace @midnight-ntwrk/example-private-bounties-app dev         # http://localhost:5174
```

| Script | What it does |
|---|---|
| `dev` | copies ZK assets into `public/`, then runs Vite on port 5174 |
| `build` | copies ZK assets, typechecks, builds to `dist/` |
| `typecheck` | `tsc -b` |
| `test:unit` | vitest: the board logic, formatting, text cleaning, routes, and the transaction tracker |

## Verification

Typecheck, unit tests and the production bundle pass. Nothing has run
against a wallet yet: the post, solve, decrypt and refund flow needs a run on
Preview with two wallet accounts, as `../ui` had in spike Q6.
