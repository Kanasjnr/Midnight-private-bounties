# Spike Q6: a real wallet through the DApp Connector

**Question:** can a browser wallet balance and submit the bounty transactions, including one that
pays a shielded reward in (`postBounty`) and one that pays it out (`submit`, `refund`)?

**Answer: yes, with 1AM on Preview.** Every step of the preimage bounty landed: deploy, mint,
post, solve with a zero-value coin, decrypt and refund. The wallet funded the reward escrow from
the poster's shielded tokens, and the solver's wallet received the payout. Two first attempts
failed inside the wallet and passed on retry (see "Problems seen"). Lace hasn't been run yet.

## Setup

- The page is the UI in [`ui/`](../../ui), generated with midnight-examples' `yarn new:ui`
  against `bounty_preimage` with persistent private state. It ran under Vite in a
  midnight-examples checkout pinned at `3498bd1`.
- Preview: node `1.0.400-87c0fbdb`, runtime specVersion 1000300, indexer API v4 (checked
  2026-10-27).
- Wallet: 1AM, with two accounts in one Chrome profile: the poster (P) and the solver (S).
- Proving: the local proof server, `proof-server:8.1.0` in Docker on `127.0.0.1:6300`.
- Stack: Compact 0.31.1, midnight-js 4.1.1, DApp Connector API 4.0.1.
- Machine: a heavily loaded Intel i5 MacBook, with a load average of about 70 before the run.

## Results (2026-10-28)

Each step's time runs from the click to the transaction being final. It includes the wallet
approval, local proving and inclusion. Every transaction below was read back from the Preview
indexer with status `SUCCESS` at the block shown.

| Step | Who | Result | Block | Time |
|---|---|---|---|---|
| Deploy the test token | P | ✓ | not logged | 79.2 s |
| Deploy the bounty contract | P | ✓ | 1491370 | 69.5 s |
| Mint 1,000 test tokens | P | ✗, then ✓ on retry | 1491409 | 67.4 s, then 62.1 s |
| Post a bounty: reward 100, 20 minutes | P | ✗, then ✓ on retry | 1491466 | 97.8 s, then 79.4 s |
| Refund it after the deadline | P | ✓ | 1491802 | 65.2 s |
| Post a bounty: reward 100, 60 minutes | P | ✓ | 1491825 | 81.0 s |
| Submit the answer with a zero-value coin | S | ✓ | 1491862 | 156.5 s |
| Decrypt the delivery | P | ✓ | in the browser | 0.1 s |

Contracts: bounty `04713ab8f8e99c95d87889a11b239aeb5acccc5f8a192f2d33a96838092fd32e`, test token
`adf95575ae5096c53dedcd371afb938b48232a7b287c7f5bde9a3284096e5850`.

| Step | Transaction |
|---|---|
| Deploy the bounty contract | `0034d1ef08a069e47c42571582d04674e1da0c0f1ff99c7041a9c2d3742c499f4f` |
| Mint | `0098ba9441c30cd7b226777d6344c698874206bb459a11edf609c774a3611ca917` |
| Post (20 minutes) | `00f75364b99634484d130b12f2dcc531921e2bb80f5f8c58bfc2d00ef2f391720d` |
| Refund | `006c8286054dee8a5ffdbb28109ab1bafc8c6e30be7e98a80fc72fc299805adad1` |
| Post (60 minutes) | `005096db4104c27955a7c54fb4befe8a246ff08d975d3389a0498986f893e592e2` |
| Submit | `00b8f1a725cfe28d051ec2cc74ed6715e88d649224dd8b09922f6d87f18d766067` |

## What it shows

- **The wallet pays a shielded reward in.**
  - The page passes a fresh coin (random nonce) as the reward, and 1AM funded it from P's tokens
    while balancing.
  - P's shielded balance went from 1,000 to 900, and the contract's escrow map held a 100-token
    coin of the reward color.
  - midnight-examples' `templates/ui/VERIFIED.md` listed a wallet supplying a shielded-coin input
    while balancing as never run with any wallet.
- **The solver needs nothing but DUST.**
  - S held none of the reward token, and submitted with a zero-value coin (Q12).
  - 1AM balanced the transaction with fees only. Afterwards, S's shielded balance showed exactly
    100.
  - The payout goes to the caller's own coin key. midnight-js encrypts it with the wallet's own
    encryption key, so the wallet found it with no extra wiring.
- **The refund pays the poster.** P's balance went from 900 back to 1,000.
- **Wallet balances match the app's token color.** 1AM keys its shielded balances by the same hex
  color the page computes with `rawTokenType`, so the balance card could name the token. That was
  also on upstream's never-run list.
- **Private state survives re-joining (Q8).** The encrypted IndexedDB store kept P's identity
  secret and poster seed while the page switched between the two accounts. After re-joining, the
  refund (which needs the secret) and the decrypt (which needs the seed) both worked.
- **A wrong answer never reaches the wallet.** The page checks the answer with the pure checker
  first, and Solve stayed disabled with "Wrong answer".
- **The public ledger after the run is what the design says.**
  - The two bounties have different poster pseudonyms and encryption keys (audit H2).
  - The delivery is only `ephemeralPk` and four ciphertext elements.
  - The escrow map is empty.
  - Both bounties show the same `target`, because the same answer was used twice. The target is
    the answer's public hash.
- **Failed attempts left nothing behind.** The ledger holds only the two bounties that were
  posted, and P's balance reflects one mint.

## Problems seen

1. **Wallet proving with 1AM failed at setup.**
   - The page's first provider build used the template's default, wallet proving, before the
     panel switched to the local proof server. That build failed with the DApp Connector error
     `Request failed (InternalError)`.
   - After a reload, local mode never asks the wallet for a proving provider, and setup worked.
   - So the failing call was most likely 1AM's `getProvingProvider`, but it wasn't isolated.
2. **Two first attempts failed inside the wallet, and both passed on retry.**
   - The mint failed in balancing: `Balance failed: Encountered unexpected error: An unknown
     error occurred`.
   - The first post failed at submission: `Transaction submission error: (FiberFailure)
     SubmissionError`.
   - They started 44 s and 2.4 minutes after the previous transaction finished. A later post that
     started 57 s after the refund went through first time, so timing alone doesn't explain it.
   - The cause is unknown: the error is raised inside the extension, without the node's `1010`
     code.
3. **Two attempts to join failed with `Failed to fetch`** (11 s and 180 s), then took 2–3 s. That
   is a browser-level network failure, either the indexer or the page's own assets, and it wasn't
   isolated.

## Consequences for the UI

- Every call shows the error and offers a retry of the same step. A retry builds a fresh coin and
  a fresh bounty ID, and the failed attempts here left nothing on the ledger.
- Show progress while a call runs. In this run a submit took 2.5 minutes end to end.
- Prove locally by default (Q10). The page switches a first visit to the local proof server,
  because the template defaults to wallet proving.
- Warn about weak answers. The target is the answer's public hash, so a short answer can be found
  by hashing guesses, and the same answer used twice links the two bounties.

## Not covered yet

- **Lace.** The test account had no DUST on Preview.
- **Wallet proving** (problem 1).
- A wrong passphrase being refused, and a full page reload rather than a re-join. midnight-examples
  checked both for the same store in its battleship UI.
- **Preprod.**
- Two solvers racing from browsers. That is covered on the devnet (Q5).
