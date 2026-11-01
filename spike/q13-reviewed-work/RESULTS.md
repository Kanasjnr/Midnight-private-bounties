# Spike Q13: reviewed work

**Question:** can a contract run a work bounty, where a person judges the work, with every promise
enforced on chain? That means:
- an exclusive window to deliver;
- a review clock where silence pays the contributor;
- a payout that can't be linked to the contributor;
- an optional arbiter who can overturn a rejection;
- a refund after the final deadline.

And can it do this with only Compact's block-time comparisons, since there's no clock value to
read?

**Answer: yes, in memory.**
- The contract in [`harness/contract/reviewed_work.compact`](harness/contract/reviewed_work.compact)
  compiles on 0.31.1 and passes 18 simulator tests covering all five parts.
- Every window works with block-time comparisons alone. The caller passes the window's end
  time, and the circuit checks it lies between `now + window − slack` and `now + window`.
- `collect` merges the contributor's own fresh coin first, as the preimage template's `submit`
  does, and pays reward plus coin to the caller.
- This is in-memory evidence only. The leak checks on a real devnet, a wallet run and proving
  times are not covered yet (see "Not covered yet").

## Setup

- Compact 0.31.1 (language 0.23), compact-runtime 0.16.0, midnight-js-protocol 4.1.1, vitest 4.1.11,
  Node 22.19.0.
- In-memory runs with midnight-examples' `@midnight-ntwrk/example-sim` (checkout `3498bd1`). Its
  block time follows the wall clock, so the window tests use windows of 3 to 10 seconds and
  sleep. The contract's `slack` is 3 s in the tests.
- The harness is laid out like a midnight-examples example (`harness/`), run from
  `.work/midnight-examples/examples/reviewed-work-spike` with `yarn compile:fast`, `yarn typecheck`
  and `yarn test:sim`. It has only `*.sim.test.ts` files, so the spike devnet workflow skips it.
- It reuses the repo's `escrow`, `deadline`, `pseudonym`, `ecdh` and `stream_cipher` modules,
  copied unchanged.

## The contract

One record per bounty: the poster's pseudonym and encryption key, the terms fixed at post time
(claim mode, the three windows, the final deadline, the optional arbiter), the status, the
assigned contributor's pseudonym, and one `until` time whose meaning depends on the status
(deliver by, review by, or appeal by).

```
OPEN --claim / assign--> ASSIGNED --submit--> SUBMITTED --approve--> APPROVED --collect--> PAID
                         |  delivery window       |  review window passes: collect works too
                         |  runs out: reopen       --reject--> REJECTED --overturn (arbiter)--> APPROVED
                         v                                     |  appeal window runs out: reopen
                        OPEN                                    v
OPEN or expired ASSIGNED, or REJECTED past its appeal window, after the final deadline --refund--> REFUNDED
```

| Circuit | Who | What it checks |
|---|---|---|
| `postWork` | Poster | Reward coin of the right color and non-zero; deadline ahead; valid poster key; windows positive; an arbiter needs an appeal window |
| `claim` | Anyone (first-to-claim mode) | Open; deliver-by within the window and not past the final deadline. Stores the caller's per-bounty pseudonym |
| `assign` | Poster (applicant mode) | Same window check; stores the applicant's pseudonym, which the applicant works out off chain |
| `submit` | Assigned contributor | Before deliver-by; review-by within the review window. Stores the link encrypted to the poster (the preimage template's key exchange and keystream) |
| `approve` | Poster | Submitted |
| `reject` | Poster | Submitted and still inside the review window. With an arbiter: appeal-by within the appeal window. Without one: reopens at once |
| `overturn` | Arbiter | Rejected and inside the appeal window |
| `reopen` | Anyone | Assigned past deliver-by, or rejected past appeal-by |
| `collect` | Assigned contributor | Approved, or submitted past review-by. Merges the caller's fresh coin first and pays reward plus coin |
| `refund` | Poster | After the final deadline: open, assigned (deliver-by is never past the deadline), or rejected past appeal-by |

## Results (2026-11-01)

All 18 tests in [`reviewed_work.sim.test.ts`](harness/src/test/reviewed_work.sim.test.ts) pass
(25 s, most of it sleeping). Every rejection test checks for the circuit's assert message.

### 1. Exclusive claim window

| Test | Result |
|---|---|
| accepts a deliver-by of now + window and records the claimer under a pseudonym | ✓ The stored pseudonym equals the one worked out off chain from the contract address, bounty ID and secret |
| rejects a deliver-by later than now + window, or more than the slack earlier | ✓ "Window end is too late", "Window end is too early" |
| lets only one contributor hold the work | ✓ A second claim fails with "Not open" |
| applicant mode: claiming is refused and only the poster can assign | ✓ Including the poster trying to shorten the window |
| reopens for anyone once the delivery window runs out, and can be claimed again | ✓ A late submit fails, a stranger reopens, someone else claims |
| closes claims once a full delivery window no longer fits before the final deadline | ✓ See "Consequences" |

### 2. Review clock

| Test | Result |
|---|---|
| stores the submission encrypted to the poster, with a review-by inside the window | ✓ The contributor can't pick a short review (too early) or a long one; the poster decrypts the link with the pure `decrypt` |
| lets only the poster approve | ✓ |
| silence pays: collect waits for approval or for the review window to end | ✓ Collect fails during the window, the poster can't reject after it, then collect pays |

### 3. Collect

| Test | Result |
|---|---|
| merges the contributor's fresh coin first and pays reward plus coin to the caller | ✓ One output of 110 (100 + 10) to the contributor's coin key; escrow removed; a second collect fails |
| works with a zero-value coin | ✓ One output of 100 |

### 4. Arbiter

| Test | Result |
|---|---|
| needs an appeal window when there is an arbiter | ✓ |
| a rejection waits out the appeal window, and only the arbiter can overturn it | ✓ Poster and contributor can't overturn; the poster can't shorten the appeal window; after the overturn the contributor collects |
| after the appeal window, anyone can reopen and the arbiter can no longer overturn | ✓ |
| without an arbiter, a rejection reopens the work at once | ✓ |

### 5. Refund

| Test | Result |
|---|---|
| pays the poster back after the final deadline when nobody delivered | ✓ Only the poster, only after the deadline |
| refunds an assignment that ran out, but never submitted work | ✓ Submitted work stays claimable after the deadline: the poster approved and the contributor collected |

### Privacy, in memory

`keeps every secret, the submission and the contributor coin out of public state` ✓: the
poster's, contributor's and arbiter's secrets, the poster's encryption key, the link's four
elements and the contributor coin's nonce are not in the public ledger after a full run.

## Measured cost

A full compile with keys took 1 min 29 s on the loaded laptop. k is read from the prover key
header, as in Q1. The same reader gives 15, 15 and 16 for the preimage template's `postBounty`,
`refund` and `submit`, which matches section 7.

| Circuit | k | Prover key | What sets the size |
|---|---|---|---|
| `postWork` | 15 | 11.0 MB | Receiving the reward coin (the same as `postBounty`) |
| `collect` | 16 | 19.5 MB | Merging and sending coins (the same as the preimage `submit`) |
| `refund` | 15 | 10.0 MB | Sending the escrow coin |
| `submit` | 13 | 3.1 MB | The pseudonym's SHA-256, plus the key exchange and keystream |
| `claim`, `assign`, `approve`, `reject`, `overturn` | 13 | 2.8 MB each | The pseudonym's (or arbiter id's) SHA-256 |
| `reopen` | 9 | 0.15 MB | Nothing but the state change and a block-time check |

The window checks and the state machine cost almost nothing. Coin handling and the SHA-256 in
`persistentHash` set every size, as in Q11. Only `collect` reaches k = 16, the same as the
preimage template's `submit`, which proves in about 11 s on an idle runner (Q11). Proving times
for these circuits weren't measured.

## Problems hit

None in the contract: it compiled on the first try and every test passed on the first run.
Two things needed care:
- `blockTimeGte` and `blockTimeLt` take a `Uint<64>`, so window arithmetic is cast back with
  `as Uint<64>` after checking `end >= window`.
- `Pseudonym_derive` hashes the contract address with `kernel.self()`, so an applicant's
  pseudonym is worked out off chain with `persistentHash` over the same four values, as the UI
  already does for posters. A test checks the two agree.

## Consequences for the design (ARCHITECTURE.md section 5)

1. **Windows need a two-sided check, not the one-sided one in the design.** Section 5 proposes
   `blockTimeGte(deliverBy − window)`, which only stops a window end that's too late. But the
   poster sets deliver-by in `assign` and appeal-by in `reject`, and the contributor sets
   review-by in `submit`. Each would want to cut the other side's window short. The check must
   also assert `blockTimeLt(deliverBy − window + slack)`. `slack` is fixed per deployment. It
   must be longer than a call takes to land: proving, approval and inclusion took up to 2.5
   minutes in Q6, so 10 to 15 minutes looks right 🔬 (devnet).
2. **Claims close one delivery window before the final deadline.** A claim needs deliver-by
   within the window and no later than the deadline, so once `now + window − slack` passes the
   deadline nobody can claim. The post form should show "claims close on …".
3. **`reopen` is its own circuit,** rather than letting `claim` take over an expired assignment.
   It handles expired assignments and expired appeals in one place, and works in applicant mode,
   where nobody calls `claim`.
4. **Without an arbiter, a rejection reopens the work at once.** The contributor has no
   recourse, which matches the trust model in section 15.
5. **A submitted reward can be locked forever.** Submitted or approved work is never refundable,
   so a contributor who submits and then disappears leaves the reward in escrow. The fix is a
   long "collect by" (for example 90 days after review-by), after which the poster can take it
   back. This isn't in the spike.
6. **The submission fits a link, not notes.** It reuses the four-element `Delivery` (about
   124 bytes). Notes go in messages, or need a longer keystream.
7. **The arbiter's id is the same across bounties** (`arbiterId(sk)`, no bounty ID), because an
   arbiter is a named, known party. Contributors and posters stay per-bounty pseudonyms.
8. **First to claim can be squatted.** Anyone can claim, let the delivery window run out, reopen
   and claim again, under a new pseudonym if needed. So one person can keep a bounty blocked
   for the cost of one fee per window. Applicant mode doesn't have this problem, because the
   poster picks who works on it. There are three ways to fix it, and the spike tests none of them:
   - make applicant mode the default;
   - let the poster release a first-to-claim assignment while nothing has been submitted;
   - ask for a small claim deposit, returned on submit and forfeited when the window runs out.

## Not covered yet

- **A devnet run.** The in-memory run can't show whether the payout leaks anything on a real
  ledger (the Q2 leak checks). It also can't show block-time checks against real block
  timestamps, or how `slack` behaves when a call takes minutes to land.
- **A wallet run** (the Q6 path) and proving times.
- **Applications.** How an applicant sends a plan and their pseudonym to the poster: on chain,
  encrypted, or off chain.
- **Messages,** and where they're stored.
- **Titles and details** (the `listings` map the templates have), and the "collect by" fix in
  point 5.
- **An organization's verified name,** and contributor profiles. These are off chain and not
  part of this contract.
