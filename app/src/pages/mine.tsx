import { useWallet } from "@/hooks/use-wallet";
import { useMidnightProviders } from "@/providers/midnight-providers";
import type { BoardItem, Need } from "~/lib/items";
import { amount } from "~/lib/format";
import { href } from "~/router";
import { useSession } from "~/session";
import { BountyTable } from "~/components/bounty-table";
import { Loading } from "~/pages/board";
import { Amount, LinkButton } from "~/components/ui";
import { MyActivity } from "~/components/my-activity";

// What needs doing first, then what's waiting, then what's done.
const ORDER: Record<Need, number> = { review: 0, read: 1, deliver: 2, collect: 3, refund: 4 };
const rank = (b: BoardItem) => (b.needs ? ORDER[b.needs] : b.active ? 10 : 20);

export function MinePage() {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { deployment, state, items, now } = useSession();

  if (status !== "connected" || locked || !deployment.address) {
    return (
      <div className="flex flex-col items-start gap-4 py-16">
        <p className="m-0 text-lg text-muted">Your bounties are recognized from keys in this browser's store, so connect and unlock it first.</p>
        <LinkButton href={href({ name: "setup" })}>Get set up</LinkButton>
      </div>
    );
  }
  if (!state) return <Loading what="Reading the board from the indexer" error={deployment.error} />;

  const sorted = [...items].sort((a, b) => rank(a) - rank(b));
  const posted = sorted.filter((b) => b.mine);
  const working = sorted.filter((b) => b.working && !b.paid);
  const done = sorted.filter((b) => b.earnedHere);
  const earned = done.reduce((a, b) => a + (b.reward ?? 0n), 0n);
  const needing = posted.filter((b) => b.needs).length;

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex max-w-[640px] flex-col gap-2">
          <h1 className="m-0 text-3xl font-semibold tracking-tight">My bounties</h1>
          <p className="m-0 text-muted">
            The chain doesn't record who posted, solved or did a bounty. This browser recognizes yours from the keys in its store, and
            remembers the answers it solved.
          </p>
        </div>
        <LinkButton href={href({ name: "post" })}>Post a bounty</LinkButton>
      </header>

      <MyActivity />

      <section aria-labelledby="posted" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="posted" className="m-0 text-xl font-semibold">
            Posted by you
          </h2>
          <span className="text-sm text-muted">{needing > 0 ? `${needing} need you` : "Nothing needs you"}</span>
        </div>
        <BountyTable rows={posted} now={now} empty="You haven't posted on this board from this browser." />
      </section>

      <section aria-labelledby="working" className="flex flex-col gap-3">
        <h2 id="working" className="m-0 text-xl font-semibold">
          Working on
        </h2>
        <BountyTable rows={working} now={now} empty="No reviewed work is assigned to you." />
      </section>

      <section aria-labelledby="earned" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="earned" className="m-0 text-xl font-semibold">
            Paid to you here
          </h2>
          <span className="text-sm text-muted">
            Earned <Amount value={amount(earned)} />
          </span>
        </div>
        <BountyTable rows={done} now={now} empty="Nothing paid to this browser yet." />
      </section>
    </div>
  );
}
