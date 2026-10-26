# Spike Q11 and Q9: the full `submit`

`full_submit.compact` puts the real `submit` in one circuit: Q1's checker, Jubjub key exchange and
keystream encryption, plus Q2's one-transaction escrow (receive the solver's fresh coin, merge it
first, pay out). It also stores `JubjubPoint`s inside the struct values of ledger maps (Q9).

Compact 0.31.1 (`compact compile +0.31.1`), language version 0.23, `compact-runtime` 0.16.0,
`ledger-v8` 8.1.3, local `proof-server:8.1.0`. The full compile with keys took 54 s.

## Circuit size

| Circuit | k | ZKIR ops | Prover key | Notable operations |
|---|---|---|---|---|
| `postBounty` | 15 | 239 | 10.0 MB | 4 SHA-256 hashes |
| `submit` | 16 | 490 | 21.6 MB | 7 SHA-256, 8 transientHash, 2 curve operations |

For comparison, Q2's escrow-only `submit` was also k = 16 with a 19 MB prover key, and Q1's crypto
core was k = 11. Adding the checker, key exchange and encryption to the escrow doesn't raise k.

## Proving time

`bench.mjs` runs `postBounty` then `submit` in the runtime and posts each proof preimage to
`/prove`: one warm-up call, then 3 timed runs.

| Circuit | Warm-up | Median | Min to max | Proof size |
|---|---|---|---|---|
| `postBounty` | 22.7 s | 9.2 s | 7.4 to 10.1 s | 4,508 B |
| `submit` | 39.5 s | **42.9 s** | 39.9 to 72.3 s | 4,860 B |

Measured on an Intel i5 MacBook while the load average went from 128 to 233. These are worst-case
numbers.

**On an idle machine** (the `Spike benchmarks` workflow on a GitHub `ubuntu-latest` runner, run
40282085397, same keys and versions): `postBounty` median **5.8 s** (5.5 to 5.9 s), `submit` median
**10.9 s** (10.9 to 11.0 s). The full compile with keys took 46 s there, and the Q9 checks passed. This is proving time only. On a network, Q2 measured
about 100 to 134 s end to end for `submit`, which also covers wallet balancing and inclusion.

## Q9: JubjubPoint inside map values

- `Bounty.posterPk` stored by `postBounty` reads back from the ledger with the same coordinates:
  **yes**.
- `Delivery { ephemeralPk, c }` written by `submit` reads back, and the poster decrypts it to the
  exact answer with the contract's own `decrypt4` and `idField` pure circuits: **yes**.
- After `submit`, the status is SOLVED and the escrow is removed.

This ran in `compact-runtime` against the contract's ledger state, not on a deployed contract.

## Verdict

**Q11: a full `submit` is k = 16 and proves in about 11 s on an idle 4-core runner** (about 40 s
on a heavily loaded i5). The escrow sets the size; the cryptography is almost free on top of it.
The UI should show proving progress.

**Q9: answered in the runtime.** Curve points work inside struct values of ledger maps.
