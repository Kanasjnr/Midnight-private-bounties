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
| `#/post` | Choose the kind: reviewed work or a verified answer |
| `#/post/answer` | Post a verified answer: pick the template (preimage, factor or signed record), fill in its checker (the answer, N, or the issuer, record type, field and threshold), then review |
| `#/post/work` | Post reviewed work: the reward, who works on it (applicants or first to claim), the delivery and review windows, the final deadline, an optional arbiter, then a review |
| `#/b/<contract>/<id>` | One verified-answer bounty, of any template. Solvers check their answer (a phrase, two factors, or a signed-record file) in the browser, then prove and submit; posters decrypt what was sent here, or claim the refund |
| `#/issue` | For issuers: make a signing key, sign records into files for their holders |
| `#/w/<contract>/<id>` | One piece of reviewed work, by role. Anyone applies (an application code) or claims; the assigned contributor submits a link and collects; the poster reads applications, assigns, releases a claim, decrypts the link, approves or rejects, and takes back an unearned reward; the arbiter overturns a rejection; anyone reopens work whose window ran out |
| `#/mine` | Posted by you, working on, and paid to you here, with what needs you first |

A board is up to four contracts paying in the same token: the preimage,
reviewed-work, factor and signed-record templates. Its code is their
addresses joined by dots in that order, with empty places for ones it doesn't
have (a single address, or two, still works). Setup joins them all from the
code, or deploys the missing ones next to the first. Each contract after the
first lives in a slot (`src/hooks/use-contract-slot.ts`): its providers, join
and live state, built from stores.

**Signed records.** A record is four numbers: its type, then three fields.
The type is an app convention: its name, as UTF-8, is the first number, and
known types name their fields ("Bank statement v1": amount, issued at,
subject). The contract only checks that the first number matches the
bounty's. An issuer signs with the same Schnorr signing as
`contract/signing.ts`, in the browser, and hands the holder a JSON file with
the record, the issuer's key and the signature.

**Application codes.** In applicant mode, the applicant writes a plan (and,
if they want, a name and links). The page encrypts it to the poster's key for
that bounty and turns it into a code the applicant sends however the
description says. The key comes from the template's pure `applicationKey`,
and AES-GCM in the browser does the encryption, with the bounty ID bound in.
The poster pastes the code to read it and assign. Nothing about an
application goes on chain.

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
- **Key backup** (`#/backup`, from the account menu). One file holds the
  private state of every contract on the board, exported by midnight-js and
  encrypted under the store's passphrase, plus the board code and token
  address. Restoring in a new browser imports the keys and joins the board.
  If that browser already joined, it asks before replacing its keys. The
  account menu shows a dot until the board's contracts are all in a backup
  made here. Tested against midnight-js's level store in
  `src/__tests__/backup.test.ts`.
- **Browsing without a wallet.** On Preview and the local devnet the board,
  bounty and work pages read straight from the network's public indexer
  (`src/midnight/read-only.ts`), with the actions replaced by a prompt to
  connect. Preprod and Mainnet indexers need a Blockfrost key, so there the
  wallet's indexer is still needed. The board card copies a link
  (`#/board/<network>/<code>`) that opens the board for anyone.
- **Recent activity** on the board, from the indexer's history of each
  contract (spike Q14, `src/midnight/activity.ts`): the last 15 actions per
  contract, each state decoded and compared with the one before to name the
  bounty it touched. It shows only what's public (titles, rewards, statuses),
  never who acted, and refreshes every 30 seconds. A state from an older
  contract version ends that contract's history there.
- **Local proving by default** (spike Q10), as in `../ui`. Wallet proving is
  one click away in setup, with the warning shown wherever it applies.
- **No effects.** Anything from outside React (the clock, the URL, browser
  storage, the ledger stream, balance polls, the proof server check) is a small
  store read with `useSyncExternalStore` (`src/lib/store.ts`), so only the
  components that read a value rerender when it changes. Countdowns tick in
  their own component; the rest of the page uses a 10-second clock.
- **Fonts are self-hosted** (Fontsource), so the page makes no request to a
  font CDN.

## Not yet

Contributor profiles beyond what an application includes (and verified GitHub), messages, the inbox and light mode. Its store is separate from `../ui`'s: a different port is a
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
| `test:unit` | vitest: the board logic, formatting, text cleaning, routes, the stores, the transaction tracker, and every template against its compiled contract: reviewed work (every pre-check against every circuit, application codes, the submitted link), factor and signed record (pre-checks against submit, a record issued in the app passing the signature check, decryption), and board codes |

## Verification

Typecheck, unit tests and the production bundle pass. Nothing has run
against a wallet yet: both kinds' flows need a run on Preview with two wallet
accounts, as `../ui` had in spike Q6.
