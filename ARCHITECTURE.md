# Private Bounties on Midnight: Architecture

**Status:** draft v0.6, 2026-10-28. Updated with the spike results (every question in section 18
is answered or decided; Q6 still needs a Lace run) and the fixes from the first security audit
([report](docs/security-audit.md)). Anything still marked 🔬 is unproven. Code blocks
are **pseudocode, not Compact**. Midnight-specific facts were checked against the Compact
standard library at `compactc-v0.31.1` and against
[midnight-examples](https://github.com/midnightntwrk/midnight-examples) at `cb250c9`.

---

## 1. Summary

Someone posts a **reward** and a **checker**. A solver proves, in zero knowledge, that their
answer passes the checker. In the **same transaction**, the contract:

- stores the answer **encrypted to the poster's key**;
- pays the reward to the solver as a **shielded coin**.

Only the poster can read the answer, and the poster can't avoid paying, because payment and
delivery are one atomic step. If nobody solves the bounty by the deadline, the poster takes the
reward back.

Researchers call this **zero-knowledge contingent payment (ZKCP)**. It has been studied since 2016,
but nobody runs it in production. Midnight can do what earlier designs couldn't: verify the
checker, the key exchange and the encryption **inside one proof**, and settle with shielded tokens.

We're building it in the open during Build Club. Once it's built and thoroughly tested, its
building blocks get split into standalone examples.

## 2. The problem we fix

![Classic ZKCP reveals the key on-chain; on Midnight the solver encrypts to the poster inside the proof](docs/images/zkcp-vs-midnight.svg)

The key never goes on-chain. The solver encrypts **directly to the poster's public key** with a
Diffie-Hellman key exchange on the Jubjub curve, and the proof shows it was done correctly.

## 3. Goals and non-goals

**Goals**
- A working DApp (contract, API and UI) on a local network, then Preview and Preprod.
- It shows how Midnight's privacy features work **together**, not one at a time.
- Every building block is testable and splittable into its own example.
- Builders can follow along: tutorials and decisions are written as we go.

**Non-goals (v1)**
- Large files. Payloads are a few hundred bytes: answers, records and credentials.
- Arbitrary checkers. Every checker is a Compact circuit, so v1 ships three templates.
- Real-value payments. The demo pays with a test token the app mints itself.
- Dispute resolution or reputation.

## 4. Actors and system context

| Actor | Role |
|---|---|
| **Poster** (buyer) | Posts a bounty: checker template, parameters, reward and deadline. Reads the answer. |
| **Solver** (seller) | Finds an answer, proves it passes and gets paid. |
| **Observer** | Anyone reading the chain or the indexer. Sees the bounty, never the answer. |
| **Wallet** | Lace, 1AM or any wallet that implements the DApp Connector. Balances, signs and submits transactions, and pays DUST fees. |
| **Proof server** | Runs locally and generates the ZK proofs, so private inputs never leave the machine. |
| **Midnight node and indexer** | Run the network and serve live contract state to the UI. |

![System context: poster and solver machines, each with the app, a wallet and a local proof server, talking to the Midnight network](docs/images/system-context.svg)

## 5. Two modes

| | **Open bounty** (v1, flagship) | **Private offer** (v2) |
|---|---|---|
| Who | One poster, any solver | One buyer, one seller who already has the data |
| Order | Reward first, then answers compete | Seller lists with proof, buyer pays, seller claims |
| Reward or price | **Public**: it's advertised to attract solvers | **Private**: committed, never in public state 🔬 |
| Key handling | Solver encrypts straight to the poster's key | Seller commits to key k at listing, then wraps k for the buyer at claim |
| Transactions for the solver | One: `submit` brings the solver's own coin in the same transaction (Q3, verified) | List + claim |
| Example use | "Factor N", "find the preimage", "a signed record with income ≥ X" | Sell a verified fact to one lender |

v1 builds the open bounty. The private offer reuses the same modules and adds a commitment to
k and a hidden price (section 14).

## 6. Component architecture

![Component architecture: React app, BountyAPI and midnight-js providers, the wallet, proof server, node, indexer and contracts](docs/images/components.svg)

This follows the same wiring as the zk-loan example UI: `FetchZkConfigProvider`,
`httpClientProofProvider` and `indexerPublicDataProvider`, with the wallet's `getConfiguration()`
supplying the endpoints.
**One difference:** zk-loan keeps private state **in memory**. We can't, because the poster's
decryption key has to survive a reload, so we need a persistent, encrypted browser store (Q8).
The UI template's store does that: midnight-js's LevelDB provider on IndexedDB, encrypted under a
passphrase, one store per wallet account.

### Repository layout

It mirrors a midnight-examples example, so pieces can move there later, and it runs inside a
midnight-examples checkout (as `examples/private-bounties`) for its simulator package, wallets and
devnet. Module file names use underscores because a module's name must be an identifier.

```
private-bounties/
├── contract/
│   ├── escrow.compact            module: receiveFresh, payMerged, payOut
│   ├── deadline.compact          module: assertOpen, assertExpired
│   ├── ecdh.compact              module: publicKey, sharedKey
│   ├── stream_cipher.compact     module: keystream, encrypt4, decrypt4
│   ├── pseudonym.compact         module: derive
│   ├── bounty_preimage.compact   template contract (built)
│   ├── bounty_factor.compact     template contract (built)
│   ├── bounty_signed_record.compact  template contract (built)
│   ├── schnorr.compact           module from zk-loan: in-circuit Schnorr verification
│   ├── test_token.compact        test-only reward token
│   ├── witnesses.ts              one generic set of witnesses for every template
│   ├── signing.ts                off-chain Schnorr signing, for issuers of signed records
│   └── index.ts
├── src/          API layer, providers, simulator and integration tests
├── ui/           React app, started from midnight-examples templates/ui
├── spike/        week-1 measurements
├── docs/         this file, decisions, threat model
├── tutorials/    written as we build
└── compose.yml   local network: node, indexer, proof server
```

## 7. Contract design

### Module structure

Each checker template is its own contract, because a contract's circuits are fixed at deploy
time. One template contract hosts **many** bounties, each with its own public parameters. The
shared logic lives in modules imported with `import "<file>" prefix X_;`, which is how zk-loan
pulls in its Schnorr module.

![Contract modules: three template contracts importing shared escrow, deadline, ECDH, stream-cipher and pseudonym modules](docs/images/contract-modules.svg)

There are no cross-contract calls on this stack, and none are needed. The test token is an
ordinary shielded coin, and a template contract only checks its color.

### Ledger state (pseudocode)

```
bounties:   Map<BountyId, {
              poster:   Bytes<32>       // per-bounty pseudonym, not the wallet
              posterPk: JubjubPoint     // poster's encryption key, b·G
              params:   CheckerParams   // template-specific, public
              deadline: Uint<64>        // block time, seconds since the Unix epoch (Q7)
              status:   OPEN | SOLVED | REFUNDED }>
escrows:    Map<BountyId, QualifiedShieldedCoinInfo>   // v1: public, a fresh coin, via insertCoin
deliveries: Map<BountyId, { E: JubjubPoint, c: Vector<N, Field> }>
rewardColor: sealed Bytes<32>                          // accepted reward token, set at deploy
```

In `bounty_preimage` the checker's parameter is `target: Field`; `bounty_factor` stores its N in
the same slot. `bounty_signed_record` replaces it with `issuerPk: JubjubPoint`, `field: Uint<8>`
and `threshold: Uint<64>`. In every template the payload is four field elements
(`Vector<4, Field>`, about 124 bytes).

### Circuits

| Circuit | Caller | What the proof shows | Public effects |
|---|---|---|---|
| `postBounty` | Poster | Poster pseudonym comes from their secret and this bounty's ID; the coin has the reward color and a non-zero value; the deadline is still ahead; the poster's key (and in signed-record, the issuer's) is on the curve, in the prime-order subgroup and not the identity | Bounty record and escrow coin |
| `submit` | Solver | Checker passes, ECDH is correct, c encrypts the answer, before the deadline. Receives the solver's fresh coin, which may be worth zero, and merges it first | `E`, `c`, status `SOLVED`, one shielded payout: reward plus the solver's coin |
| `refund` | Poster | Pseudonym matches; deadline passed; still `OPEN` | Status `REFUNDED`, escrow returned |
| `answerHash`, `checkAnswer` (pure) | Browser | No proof: runs in JS | None: builds a bounty's target, and pre-checks an answer before paying for a proof |
| `posterPublicKey`, `decrypt` (pure) | Browser | No proof: runs in JS | None: the poster's key and decryption, with the exact circuit math |

Three secrets stay separate, as shielded-chips' lessons advise:
- the poster's identity secret `sk` (pseudonym, in-circuit);
- the poster's encryption key `b`, off-chain only. A new one is derived for every bounty from a
  32-byte seed (`keys.ts`), so bounties can't be linked through `b·G`. The seed can live in the
  private state, so one backup covers every bounty;
- the solver's ephemeral scalar `e`, which a witness draws fresh for every submission and which
  is never stored.

Exporting pure circuits for off-chain use is the zk-loan pattern: `schnorrChallenge` lets
TypeScript compute exactly what the circuit computes.

The first draft had a separate `stake` circuit, plus `withdrawStake` for a solver who lost a race.
Q3 showed a coin received in the same transaction can be merged first, so `submit` does it all in
one go. The one-transaction payout passed the same privacy checks as the two-step one (Q3b), so
the two-step version is no longer needed.

### Measured cost

| Part | k | Proving or transaction time | Source |
|---|---|---|---|
| Checker + key exchange + encryption (4 or 8 elements) | 11 | 0.4 s to prove (idle runner); 1.9 to 2.7 s (loaded laptop) | [Q1](spike/q1-proof-size/RESULTS.md) |
| Same core with a SHA-256 checker | 14 | 2.6 s (idle runner); 5.6 s (loaded laptop) | [Q1](spike/q1-proof-size/RESULTS.md) |
| Escrow `submit` (merge + payout) | 16 | about 100 s to 134 s per transaction, end to end | [Q2](spike/q2-escrow/RESULTS.md) |
| `postBounty`, `refund` | 15 | about 40 s to 67 s per transaction, end to end | [Q2](spike/q2-escrow/RESULTS.md) |
| **Full `submit`**: checker + key exchange + encryption + escrow | **16** | **about 11 s to prove (idle runner)**; 43 s (loaded laptop) | [Q11](spike/q11-full-submit/RESULTS.md) |

**Coin handling, not cryptography, sets the cost.** Every coin operation hashes commitments and
nullifiers with SHA-256 inside the standard library. The full `submit` (checker, key exchange,
encryption and escrow) is k = 16, the same as the escrow alone, so the cryptography is almost free
on top of it (Q11). The UI shows proving progress; expect around 11 s on an ordinary 4-core
machine, longer on a busy laptop. "Idle runner" times come from the `Spike benchmarks` workflow on
a GitHub `ubuntu-latest` runner; the others were measured on a heavily loaded
Intel i5 laptop, and "end to end" includes proving, wallet balancing and landing on chain.

## 8. Cryptography

### Key exchange and verifiable encryption (inside `submit`)

![Inside submit: checker, ECDH with the poster key, keystream encryption, and what is disclosed](docs/images/submit-crypto.svg)

The poster decrypts off-chain: `S = b·E` (same point, because `b·(e·G) = e·(b·G)`), then
`k = transientHash(S, bountyId)`, then `m[i] = c[i] − transientHash(k, i)`.

Notes for implementation:
- **Scalars must be below the Jubjub order.** `e` comes from a 248-bit witness, so it is always in
  range. zk-loan's Schnorr module has the same constraint and reduces hash outputs to 248 bits.
- **`JubjubPoint` is opaque.** Compare points coordinate-wise with `jubjubPointX`/`jubjubPointY`,
  because `==` compiles to JS reference equality (a note in zk-loan's `schnorr.compact`).
- **Field addition, not XOR.** It is native and cheap in-circuit. Each `m[i]` must fit in a Field,
  so we pack about 31 bytes per element.
- **A keystream must never repeat.** Fresh `e` per submission and the bounty ID plus the index in
  the hash input give domain separation. The ID enters as a field element, which keeps 248 of its
  256 bits; that is harmless because the key also depends on the fresh `e`.
- **Keep the plaintext, and pin the runtime.** Decryption runs `transientHash` from the installed
  `@midnight-ntwrk/compact-runtime` package, not from the compiled contract, and the ledger allows
  that hash to change at a hard fork. So the poster's app decrypts as soon as a bounty is solved
  and keeps the plaintext in private state, and the app pins its exact runtime version. (An
  earlier draft claimed the compiled contract pins the hash; the audit showed it doesn't.)

### Private offer (v2): wrapping a committed key

In v2 the seller encrypts under their own key `k` at listing time, before any buyer exists, and
commits to `k`. At claim time they prove `kWrapped = k + transientHash(ECDH(e, buyerPk))` for the
committed `k`. Same building blocks, one extra commitment.

## 9. Escrow and payout privacy

This is the subtlest part of the design, and it builds directly on what shielded-chips already does.

**What the stdlib does (0.31.1):** `sendShielded` and `mergeCoin` derive the new coin's nonce
deterministically from the **first** input coin's nonce. A coin commitment is a hash of
`(nonce, color, value, recipient)`. So if a coin's nonce is public, anyone can compute the payout
coin's nonce and **test a guessed wallet key** against the commitment.

**What shielded-chips does:** a player's escrowed coin is stored only as a
`persistentCommit([nonce, color, value], salt)` and replayed from private state through a witness
at claim time. Its own comment notes the cost: *only the player can reopen the escrow commitment.*

**Our problem:** in an open bounty the **solver** claims a coin the **poster** escrowed. The
solver can't reopen the poster's commitment. So in v1 the escrow coin is stored publicly
(`insertCoin`, as with shielded-chips' `houseCoins`), which is fine because the reward is
advertised anyway. That makes the escrow nonce public, though, so a direct payout would be
linkable.

**The escrow coin must be a fresh coin.** The coin passed to `receiveShielded` describes a new
coin the transaction creates for the contract; the wallet pays for it from its own coins and keeps
the change under new nonces. So the app always builds it with a random nonce, never a wallet coin's
nonce, and the public escrow nonce then points at nobody (shielded-chips `LESSONS.md` §11).

**The fix for the payout (reusing shielded-chips' `claimWinnings` trick):** the solver brings a
fresh coin of their own, with a nonce only they know, and the contract merges **the solver's coin
first**. The payout's nonce then derives from that secret nonce.

![Payout privacy: merging the solver's own fresh coin first makes the payout nonce unguessable](docs/images/payout-privacy.svg)

**Q3, verified on a local devnet:** the solver's coin can be received in the same transaction as
the merge (we build its `QualifiedShieldedCoinInfo` with `mt_index` 0 and pass it first, rather than
using `mergeCoinImmediate`, which puts the stored coin first). So `submit` is a single
transaction, and the solver gets the reward plus their coin back in one payout.

**Q2, verified on a local devnet** with the two-step version: the escrow coin is public as
designed, while the solver's coin nonce, the payout nonce, both wallets' coin keys and the solver's
secret never appear in public state, and the payout nonce differs from the escrow nonce
([results](spike/q2-escrow/RESULTS.md)). **Q3b, verified:** the same checks pass for the
one-transaction payout.

**Racing solvers (Q5, verified):** two solvers submitting at once both spend the same escrow coin.
The first transaction lands; the node rejects the second as a whole (`TransactionInvalid(Zswap)`),
so the losing solver's coin never leaves their wallet. The escrow coin works as the lock.

**Refunds:** the poster's refund comes from the public escrow coin, so it is linkable to the
poster's wallet **by someone who already suspects that wallet**. v1 documents this, and the same
merge trick can fix it later if it matters.

**v2 private offers:** the buyer escrows with a commitment only (the shielded-chips pattern, minus
the public value) and gives the opening to the one seller. The price never enters public
state. 🔬 Q2

## 10. Bounty lifecycle

![Bounty lifecycle: OPEN to SOLVED on a valid submit, or to REFUNDED after the deadline](docs/images/bounty-lifecycle.svg)

## 11. User flows

### Poster

```mermaid
flowchart TD
  A(["Open the app"]) --> B{"Wallet connected?"}
  B -->|no| B1["Connect a wallet"] --> C
  B -->|yes| C["Bounty board"]
  C --> D["Post a bounty"]
  D --> D1["Pick a checker template"]
  D1 --> D2["Enter parameters, reward, deadline"]
  D2 --> D3["Review screen:<br/>what goes public, what stays private"]
  D3 --> D4["Approve in wallet"]
  D4 --> E["My bounties"]
  E --> F{"Status"}
  F -->|"SOLVED"| G["Decrypt in the browser"] --> H["Read the answer, re-check it, export"]
  F -->|"OPEN, before deadline"| I["Wait: live updates from the indexer"]
  F -->|"OPEN, after deadline"| J["Refund"] --> J1["Approve in wallet"]
```

### Solver

```mermaid
flowchart TD
  A(["Open the app"]) --> B["Bounty board"]
  B --> C["Bounty detail:<br/>checker, parameters, reward, deadline"]
  C --> D["Enter an answer"]
  D --> E{"Pure checker passes<br/>locally?"}
  E -->|no| D
  E -->|yes| G["Submit: proof generated locally"]
  G --> H["Approve in wallet"]
  H --> I{"Result"}
  I -->|"accepted"| J["Paid: reward plus your coin back<br/>in the shielded balance"]
  I -->|"already solved or expired"| K["Failed: the transaction is rejected,<br/>so your coin stays in your wallet"]
```

### Screens

| Screen | Data source | Midnight piece |
|---|---|---|
| Bounty board | Indexer subscription on the template contracts | `indexerPublicDataProvider`, contract state stream |
| Post a bounty | Form, then a `postBounty` transaction | DApp Connector, proof server |
| "What goes public" review | Static, per template | Selective disclosure, made visible |
| Bounty detail | Ledger state | Public params, deadline countdown from block time |
| Solve | Pure checker, then one `submit`, with progress shown: proving alone takes about 11 s on an idle machine, and the whole call took 2.5 minutes in the Q6 browser run on a loaded laptop, wallet approval included | Local proving, witnesses, shielded coins |
| My bounties / inbox | Ledger state and private state | Private state store, pure-circuit decryption |
| Refund | `refund` transaction | Block time |

## 12. Transaction sequences

### Post a bounty

```mermaid
sequenceDiagram
  autonumber
  actor P as Poster
  participant UI as Bounty app
  participant St as Private state store
  participant PS as Proof server
  participant W as Wallet
  participant N as Node
  participant I as Indexer
  P->>UI: Template, parameters, reward, deadline
  UI->>St: Load or create poster secret and key b
  UI->>UI: posterPk = b·G, fresh reward coin info with a random nonce
  UI->>UI: Run postBounty in the JS runtime (witnesses read private state)
  UI->>PS: Prove postBounty
  PS-->>UI: Proof
  UI->>W: balanceUnsealedTransaction (wallet adds the reward coin and DUST fee)
  W->>N: submitTransaction
  N-->>I: Block with the new bounty
  I-->>UI: Board update via subscription
```

### Solve and get paid

```mermaid
sequenceDiagram
  autonumber
  actor S as Solver
  participant UI as Bounty app
  participant PS as Proof server
  participant W as Wallet
  participant C as Bounty contract
  participant I as Indexer
  S->>UI: Pick a bounty, enter an answer
  UI->>UI: Pure checker passes locally
  UI->>UI: Fresh solver coin with a random nonce
  UI->>UI: Run submit: checker, ECDH, encryption, receive the coin, merge it first, payout
  UI->>PS: Prove submit (answer, e and the coin's nonce stay local)
  PS-->>UI: Proof
  UI->>W: Balance, sign, submit
  W->>C: Transaction
  alt Bounty OPEN and before the deadline
    C->>C: Store E and c, status SOLVED
    C-->>W: Shielded payout coin (reward plus the solver's coin)
  else Already solved or expired
    C-->>W: Transaction fails, nothing is paid out
  end
  C-->>I: Indexed
```

### Read the answer

```mermaid
sequenceDiagram
  autonumber
  actor P as Poster
  participant UI as Bounty app
  participant St as Private state store
  participant I as Indexer
  I-->>UI: Subscription: bounty SOLVED with E and c
  UI->>St: Load key b
  UI->>UI: S = b·E (pure circuit: no proof, no transaction)
  UI->>UI: k = H(S, bountyId), m[i] = c[i] − H(k, i)
  UI->>UI: Re-run the pure checker on m as a sanity check
  UI->>P: Show the answer
```

### Refund after the deadline

```mermaid
sequenceDiagram
  autonumber
  actor P as Poster
  participant UI as Bounty app
  participant PS as Proof server
  participant W as Wallet
  participant C as Bounty contract
  P->>UI: Refund
  UI->>UI: Run refund: poster pseudonym, blockTimeGte(deadline), status OPEN
  UI->>PS: Prove refund
  PS-->>UI: Proof
  UI->>W: Balance, sign, submit
  W->>C: Transaction
  C-->>W: Escrow coin returned to the poster, status REFUNDED
```

### Private offer (v2)

```mermaid
sequenceDiagram
  autonumber
  actor Se as Seller
  participant C as Offer contract
  actor B as Buyer
  Se->>C: list: proof that checker(data) passes and c = Enc(k, data), commit(k)
  C-->>B: Listing shows "verified before you pay"
  B->>C: pay: escrow committed (price hidden), buyerPk, deadline
  B-->>Se: Escrow opening, encrypted to the seller (off-circuit)
  alt Seller claims before the deadline
    Se->>C: claim: kWrapped = k + H(ECDH(e, buyerPk)) for the committed k, reopen escrow
    C-->>Se: Shielded payout
    B->>B: Unwrap k, decrypt c
  else Deadline passes
    B->>C: refund: reopen own escrow commitment
    C-->>B: Escrow returned
  end
```

If the buyer sends a wrong opening, the seller can't claim, so they never reveal `kWrapped`, and
the buyer simply gets a refund. Neither side can cheat the other.

## 13. Midnight features: where each one does its job

```mermaid
flowchart LR
  PB(("Private<br/>Bounties"))
  PB --> C["<b>Contract</b><br/>Witnesses and private state<br/>Selective disclosure<br/>In-circuit checker<br/>Jubjub key exchange<br/>Verifiable encryption<br/>Committed shielded escrow<br/>Block time deadlines<br/>Modules and pure circuits"]
  PB --> P["<b>Protocol</b><br/>Zswap shielded coins<br/>Atomic transactions<br/>DUST fees"]
  PB --> T["<b>Tooling</b><br/>Local proof server<br/>Compact 0.31.1"]
  PB --> A["<b>App</b><br/>DApp Connector<br/>Indexer subscriptions<br/>midnight-js providers<br/>Persistent private state"]
```

| Feature | Its job here | In midnight-examples today (`cb250c9`) |
|---|---|---|
| Witnesses and private state | Answer, `e`, the solver's coin nonce and key `b` never leave the device | Every example |
| Selective disclosure (`disclose`) | Only `E`, `c`, status and commitments go public | Every example |
| Commitments and hashing (`persistentHash`, `transientHash`) | Pseudonyms, checker, keystream | Many |
| ZK check of off-chain data | The checker runs inside the proof, before payout | zk-loan, calculator |
| Jubjub ops in-circuit (`ecMulGenerator`, `ecMul`) | Key exchange to the poster | **New use.** Only zk-loan, to verify Schnorr signatures |
| Verifiable encryption | Proves `c` encrypts the checked answer | **New** |
| Shielded escrow (`receiveShielded`, `insertCoin`, `mergeCoin`, `sendShielded`) | Reward escrow and unlinkable payout, in one transaction for the solver | shielded-chips (committed player escrow), private-tip-jar, token-transfers. **New here:** a third party claims, and in v2 the price is hidden |
| Block time (`blockTimeLt`, `blockTimeGte`) | Submit window and refund, in Unix seconds (verified) | **New.** No example uses it |
| Modules (`import ... prefix`) | Shared building blocks | zk-loan only |
| Pure circuits in JS | Browser pre-check and decryption with the exact circuit math | zk-loan (`schnorrChallenge`) |
| Shielded token minting (`mintShieldedToken`) | Test reward token | private-tip-jar, shielded-chips, token-transfers |
| Domain-separated pseudonyms | Unlinkable posters and solvers | shielded-chips and others |
| Atomic transactions | Delivery and payout land together or not at all | Implicit everywhere, central here |
| Local proof server | Private inputs proven on the user's machine | Every example |
| DApp Connector | Balancing, signing, submitting, endpoints | Example UIs |
| Indexer subscriptions | Live bounty board | Example UIs |

### What happens inside one `submit`

```mermaid
flowchart LR
  subgraph Device["Solver's device"]
    W1["Witnesses:<br/>answer, e, the solver's coin nonce"]
    JS["JS runtime runs the circuit"]
    PS["Proof server proves it"]
  end
  subgraph Chain["Midnight"]
    V["Node verifies the proof"]
    L["Ledger: E, c, status"]
    Z["Zswap: nullifiers and<br/>coin commitments only"]
    T["Block time check"]
  end
  subgraph Wallet["Wallet"]
    B["Balance with DUST fee"]
  end
  W1 --> JS --> PS --> B --> V
  V --> T
  V --> L
  V --> Z
```

## 14. Privacy model

| Data | Who can see it |
|---|---|
| The answer | Solver; poster after decryption. On-chain only as ciphertext |
| Checker parameters, deadline | Public |
| Reward amount (open bounty) | Public, by design |
| Escrow coin (open bounty) | Public: nonce, value and tree position. A fresh coin, so it doesn't point at the poster's wallet |
| Which action a pseudonym took | Public: the indexer shows each transaction's circuit name (`postBounty`, `submit`, `refund`) |
| Price (private offer, v2) | Buyer and seller only 🔬 Q2 |
| Poster identity | A pseudonym per bounty (it hashes in the bounty ID), and a separate encryption key per bounty. The wallet isn't linked, and a poster's bounties can't be grouped. An earlier version used one pseudonym per deployment; the audit caught it |
| Solver identity | Nothing on chain identifies the solver at all |
| Payout destination | Shielded coin, unlinkable because the solver's coin is merged first (section 9). Verified on a local devnet for both versions |
| Refund destination | Linkable only by someone who already suspects the poster's wallet (v1 limit) |
| Poster key `b`, solver scalar `e` | Private state, and `e` is discarded after proving |
| Fees | Paid in DUST |
| Metadata | Timing and transaction graph. Not hidden by the app |

## 15. Threat model

| Threat | Mitigation |
|---|---|
| Solver submits a wrong answer | The checker runs in the circuit, so no valid proof means no payout |
| Solver encrypts garbage or uses the wrong key | The proof binds `c` to `posterPk` through ECDH and the keystream |
| Poster refuses to pay | Can't block a valid payout: payout and delivery are one transaction |
| Poster claims their own bounty | A poster who knows an answer (always for `preimage`, and for `factor` when they generated N) can submit it themselves and take the reward back before the deadline. A solver loses effort but no funds. This can't be prevented in-circuit, so it is a stated trust assumption for those templates |
| Poster refunds early | `refund` requires `blockTimeGte(deadline)` |
| Solver submits late | `submit` requires `blockTimeLt(deadline)` |
| Two solvers race | The first to land wins. Both spend the same escrow coin, so the node rejects the other transaction whole and the losing solver's coin never leaves their wallet (verified, Q5) |
| Copying a pending submission | Nothing to copy: the answer is encrypted and the payout is bound in the proof |
| Payout traced to the solver's wallet | Solver's fresh coin merged first (section 9) |
| Escrow traced to the poster's wallet | The app always builds the escrow as a fresh coin with a random nonce, never a wallet coin's nonce |
| Concurrent calls from one user | Calls run one at a time, with one private-state store per user (two at once collided on the store's lock in Q2) |
| Small answer space | The checker itself can leak the answer (a 4-digit PIN can be brute-forced). In `preimage` the target is the answer's public hash, so a short answer can be found by hashing guesses, and the same answer posted twice shows the same target (seen in Q6). The UI warns about short and reused answers, and templates avoid it |
| Field wraparound in a checker | Checkers use bounded `Uint` arithmetic (`p × q = N` with no modular wrap) |
| Invalid or low-order `posterPk` or `issuerPk` | `postBounty` rejects them: the proof checks the key is on the curve and in the prime-order subgroup, and an assert rejects the identity point, which would make every shared key public |
| Biased issuer signatures | `signing.ts` draws Schnorr nonces uniformly modulo the subgroup order. An earlier version drew them from 248 bits, which leaks enough to recover an issuer's key from roughly a hundred signatures |
| A signature made for another app | Signed-record bounties pin a schema tag in `record[0]`, so a zk-loan attestation from the same issuer doesn't qualify |
| A submit that lands after the deadline | Rejected whole, with the solver's coin left in their wallet (devnet test D5). The UI warns near the deadline, because a submit takes minutes to prove, approve and land (2.5 minutes in the Q6 browser run) |
| A wallet or hosted prover sees the proof's inputs | The app proves locally by default. Choosing wallet proving shows a warning first, because the wallet, or the hosted service it may use, sees the secret inputs: the poster's identity secret, or the solver's answer and coin (Q10) |
| Bounty ID squatting | Someone who sees a pending ID can post first with the same ID ("Bounty already exists"). Denial of service only; the app retries with a fresh ID |
| Poster loses key `b` | An encrypted backup or export of the private state |
| `transientHash` changes at a hard fork | The poster's app decrypts as soon as a bounty is solved, keeps the plaintext, and pins its runtime version |
| A buyer re-shares purchased data (v2) | Inherent to selling data. Out of scope |

## 16. Checker templates (v1)

| Template | The bounty asks for | Public parameters | Private answer | Why it's in v1 |
|---|---|---|---|---|
| `preimage` | x with `transientHash(x) = target` | target | x | Smallest circuit, used by the spike |
| `factor` | p, q > 1 with `p × q = N` | N (4 to 2^128 − 1, range-checked at post time), in the same `target` slot | p (smaller, 64-bit) and q (128-bit) | The classic ZKCP demo. Built: the product stays below 2^192, so fake factors that only multiply to N modulo the field fail, and every factorisation of a valid N can be submitted |
| `signed-record` | An issuer-signed record of a given type whose field f ≥ X | issuer key, schema tag, f (1 to 3), X | Record and signature | Real data-marketplace use. Built: zk-loan's Schnorr module verifies the signature in-circuit, `record[0]` must equal the bounty's schema tag so signatures made for other purposes don't qualify, and f is compared as a 64-bit integer. Binding a record to a subject is the issuer's job |

Rule from Q1: checkers use `transientHash` wherever they can. A SHA-256 (`persistentHash`)
checker made the core circuit 8x bigger (k = 14 instead of 11) and about 3x slower to prove.

## 17. Target stack

| Component | Version |
|---|---|
| Compact compiler | 0.31.1 (`compact compile +0.31.1 ...`) |
| `@midnight-ntwrk/compact-runtime` | 0.16.0 (what 0.31.1 output checks for) |
| midnight-js | 4.1.1 |
| DApp Connector API | 4.0.1 |
| `ledger-v8` | 8.1.x |
| `wallet-sdk-facade` | 4.1.0, pinned (the npm `latest` tag still points to 4.0.1) |
| Node / indexer / proof server | 1.0.400 / indexer-standalone 4.3.3 / 8.1.0 |
| Networks | Local, then Preview, then Preprod (the spike devnet ran node 1.0.0, as in the examples' compose) |
| Block time | Seconds since the Unix epoch (`blockTimeLt`/`Gte` take a `Uint<64>`) |

## 18. Open questions and spike results

| # | Question | Status | Result |
|---|---|---|---|
| Q1 | Is `submit` provable in reasonable time and size? | ✅ Answered | Crypto core k = 11, proves in 0.4 s on an idle runner; SHA-256 checker k = 14. [Results](spike/q1-proof-size/RESULTS.md) |
| Q2 | What exactly is public after `postBounty`, `submit`, `refund`? | ✅ Answered | Escrow coin public as designed; solver's coin, payout nonce and wallet keys never public; action names public. [Results](spike/q2-escrow/RESULTS.md) |
| Q3 | Can a coin received in the same transaction be the **first** merge input? | ✅ Works | One-transaction `submit` paid out on a local devnet, no effects-budget error. [Results](spike/q2-escrow/RESULTS.md) |
| Q3b | Does the one-transaction payout pass the same leak check as Q2? | ✅ Answered | Yes: solver's coin, payout nonce, wallet keys and secret never public. [Results](spike/q2-escrow/RESULTS.md) |
| Q4 | Do pure circuits off-chain reproduce the circuit's `ecMul` and `transientHash`? | ✅ Answered | Poster decrypts exactly; a wrong key doesn't (JS runtime). [Results](spike/q1-proof-size/RESULTS.md) |
| Q5 | Does a failing `submit` leave no partial state? | ✅ Answered | Bad calls are rejected before proving. Racing submits: one wins, the other is rejected whole and the loser keeps their coin. [Results](spike/q2-escrow/RESULTS.md) |
| Q6 | Can the wallet (Lace, 1AM) balance a transaction that pays in and receives a payout? | ✅ Yes with 1AM | On Preview, 1AM funded the reward escrow from the poster's shielded tokens, and a solver holding none of the token submitted with a zero-value coin and received the reward. Refund and in-browser decryption worked too. Two first attempts failed inside the wallet and passed on retry, so the UI offers a retry. Lace not run yet. [Results](spike/q6-wallet/RESULTS.md) |
| Q7 | Block time units and drift | ✅ Answered | Unix seconds; deadline checks enforced on chain. [Results](spike/q2-escrow/RESULTS.md) |
| Q8 | Persistent, encrypted browser private state | ✅ Answered | The UI template's store (midnight-js's LevelDB provider on IndexedDB, passphrase-encrypted, per wallet account) kept the poster's identity secret and key seed across re-joins on Preview: refund and decrypt both worked afterwards. midnight-examples checked the reload round trip and wrong-passphrase refusal for the same store. [Results](spike/q6-wallet/RESULTS.md) |
| Q9 | `JubjubPoint` and vectors inside ledger map values | ✅ Answered | Stored in `Bounty` and `Delivery` structs, read back and decrypted in the runtime. [Results](spike/q11-full-submit/RESULTS.md) |
| Q10 | Which prover may a user's wallet use? | ✅ Decided | Every circuit has secret inputs, so the app proves on a local proof server by default. Wallet proving is an opt-in, with a warning that the wallet, and any hosted prover it uses, sees the proof's inputs (on the solve screen, the answer). It isn't blocked, so users without a local proof server aren't shut out |
| Q11 | Cost of the full `submit` (checker, key exchange, encryption, escrow) | ✅ Answered | k = 16, about 11 s to prove on an idle runner; the escrow sets the size. [Results](spike/q11-full-submit/RESULTS.md) |
| Q12 | Can a solver's coin be zero-value? | ✅ Answered | Yes: a solver holding none of the reward token submitted with a zero-value coin, was paid in full, and the payout passed the Q2 leak checks. Solvers don't need the token, and the contracts accept a zero-value solver coin (the reward must still be non-zero). [Results](spike/q2-escrow/RESULTS.md) |

## 19. Build plan (tentative)

```mermaid
flowchart LR
  W1["Week 1<br/>Oct 21 to 27<br/><br/>Spike<br/>Q1 to Q9"]
  W2["Weeks 2 and 3<br/>Oct 28 to Nov 10<br/><br/>Contract<br/>modules, templates,<br/>unit and adversarial tests"]
  W4["Weeks 4 and 5<br/>Nov 11 to 24<br/><br/>UI and security pass<br/>board, post, solve,<br/>inbox, decrypt, refund"]
  W6["Week 6<br/>Nov 25 to Dec 1<br/><br/>Preprod run,<br/>demo and write-up"]
  W7["December<br/><br/>Split into examples<br/>once fully tested"]
  W1 --> W2 --> W4 --> W6 --> W7
  W1 -.->|"if Q1 or Q2 fails"| R["Shrink the payload<br/>or rework the escrow,<br/>then re-run the spike"]
  R -.-> W1
```

| Phase | Dates | Exit criteria |
|---|---|---|
| Spike | Oct 21 to 27 | Q1 to Q9 answered with numbers, or a design change agreed |
| Contract | Oct 28 to Nov 10 | Three templates, simulator tests plus adversarial cases passing |
| UI and security | Nov 11 to 24 | Full flow working on the local network, security pass done |
| Preprod and demo | Nov 25 to Dec 1 | End-to-end run on Preprod, demo recorded, write-up drafted |
| Examples | December | Modules split out with their own tests and docs |

## 20. Splitting into examples

Only after the full app is built and thoroughly tested:

```mermaid
flowchart LR
  PB["Private Bounties<br/>full app"]
  PB --> X1["In-circuit key exchange<br/>ECDH on Jubjub"]
  PB --> X2["Verifiable encryption<br/>keystream proven in a circuit"]
  PB --> X3["Third-party escrow claim<br/>with an unlinkable payout"]
  PB --> X4["Deadlines and refunds<br/>with block time"]
  PB --> X5["Persistent browser<br/>private state"]
```

## 21. References

- Atomic and Fair Data Exchange via Blockchain, ACM CCS 2024: https://dl.acm.org/doi/10.1145/3658644.3690248
- cont-pay, a ZKCP prototype (CCS 2020): https://github.com/security-kouza/cont-pay
- Algebraic Zero-Knowledge Contingent Payment: https://eprint.iacr.org/2024/1930.pdf
- SmartZKCP, practical attacks on ZKCP marketplaces: https://www.sciencedirect.com/science/article/pii/S209672092400085X
- Compact standard library at `compactc-v0.31.1`: https://github.com/LFDT-Minokawa/compact/blob/compactc-v0.31.1/compiler/standard-library.compact
- midnight-examples `shielded-chips/contract/roulette.compact`: committed escrow and payout-nonce privacy
- midnight-examples `zk-loan/contract/schnorr.compact`: Jubjub ops, scalar reduction, modules, pure circuits
- Midnight docs: https://docs.midnight.network
