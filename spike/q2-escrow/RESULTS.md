# Spike Q2: escrow on a real network

`bounty_escrow.compact` deployed to a local devnet and driven end to end with real proofs and
real transactions: 8 of 8 tests passed in 1,359 s.

## Setup

- Compact 0.31.1 (`compact compile +0.31.1`), language version 0.23.
- Devnet from `examples/shielded-chips/compose.yml`: `midnight-node:1.0.0`,
  `indexer-standalone:4.3.3`, `proof-server:8.1.0`.
- midnight-js 4.1.1 and wallet SDK 1.2.0, with the harness from a midnight-examples checkout
  (`example-fast-sync` wallets, `example-coins` helpers). The test files here run inside such a
  checkout as `examples/bounty-escrow-spike`.
- Three local genesis wallets: Alice (poster), Bob (solver), Charlie (second solver and
  non-poster). A test token is minted by the contract itself.
- Every coin a circuit receives is `freshCoin(...)`, with a random nonce the wallet pays for.

One harness fix: the wiring in `index.ts` uses `fileURLToPath(import.meta.url)` rather than
`new URL(import.meta.url).pathname`. The latter keeps `%20` for a space in the folder path, so the
proving keys weren't found.

## Circuit sizes

| Circuit | k | Prover key |
|---|---|---|
| `submit`, `submitOneTx` | 16 | 19 MB |
| `postBounty`, `stake`, `refund`, `withdrawStake` | 15 | 9.7 MB |
| `mintTestTokens` | 14 | 5.0 MB |

For comparison, Q1's checker plus key exchange plus encryption was k = 11. The escrow dominates:
every coin operation hashes coin commitments and nullifiers with `persistentHash` (SHA-256)
inside the standard library.

## Transaction times

Wall-clock time per call, from building the transaction to it landing. This covers proving,
balancing and inclusion, measured on a heavily loaded Intel i5 MacBook.

| Call | Time |
|---|---|
| deploy | 23 s |
| mint (3 calls) | 31 to 45 s |
| `postBounty` (5 calls) | 41 to 67 s |
| `stake` (5 calls) | 48 to 132 s |
| `submit` | 130 s, 134 s |
| `submitOneTx` | 101 s |
| `refund` | 43 s |
| `withdrawStake` | 42 s, 82 s |
| Rejected calls (assertion fails before proving) | 1 to 2 s |

## Checks

| Bounty | Check | Result | Observed |
|---|---|---|---|
| B1 | Escrow coin nonce is public (v1 design) | expected | nonce and value 100 readable in `escrows` |
| B1 | Submit before deadline pays the solver | pass | balance 40 to 140 (+100 net: stake back + reward) |
| B1 | Payout is one coin of reward + stake | pass | coin of 110 found in the solver's wallet |
| B1 | Delivery written, status updated | pass | `deliveries` = 4242, status SOLVED, escrow removed |
| B1 | Stake coin nonce absent from public state | pass | not found in any of 10 byte fields |
| B1 | Payout coin nonce absent from public state | pass | not found |
| B1 | Payout nonce differs from the public escrow nonce | pass | different |
| B1 | Solver and poster wallet coin public keys absent | pass | not found |
| B1 | Solver's secret key absent | pass | not found |
| B2 | Submit with a wrong stake opening | rejected | `failed assert: Stake does not match commitment` |
| B2 | State unchanged afterwards | pass | status OPEN, escrow present, no delivery, stakes unchanged |
| B3 | Refund before the deadline | rejected | `failed assert: Deadline has not passed` |
| B3 | Submit after the deadline | rejected | `failed assert: Deadline has passed` |
| B3 | Refund by a non-poster | rejected | `failed assert: Only the poster can refund` |
| B3 | State unchanged after those rejections | pass | status OPEN, escrow present, no delivery |
| B3 | Poster refund after the deadline | pass | poster +100, status REFUNDED |
| B3 | Solver withdraws stake from a refunded bounty | pass | solver +10 |
| B4 | Two solvers submit at once | **not tested on chain** | see below |
| B4 | Winner paid, delivery written once | pass | winner +110, one delivery, status SOLVED |
| B4 | Other solver withdraws stake from a solved bounty | pass | +10 |
| B5 | `submitOneTx`: same-transaction coin merged first | pass | solver net +100, status SOLVED, no effects-budget error |
| all | Indexer shows the circuit name per transaction | yes | `postBounty`, `stake`, `submit`, `refund`, `withdrawStake`, `submitOneTx`, `mintTestTokens` |

**About B4.** Both solvers' calls ran in one process, and the level private-state provider uses
one on-disk database. Bob's call failed on the client with `IO error: lock
midnight-level-db/LOCK: already held by process` before it was proved or submitted. Charlie's call
went through. So B4 confirms the winner path and the loser's stake withdrawal, but **not** how the
chain handles two conflicting submits. That needs two processes, or separate store directories.

## Verdicts

**Q2: what's public. Pass, as designed.** In an open bounty the escrow coin (nonce, value,
tree index) is public, which is expected and fine for an advertised reward. The poster's
pseudonym, the deadline, the status, the stake commitments and the delivery are public. Not
public:
- the stake coin's nonce;
- the payout coin's nonce, which also differs from the escrow nonce, so the stake-first merge
  works on chain;
- either party's wallet coin key;
- the solver's secret.

The indexer exposes which circuit each transaction called.

**Q3: one transaction. Pass.** A coin received in the same transaction can be the first input to
`mergeCoin`, and the payout went through with no effects-budget error. The solver doesn't need a
separate `stake` transaction.

**Q5: atomicity. Partly answered.** Every invalid call checked here (wrong stake opening, late
submit, early refund, non-poster refund) is rejected when the circuit runs on the client, in 1 to
2 seconds, before anything is proved or submitted. The public state was unchanged after each one.
A conflict that only shows up on chain, two valid submits racing, wasn't exercised (see B4).

**Q7: block time. Seconds since the Unix epoch.**
- A deadline of now + 3,600 s let `submit` through, both locally and on chain. In milliseconds that
  number would be a moment in January 1970, and the chain would have rejected it.
- A deadline of now + 360 s rejected an early refund. After it passed, it rejected a late submit
  and accepted the poster's refund.
- `compact-runtime` gives circuits `Math.floor(Date.now() / 1000)` locally, so a late call fails
  on the client before it costs anything.

## What changes in the design

- **One-transaction submit.** Q3 passed, so the solver flow can drop the separate stake step.
  The payout privacy of `submitOneTx` wasn't leak-checked in this run; check it before relying on it.
- **Escrow drives the cost, not the crypto.** A full `submit` (checker, key exchange, encryption
  and escrow) will be at least k = 16, and about 2 minutes per transaction on this machine.
- **Which action someone took is public.** The circuit name shows on the indexer, so the docs'
  privacy table should say so.
- **The UI should run each wallet's calls in sequence** and keep one private-state store per user,
  or concurrent calls can collide on the local database.

## Scope

Local devnet only, on a loaded laptop. Times will differ on other machines and networks. B4 needs
a rerun with two processes to cover on-chain conflicts.
