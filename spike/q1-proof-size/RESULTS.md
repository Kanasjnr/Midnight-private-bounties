# Spike Q1: circuit size of `submit`

Compiled `spike.compact` with Compact 0.31.1 (`compact compile +0.31.1`), language version 0.23.
Full compile with key generation for all five circuits took **34 s**.

| Circuit | What it proves | ZKIR ops | k | Rows (2^k) | Prover key | Verifier key |
|---|---|---|---|---|---|---|
| `checkOnly` | `transientHash(answer) == target` | 25 | 7 | 128 | 39 KB | 1.3 KB |
| `encryptOnly` | checker + keystream encryption of 4 elements | 114 | 9 | 512 | 139 KB | 1.3 KB |
| `submit4` | checker + Jubjub ECDH + encryption of 4 elements | 163 | 11 | 2,048 | 688 KB | 1.6 KB |
| `submit8` | same, 8 elements (about 250 bytes) | 238 | 11 | 2,048 | 688 KB | 1.6 KB |
| `submitSha` | `submit4` with a `persistentHash` (SHA-256) checker | 168 | 14 | 16,384 | 5.7 MB | 2.3 KB |

k is read from the prover key header (the byte after the leading `0x08` in the decompressed key).
It matches the key sizes: each +1 in k roughly doubles the key.

## What this tells us

- **The core is small.** Checker, key exchange and verifiable encryption fit in k = 11. The
feared cost of "encryption plus key exchange in one proof" doesn't show up.
- **Payload size is nearly free at this scale.** Going from 4 to 8 elements didn't change k.
- **The checker's hash dominates.** A SHA-256 checker costs 8x the rows of the whole
key-exchange-and-encryption core. Templates should use `transientHash` where the checker
allows it.
- The circuit range-checks the ephemeral scalar (`constrain_bits` on the 248-bit witness), as
designed.

## Proving time

`bench.mjs` runs each circuit in `compact-runtime` 0.16.0, builds the preimage with
`ledger-v8` 8.1.3 and posts it to `/prove` on a local `proof-server:8.1.0`. Each circuit gets
one warm-up call, which also loads the public parameters for its k, then 3 timed runs.

| Circuit | k | Warm-up | Median | Min to max | Proof size |
|---|---|---|---|---|---|
| `checkOnly` | 7 | 4.13 s | 0.85 s | 0.85 to 0.86 s | 2,940 B |
| `encryptOnly` | 9 | 4.08 s | 0.85 s | 0.77 to 0.88 s | 2,940 B |
| `submit4` | 11 | 1.93 s | **1.86 s** | 1.60 to 2.40 s | 3,324 B |
| `submit8` | 11 | 6.38 s | **2.74 s** | 1.95 to 2.92 s | 3,324 B |
| `submitSha` | 14 | 9.40 s | 5.63 s | 4.62 to 6.32 s | 4,860 B |

Measured on an Intel i5 MacBook with Docker Desktop, while the machine was heavily loaded
(load average 32 to 67 during the run). Expect faster times on a quiet machine.

## Decryption round trip (Q4)

After `submit4`, the benchmark reads `c4` and `ephemeralPk` from the ledger and decrypts with
the contract's own `decrypt4` pure circuit and the poster's secret key:

- the ciphertext differs from the answer: **yes**;
- the poster's key recovers the exact answer: **yes**;
- a wrong key recovers it: **no**.

So the in-circuit key exchange and keystream match what runs off-chain in JS.

## Verdict

**Q1 passes.** The full `submit` core proves in about 2 seconds on a loaded laptop, with a
3.3 KB proof. Payloads up to 8 elements (about 250 bytes) cost almost nothing extra. The one
expensive choice is a SHA-256 checker, so templates should prefer `transientHash`.

## Still to measure

- Where payload size starts to raise k (16 and 32 elements).
- The cost of escrow (`mergeCoin`, `sendShielded`) and the deadline check, with Q2.
- Proofs are generated but not yet checked by a node. Q2 submits real transactions.
