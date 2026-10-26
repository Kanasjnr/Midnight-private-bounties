# Security audit: Private Bounties contracts

**Date:** 2026-10-26. **Scope:** the five shared modules (`escrow`, `deadline`, `pseudonym`,
`ecdh`, `stream_cipher`), `schnorr` (from midnight-examples' zk-loan), the three templates
(`bounty_preimage`, `bounty_factor`, `bounty_signed_record`), `test_token`, and the TypeScript
witnesses and issuer signing helper. Compact 0.31.1, language version 0.23.

**Method:**
- An adversarial review covering the witness trust boundary, access control, cryptography,
  tokens and privacy. It read the compiled ZKIR to see exactly what becomes a public input, and
  checked ledger and proof behaviour against the Midnight ledger and proof-system sources.
- Every Critical or High finding was then confirmed by running a proof of concept against the
  compiled contracts.
- Every fix below has a regression test.

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| H1 | High | Issuer signing nonces drawn from 248 bits: the issuer key can be recovered | Fixed |
| H2 | High | One poster pseudonym per deployment: all of a poster's bounties are linkable | Fixed |
| L1 | Low | Poster and issuer keys not validated when a bounty is posted | Fixed |
| L2 | Low | Factoring bounties whose larger factor exceeds 64 bits can't be claimed | Fixed |
| L3 | Low | A poster who knows the answer can claim their own bounty | Documented as a trust assumption |
| L4 | Low | Schnorr signatures can be replayed from other apps that use the same module | Fixed |
| L5 | Low | Decryption depends on the runtime's `transientHash`, which may change at a hard fork | Documented, with the mitigation |
| S1 | Suggestion | Schnorr challenge reduction not strictly unique | Fixed |
| S2 | Suggestion | Encryption context keeps 248 of the bounty ID's 256 bits | Documented (harmless) |
| S3 | Suggestion | Witness hardening | Fixed |
| S4 | Suggestion | Solvers must already hold the reward token | Open question Q12 |
| S5 | Suggestion | Bounty ID squatting | Documented (app retries) |
| S6 | Suggestion | Test a submit that lands after the deadline | Fixed (devnet test D5) |

No Critical findings.

## High

**H1: biased issuer nonces** (`contract/signing.ts`).
- **The flaw:** the Schnorr nonce came from the 248-bit helper meant for the key exchange, so
  every nonce sat in the lowest ~7% of the Jubjub scalar range.
- **Impact:** that is a Hidden Number Problem. Lattice attacks recover the signing key from
  roughly 80 to 150 signatures, so anyone holding that many of one issuer's records could forge
  records.
- **Confirmed:** 1000 of 1000 recovered nonces were below 2^248, where a uniform nonce gives about 69.
- **Fix:** the nonce is now 512 random bits reduced modulo the subgroup order.
- **Test:** `issuer signing (audit H1)` checks that over 85% of recovered nonces are above 2^248.
- **Note:** issuers who signed with the old helper should rotate their key.

**H2: linkable posters** (`contract/pseudonym.compact`, all three templates).
- **The flaw:** the pseudonym hashed the poster's secret with the contract address only, so every
  bounty a poster created showed the same value. The encryption key `b·G` was also reused.
- **Confirmed:** two bounties stored identical pseudonyms and keys.
- **Fix:** the pseudonym now hashes in the bounty ID. `keys.ts` derives a separate encryption key
  for each bounty from one 32-byte seed, which can live in the private state so one backup covers
  it.
- **Test:** `poster keys (audit H2, L1)` checks that two bounties don't share either value, and
  that each still decrypts.

## Low

**L1: unchecked keys.** `postBounty` now uses the poster's key, and in signed-record the issuer's
key, in a curve operation. That makes the proof check each key is on the curve and in the
prime-order subgroup. It also rejects the identity point, which passes those checks but would make
every shared key public. **Tests:** the identity and an off-curve point are both rejected, for
posters and for issuers.

**L2: unclaimable factorisations.**
- **The change:** the smaller factor is range-checked to 64 bits and the larger to 128. Their
  product stays below 2^192, so it still can't wrap around the field.
- **The result:** every factorisation of an N below 2^128 can now be submitted. `postBounty`
  range-checks N to 128 bits and requires N ≥ 4.
- **Tests:** a factorisation with a 101-bit factor pays, out-of-range N is rejected at post time,
  and the field-wraparound attack is still rejected.

**L3: self-claiming.** In `preimage`, and in `factor` when the poster generated N, the poster
knows an answer and can take the reward back before the deadline. A solver loses effort but no
funds. It can't be prevented in-circuit, so it is stated as a trust assumption in
`ARCHITECTURE.md` §15.

**L4: signature replay.** `record[0]` is now a schema tag the issuer sets for each kind of record,
and each bounty pins the tag it accepts. So a zk-loan attestation, or a record of another type from
the same issuer, no longer qualifies. **Test:** both are rejected as the wrong record type.

**L5: hash stability.**
- **The flaw:** decryption calls `transientHash` from the installed `compact-runtime`, and the
  ledger allows that hash to change at a hard fork. An earlier draft of the design claimed the
  compiled contract pins it; it doesn't.
- **Mitigation:** the poster's app decrypts as soon as a bounty is solved, keeps the plaintext,
  and pins its exact runtime version.

## Suggestions

- **S1:** the Schnorr module now also requires the canonical reduction (q < 115, or q = 115 with
  r below p − 115·2^248). Our copy of the module is marked as modified from zk-loan. **Test:** a
  prover who supplies the second of two valid reductions is rejected.
- **S3:** the identity-secret witness checks that `sk` is 32 bytes, and the private state can hold
  the poster's key seed so backups cover it. Clearing the answer from private state after a
  confirmed submit is for the app.
- **S4:** a solver currently needs some of the reward token to bring their own coin. Whether a
  zero-value coin works is open question Q12, which needs a devnet run.
- **S6:** devnet test D5 sends a submit proven before the deadline that lands after it. It must be
  rejected whole, with the bounty still open and the solver's balance unchanged.

## What held

- **No payout without a passing answer:** the checker, key exchange, encryption and payout are
  bound in one proof.
- **No double payout or escrow theft:** the ledger also rejects a new coin whose commitment
  already exists.
- **The submit-versus-refund race at the deadline is exact.**
- **Refund authorisation is sound,** and `ownPublicKey()` is used only as a payout recipient.
- **The factor and signature checks are real range checks in the circuit.**
- **No secret becomes a public input of `submit`:** not the answer, the signature, `e`, the shared
  key, nor the solver's coin or recipient.
