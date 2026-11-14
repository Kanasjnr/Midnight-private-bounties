# Spike Q16: does the preimage bounty work on Ledger 9?

**Question:** Mainnet and Preview moved to Ledger 9 on 2026-11-06, and Preview was reset as a new
chain. Our contracts and app are built for Ledger 8 (compiler 0.31.1, runtime 0.16.0, Midnight.js
4.1.1), which those networks no longer accept. What does the move to the Ledger 9 stack (compiler
0.36.0, runtime 0.21.0, Midnight.js 5.0.0, wallet SDK 2.0.0, proof server 9.0.0) take, and does the
escrow still pay out? Ledger 9 has an open issue for spending a held shielded coin and writing
change back (`Custom error: 104`,
[midnight-ledger#839](https://github.com/midnightntwrk/midnight-ledger/issues/839)), and our
`submit` merges the escrowed coin with the solver's coin before paying it out.

**Answer: yes.** On Preview, the preimage bounty compiled with 0.36.0 deployed, took a reward into
escrow, paid a solver with the merged coin in one transaction (the poster decrypted the answer), and
refunded a second bounty after its deadline. The contract changes are mechanical; the bigger costs
are in the JS API and in key size.

> **Correction, 2026-11-14.** This report first said the coin issue couldn't reach us because our
> escrow pays a coin out in full. That was wrong. #839 is the client under-declaring the bytes a
> contract writes when it *stores* a coin (the node stores the coin's real commitment-tree position),
> and `postBounty` stores the reward coin. In a later Preview run of the full devnet suite, one
> `postBounty` was rejected with `Custom error: 104`. It depends on the tree position, which is why
> the posts here landed. The fix was validated upstream on 2026-11-13 and ships so far only in
> release candidates (`ledger-v9` 1.0.2-rc.0, Midnight.js 5.0.1-rc.1). The same runs found a second
> problem: in the two-solver race, both submits failed at the proof server's check step; the cause
> isn't known yet.

## Setup

- Compiler 0.36.0 (language 0.28), installed with `compact update 0.36.0 --no-set-default`, and
  compiled with `compact compile +0.36.0`. The default stays 0.34.0.
- A scratch checkout of midnight-examples at `377495c` (its Ledger 9 migration, #88), with the
  harness of its migrated `shielded-chips` example: `config.ts`, `wallet.ts` and `coins.ts` as they
  are, `providers.ts` with the names changed. Everything is in [example/](example/).
- Proof server 9.0.0 (`midnightntwrk/proof-server:9.0.0`) on this laptop.
- Two throwaway Preview wallets from midnight-examples' `npm run wallets:new`, funded at the
  faucet. Their seeds stayed in that checkout's gitignored `.env.preview`.
- Run 2026-11-08 with `MIDNIGHT_NETWORK=preview vitest run src/test/q16.test.ts`. The log, with the
  wallet lines left out, is [preview-run.log](preview-run.log).

## Contract changes

All five contracts compile on 0.36.0 after three kinds of change, in
[contract-changes.diff](contract-changes.diff):

| Change | Where | Why |
|---|---|---|
| `pragma language_version 0.23` to `0.28` | every contract | 0.36.0 is language 0.28 and the pragma is exact: `language version 0.28.0 mismatch` |
| `x as JubjubScalar` on curve scalars (5 casts) | `ecdh.compact`, `schnorr.compact` | `ecMul` and `ecMulGenerator` now take a typed scalar (`JubjubScalar`, `Secp256k1Scalar`, `Secp256r1Scalar` or `Curve25519Scalar`), not a `Field`. The cast reduces modulo the Jubjub order, which leaves our points unchanged: our scalars are already below it. midnight-examples' zk-loan does the same |
| `i as Field` on keystream indexes (8 casts) | `stream_cipher.compact` | An integer literal is a `Uint<0..1>`, and is no longer widened to a `Field` argument on its own |

## JS changes (runtime 0.21, Midnight.js 5)

Found while porting the harness and an in-memory test ([q16.sim.test.ts](example/src/test/q16.sim.test.ts)):

- The constructor (`initialState`) and every impure circuit **return a Promise**. Pure circuits
  (`decrypt`, `answerHash`, `posterPublicKey`, `bountyIdFor`) are still synchronous.
- `createCircuitContext` takes **one options object** (`circuitId`, `contractAddress`,
  `coinPublicKeyOrZswapState`, `contractState`, `privateState`, and an optional `time`).
- A circuit's new state is at `result.context.callContext.currentQueryContext.state`.
- Imports move to versioned subpaths: `@midnight-ntwrk/midnight-js-protocol/v9/compact-runtime` and
  `/v9/compact-js`.
- Providers: `privateStateProvider.forContract(address)` replaces `setContractAddress`; the wallet
  and node are wrapped with `createLedger9WalletProvider` and `createLedger9MidnightProvider`; the
  network goes in `config: { networkId, ttlSeconds }`; `queryContractState` returns an era-tagged
  state to decode with `ContractState` from `/v9`.
- The wallet SDK package is `@midnightntwrk/wallet-sdk` 2.0.0 (no hyphen in the scope).

## Results on Preview

| Step | Result | Wall time |
|---|---|---|
| Deploy the test token | ✅ | 24.6 s |
| Deploy the bounty contract | ✅ | 24.5 s |
| Mint to Alice / Bob | ✅ | 48.3 s / 47.0 s |
| Post (reward into escrow) | ✅ | 54.5 s and 77.9 s |
| **Submit: the solver's fresh coin merged first with the escrowed coin, paid out in one transaction** | ✅ Bob's balance rose by exactly the reward; status `SOLVED`; the poster decrypted the answer from the delivery | 142.4 s |
| Refund after the deadline | ✅ Alice's balance rose by exactly the reward; status `REFUNDED` | 89.1 s |

Each time is end to end: proving on the local proof server, balancing, submitting, and waiting for
the transaction, on a heavily loaded laptop. On Ledger 8 the same calls took 100 to 134 s for
`submit` and 40 to 67 s for `postBounty` and `refund`, on a local devnet
([Q2](../q2-escrow/RESULTS.md)). The numbers are of the same order; they aren't a benchmark of
either.

## Key size

ZKIR v3 prover keys are about 4.5 times larger:

| Circuit | Ledger 8 (0.31.1) | Ledger 9 (0.36.0) |
|---|---|---|
| `submit` | 21.6 MB | 98.6 MB |
| `postBounty` | 11.0 MB | 49.3 MB |
| `refund` | 10.0 MB | 49.3 MB |
| test token `mint` | 5.2 MB | 22.5 MB |

Verifier keys stay about 2.3 KB. A browser downloads the prover key the first time it proves a
circuit, so the app has to show that download.

## Found on the way

- **midnight-examples' `wallets:new` fails on Preview** after the reset: its fast-sync bundle in
  `preseed/preview` is from the old chain (height 1,474,876, against a new tip of 24,069), and the
  script refuses to write wallets that "could never be fast-synced from it". Moving the bundle aside
  in the scratch checkout let it write wallets that sync from genesis. Each synced in about 2
  minutes (the new chain is short); Alice then waited 16 minutes for her newly registered NIGHT to
  generate the 60 DUST the harness waits for before it transacts.
- Node's npm 10 warns that the repo wants npm 11.10 or later (`devEngines`); `npx npm@11.21.0 ci`
  installs cleanly.

## Consequences

- **The design holds on Ledger 9.** The escrow, the merged payout, refunds, per-bounty keys and
  in-circuit decryption all work unchanged. Nothing in the contracts' logic moves.
- **Contracts:** the three mechanical changes above, then new keys for every circuit.
- **Tests and app:** every place that runs circuits in JS (the simulator tests, the app's tests that
  mirror the circuits' asserts) becomes async and builds its context with the options object. Every
  provider, the key backup (`forContract`) and the transaction tracker move to Midnight.js 5.
- **Downloads:** about 100 MB for a first `submit`. The app shows progress for it.
- **CI:** midnight-examples' local devnet isn't on Ledger 9 yet, so Ledger 9 network tests run on
  Preview, with funded wallets whose seeds are repository secrets.

## Not covered yet

- The factor, signed-record and reviewed-work templates on Preview. They compile, and they use the
  same escrow, so they're expected to behave the same; they get run in the migration itself.
- Circuit sizes (k) under ZKIR v3, and proving time alone on an idle runner.
- Events, the Ledger 9 feature the activity feed could use instead of comparing states.
