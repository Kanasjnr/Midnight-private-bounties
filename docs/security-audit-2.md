# Security audit, round 2: Private Bounties contracts

**Date:** 2026-11-01. **Scope:** everything in `contract/` after the changes since the
[first audit](security-audit.md):
- the six modules (`escrow`, `deadline`, `pseudonym`, `ecdh`, `stream_cipher`, `schnorr`);
- the three templates and `test_token`;
- `witnesses.ts`, `keys.ts` and `signing.ts`.

Compact 0.31.1, language version 0.23. The new parts since round 1:
- each bounty's listing (title, question, reward, post time);
- the post-time check, `Deadline_assertRecent`;
- solvers paying with a zero-value coin.

**Method:**
- **An adversarial review.** It traced the compiled ZKIR to see exactly what becomes a public
  input, ran a pass over that ZKIR to find which public values derive from secret (witness)
  inputs, and read the ledger and proof-system sources.
- **A simulator probe** against the compiled contracts.
- **Every round-1 fix rechecked** against the current code.
- **A separate check of the witnesses against `bounty_preimage`:**
  - the types, under strict TypeScript;
  - a structural checklist: names, return shapes, no mutation of private state;
  - a full post, submit and decrypt run on compact-runtime 0.16.0, which passed 44 of 44 checks.
- **The findings that contradicted the docs, reproduced by hand:** the 32 KiB cell bound and the
  post-time edges.
- **Regression tests** for every fix below.

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| L1 | Low | Listing text is permanent and only bounded by the ledger's 32 KiB cell, so anyone can bloat the board for fees | Mitigated |
| L2 | Low | The post time shows the poster's clock offset to the second, which can group their bounties | Fixed |
| L3 | Low | A pending post can be front-run with its own bounty ID, again and again | Fixed |
| S1 | Suggestion | Treat listing text as untrusted in the UI | Planned for the app |
| S2 | Suggestion | Normalize `posterKeyFor`'s inputs and check the derived key before decrypting | Fixed |
| S3 | Suggestion | Hedge the issuer's Schnorr nonces against a weak random source | Fixed |
| S4 | Suggestion | Regression tests for the new properties | Fixed |
| S5 | Suggestion | Correct the docs on the length limit and on squatting | Fixed |

No Critical, High or Medium findings. Every round-1 fix still holds (see the end).

## Low

**L1: board spam** (`listings` in all three templates).
- **The flaw:**
  - The title and question are `Opaque<"string">`, whose length a circuit can't check. The
    UI's 80 and 1,000 character caps only bind honest clients.
  - The real bound is the ledger's cell limit of 32,768 bytes. In the simulator, 32,700 bytes of
    question was accepted and 32,800 was rejected with "Cell exceeded maximum bound of 32768".
  - Listings are never removed. A spammer could post a bounty with a reward of 1 and a deadline
    a moment away, refund it straight after, and pay only fees.
- **Impact:** no funds or secrets are at risk. Every board client downloads the junk for as long
  as the deployment lives, because the UI decodes the whole contract state.
- **Fix:** each deployment now sets a minimum reward and a minimum open window. `postBounty`
  checks the reward is at least `minReward`, and the deadline at least `minWindow` after the
  checked post time. A spam post now locks capital for the window as well as costing fees. The
  UI deploys with 10 and 30 minutes, and checks both before posting with `postError`, which is
  tested against the circuit.
- **What's left:** each listing can still be up to 32 KiB. Bounding the text by type, or keeping
  it off chain behind a hash, would remove that, at some cost to every post. For now the
  bound is documented.
- **Tests:**
  - `enforces the deploy-time minimum reward and minimum open window`;
  - `takes long text up to the ledger's 32 KiB cell bound, and no more`;
  - the UI's `postError and the circuit agree on the reward and window checks`.

**L2: the post time as a fingerprint** (`postTime` in the UI).
- **The flaw:** the UI recorded the browser clock minus 60 seconds, and the block's timestamp is
  public. A device whose clock is minutes off would leave the same offset on every bounty it
  posts. That weakly groups bounties that are otherwise unlinkable.
- **Fix:** the post time is rounded down to 5 minutes. That still leaves about 9 minutes for the
  post to land; Q6 measured 2.5.
- **Test:** `postTime records a minute before the browser's clock, rounded down to 5 minutes`.

**L3: front-running a bounty ID** (`postBounty` in all three templates).
- **The flaw:**
  - The caller chose the bounty ID. Someone watching pending transactions could post first under
    the same ID, copying the victim's text and target, so the victim's post was rejected.
  - A retry is just as visible, so the app's retry didn't stop a persistent squatter.
  - The board would also show the squatter's copy of the listing.
- **Fix:**
  - `postBounty` now takes a fresh secret salt and derives the ID in the circuit, as
    `persistentHash("bounty:id", salt, sk)` with the poster's identity secret.
  - A squatter who copies the salt gets a different ID under their own secret, so the poster's
    post still lands.
  - The salt never becomes public, so IDs can't be linked to each other or to the poster.
  - The UI computes the same ID with the pure `bountyIdFor`.
- **Cost:** `postBounty` stays at k = 15, and its prover key grows by about 7 KB.
- **Test:** `can't be front-run with the poster's bounty ID`.

## Suggestions

- **S1:** the app should treat a listing's text as untrusted:
  - show the on-chain parameters (N, the issuer key, schema, field, threshold, deadline,
    reward) as the authoritative ones;
  - strip bidi, zero-width and control characters;
  - flag duplicate listings;
  - let users hide listings locally.

  React already escapes the text, so this isn't a script-injection risk. A misleading listing
  costs a solver effort, not funds, because a wrong answer is rejected before anything is
  proved. This is planned for the app build.
- **S2:**
  - `posterKeyFor` now rejects a bounty ID that isn't 32 bytes, and normalizes the contract
    address: trimmed, lower case, no `0x`.
  - The UI's `readAnswer` checks the derived key against the bounty's public key before
    decrypting. Without that check, a key from the wrong seed or address decrypts to garbage
    without any error.
  - **Test:** decrypting with the wrong seed now fails with "doesn't match".
- **S3:**
  - `signRecord` draws each Schnorr nonce as SHA-512 over the issuer's key, the record and 64
    fresh random bytes, reduced. That's as uniform as before.
  - If the random source is weak or repeats, the key and record still vary the nonce.
  - `signRecord` is now async, because the browser's SHA-512 is.
  - **Test:** `still gives a different nonce per record if the random source repeats`.
- **S4:** new tests for:
  - the exact post-time edge (exactly 15 minutes old is rejected);
  - the listing's reward equalling the escrowed coin's value;
  - the 32 KiB bound.
- **S5:** `ARCHITECTURE.md` now states the ledger's cell bound, the minimums, the derived ID and
  the rounded post time, and its threat model is updated to match.

## Round-1 fixes, rechecked

| ID | What was checked | Result |
|---|---|---|
| H1 | `signing.ts` nonces are 512 bits reduced into [1, ℓ). The subgroup order matches the curve source. S3 keeps this | Holds |
| H2 | The pseudonym hashes in the bounty ID and the contract address; `keys.ts` derives a key per bounty | Holds |
| L1 | The poster's key (and the issuer's) is used in a curve operation, and the identity is rejected; the stored key is the checked one | Holds |
| L2 | Factors are range-checked to 64 and 128 bits, and N to 128 bits and at least 4 | Holds |
| L4 | `record[0]` must equal the bounty's schema tag; the field must be 1 to 3 | Holds |
| S1 | Both constants of the canonical Schnorr reduction recomputed | Holds |
| S3 | `localSecretKey` checks for 32 bytes; the poster seed is in private state | Holds |
| S4 | The escrow module accepts a zero-value coin, and every `postBounty` requires a non-zero reward | Holds |

## What held

- **The listing can't drift from the escrow.** Its reward is the same circuit wire as the coin's
  value, and its post time is the same wire the window check uses.
- **The title and question are bound by the proof,** so a relay or node can't change them.
- **The listing is written exactly once,** in `postBounty`. `submit` and `refund` never touch it.
- **`assertRecent` is overflow-safe.** Extreme inputs fail its asserts cleanly. The window is
  exactly the 15 minutes up to the block time.
- **No new `disclose()` exposes anything secret.** The only public values derived from secrets
  are:
  - in `postBounty` and `refund`: the pseudonym, and now the bounty ID;
  - in `submit`: the ciphertext, `e·G` and the payout commitment.

  A zero-value solver coin still hides the payout's nonce.
- **The witnesses match the contract exactly,** and never mutate private state.

## What rests on assumptions

- The ledger's limits (the 32 KiB cell, bytes written per block) come from the ledger source and
  the 0.16.0 runtime simulator, not from Preview or Preprod. I couldn't price the fees of a spam
  run.
- That a squatted post was rejected whole is inferred from the same mechanism as devnet test D5;
  it wasn't run on a devnet.
