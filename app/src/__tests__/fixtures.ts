import { Status, type BountyView } from "@/midnight/private-bounties-api";

let n = 0;
/** A board row with sensible defaults; ids are unique per call. */
export function view(over: Partial<BountyView> = {}): BountyView {
  const i = ++n;
  const id = new Uint8Array(32).fill(i);
  return {
    id,
    idHex: Array.from(id, (b) => b.toString(16).padStart(2, "0")).join(""),
    title: `Bounty ${i}`,
    details: `Question ${i}`,
    status: Status.OPEN,
    deadline: 10_000n,
    postedAt: 1_000n,
    target: BigInt(i),
    reward: 100n,
    mine: false,
    ...over,
  };
}
