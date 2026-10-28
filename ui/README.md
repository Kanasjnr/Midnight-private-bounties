# Private Bounties UI

Browser frontend for `examples/private-bounties`: the preimage bounty's flow
from the Node test (`src/test/bounty_preimage.test.ts`), behind a Midnight
wallet, with the poster in one wallet account and the solver in another.

| Who | Steps |
|---|---|
| Poster | deploy the test token → deploy a bounty contract → mint tokens → post a bounty (the wallet funds the reward) → decrypt the answer, or refund after the deadline |
| Solver | join by address → submit the answer → receive the reward. No reward tokens needed, only DUST for fees |

Scaffolded by `yarn new:ui private-bounties --contract bounty_preimage
--private-state persistent` from `templates/ui/`. See `AGENTS.md` next to this
file for which files are template-owned and which are yours, and for the
verification checklist.

## What this UI adds on top of the scaffold

- **Two contracts.** The UI was generated for `bounty_preimage`. The test
  token is wired in `src/midnight/private-bounties-api.ts` with its own
  `CompiledContract` and its own providers bundle
  (`useMidnightProviders().providersFor("managed/test_token")`). `copy:zk`
  serves both contracts' keys. The token address is kept in `localStorage`
  per network, next to the bounty contract address the template remembers.
- **Fresh coins as circuit arguments.** The DApp Connector can't list a
  wallet's coins, and doesn't need to. The coin a circuit receives describes
  the output the transaction creates for the contract, so the UI passes a
  fresh coin (random nonce) and the wallet funds it while balancing. The
  poster's reward is funded that way. The solver's coin is worth zero, so the
  wallet adds only fees.
- **Private state per wallet account and contract.** It holds an identity
  secret (the poster's pseudonym for each bounty is derived from it) and a
  poster seed (each bounty's encryption key is derived from it, see
  `contract/keys.ts`). Both are generated in the browser and kept in the
  encrypted store. The board finds "my bounties" by recomputing the
  pseudonym, so nothing else needs storing.
- **Answers.** An answer is up to 124 bytes of UTF-8, trimmed, packed into the
  four field elements the circuit hashes (`encodeAnswer`). The solver's answer
  goes into private state just before `submit` (the `answer` witness reads it
  there) and is cleared right after, whether the call worked or not.
- **Pre-checks.** Every solve, refund and decrypt check on the board comes
  from `actionError`, which `src/__tests__/private-bounties-circuits.test.ts`
  checks against the real compiled circuit, in memory, over the whole flow.
  A wrong answer is caught before anything is proved.
- **Proving.** The project's policy is to prove on a local proof server (spike
  Q10). The template defaults to wallet proving, so on a first visit, with no
  choice remembered yet, the panel switches to the local proof server once. A
  user who then picks wallet proving keeps it, and the panel shows a warning
  while it's selected: the wallet, and any hosted prover it uses, sees the
  proof's inputs, including the solver's answer. (The template's radio button
  still labels wallet proving "default"; that label is template-owned.)
- **A results log.** Every call is logged with its time (including the wallet
  approval), tx id and block, or the full error with its cause chain (a
  node's `1010 Custom error: N` included). It can be copied as JSON.

## Run

```bash
yarn workspace @midnight-ntwrk/example-private-bounties run compile   # contracts first
cd examples/private-bounties && yarn proof:up                           # local proof server
yarn workspace @midnight-ntwrk/example-private-bounties-ui dev           # http://localhost:5173
```

On Preview or Preprod, the wallet supplies the indexer and node endpoints,
so only the proof server runs locally. For a local devnet instead, run
`yarn env:up && yarn wait:dust` in `examples/private-bounties`, and give each
browser wallet DUST with `yarn fund:wallet <mn_dust_…> [mn_addr_…]`, run from
anywhere in the repo. The page prints the exact command when the connected
wallet has no DUST.

## Scripts

| Script | What it does |
|---|---|
| `dev` | copies ZK assets into `public/`, then runs Vite |
| `build` | copies ZK assets, typechecks, builds to `dist/` |
| `typecheck` | `tsc -b` |
| `test:unit` | vitest (jsdom + an in-memory circuit test) |

## TODO: end-to-end verification with a wallet

Partly run: the ticked items passed on Preview with 1AM on 2026-10-28 (see
`spike/q6-wallet/RESULTS.md`). Everything below needs a human to approve wallet prompts. What *has* been
verified is in `templates/ui/VERIFIED.md`, generated from this UI's
`verification.json`. When you run these, tick them off. Once all pass, set
`walletDeploy` and `walletCalls` to `verified` in `verification.json` (with the
date and what ran), run `yarn new:ui private-bounties --sync`, and delete this section.

Setup: `yarn proof:up` in `examples/private-bounties`, `yarn workspace
@midnight-ntwrk/example-private-bounties-ui dev`, and the network picker and
both wallet accounts on Preview. The proving settings show **Local proof
server** on a first visit. Account P posts, account S solves; both need DUST,
and S needs nothing else.

- [x] **Unlock:** P connects and sets a passphrase; the panel appears.
- [ ] A weak passphrase is refused with the policy reason.
- [x] **Token:** P deploys the test token, then the bounty contract, then
      mints 1,000 tokens. They show under "Your balances".
- [x] **Post:** P posts a bounty with a reward of 100 and a 60-minute
      deadline. The wallet funds the reward from the minted tokens; P's
      balance drops by 100 and the board shows it OPEN, "posted by you".
- [x] **Short deadline:** P posts a bounty with a short deadline (run with 20 minutes).
- [x] **Join:** S joins by address (a second wallet, profile or account) and
      sets its own passphrase. The board shows both bounties, neither as S's.
- [x] **Wrong answer:** S types a wrong answer; Solve stays disabled with
      "Wrong answer", and nothing is sent to the wallet.
- [x] **Solve:** S solves the first bounty. One wallet approval; the board
      shows it SOLVED, and S's balance gains exactly 100 once the wallet
      syncs, though S held none of the token before.
- [x] **Decrypt:** P decrypts and reads S's answer. S sees no decrypt button.
- [x] **Refund:** once the short deadline passes, P refunds that bounty; P's
      balance gains 100.
- [ ] After the deadline, S's Solve is refused.
- [x] **Re-join:** after switching accounts, P re-joins and can still refund and
      decrypt.
- [ ] **Reload:** P reloads, unlocks with the same passphrase, and can still
      decrypt. A wrong passphrase is refused.
- [ ] **Wallet proving:** with a throwaway answer, one post and one solve with
      **Wallet proves** selected (the warning shows).
- [ ] **Other wallet:** the post, solve and refund with the other wallet (Lace
      or 1AM).
- [ ] **Preprod:** the post, solve and decrypt on Preprod.
