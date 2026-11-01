# Spike Q14: can the UI read a contract's history from the indexer?

**Question:** the board's activity feed, "posted 2h ago", and the amounts of solved bounties need
more than the contract's current state. Can the indexer list a contract's past transactions,
with times?

**Answer: yes.** `contract(address) { actions(limit) }` on the Preview indexer (API v4) returns
every action on a contract, newest first:
- the circuit that ran (`entryPoint`);
- the block height and timestamp;
- the full contract state after the action.

Two limits matter for the UI:
- **Paging.** `actions` takes a `limit` but no offset, and passing a block offset to `contract`
  doesn't page it.
- **Which bounty.** An action names the circuit, not the bounty it touched.

## Setup

- The Preview indexer at `https://indexer.preview.midnight.network/api/v4/graphql`, queried
  with plain HTTP POSTs on 2026-11-01. The schema came from introspection.
- The contract is the bounty contract from the Q6 wallet run,
  `04713ab8f8e99c95d87889a11b239aeb5acccc5f8a192f2d33a96838092fd32e`.

## The query

```graphql
{
  contract(address: "04713ab8f8e99c95d87889a11b239aeb5acccc5f8a192f2d33a96838092fd32e") {
    actions(limit: 20) {
      __typename
      ... on ContractCall { entryPoint }
      state
      transaction { hash block { height timestamp } }
    }
  }
}
```

## Results

| Action | Circuit | Block | Timestamp (UTC) | State after |
|---|---|---|---|---|
| ContractCall | `submit` | 1491862 | 2026-10-28 07:34:12 | 8,900 bytes |
| ContractCall | `postBounty` | 1491825 | 2026-10-28 07:30:30 | 8,630 bytes |
| ContractCall | `refund` | 1491802 | 2026-10-28 07:28:12 | 7,712 bytes |
| ContractCall | `postBounty` | 1491466 | 2026-10-28 06:54:36 | 8,039 bytes |
| ContractDeploy | | 1491370 | 2026-10-28 06:45:00 | 7,199 bytes |

- That's every transaction on the contract. The block heights match
  [the Q6 results](../q6-wallet/RESULTS.md). Q6's first, failed attempts left no actions behind.
- The timestamps are in **milliseconds**. The contract's block-time checks use seconds (Q7).
- Each `state` is the whole contract state: about 7.2 KB when nothing is posted, and a few hundred
  bytes more for each bounty.

### Paging

I asked for `contract(address, offset: {height: 1491802}) { actions(limit: 2) }`. It returned the
same two latest actions as the query without an offset. So the offset changes the contract state
that's returned, not which actions are listed.

Two ways to reach older history, neither tested:
- a large `limit`;
- the `contractActions(address, offset: BlockOffset)` subscription, which midnight-js uses to
  replay a contract from a block.

## Consequences for the UI

- **Activity feed:** this works now. Ask for the last 20 actions. To say which bounty each one
  touched, decode the state before and after it, and compare the bounty maps.
  - A new key in the map is a post.
  - A changed status is a solve or a refund.

  For 20 actions that's about 20 states of under 10 KB each.
- **"Posted 2h ago" and the amounts of solved bounties:** working these out from history means
  replaying every action back to the deploy, which grows with the board. It's simpler to write
  both into the bounty's `listings` entry at post time:
  - **The amount:** the reward is public anyway.
  - **The post time, checked against block time:** the poster passes it, and the circuit asserts
    it lies within a few minutes before the block time. That's the two-sided check from Q13,
    pointed the other way. I haven't tested this.

## Not covered yet

- Paging through long histories (the subscription replay).
- Reading the bounty ID straight from a transaction's raw bytes, instead of comparing states.
- How fast the indexer answers for a contract with many actions.
