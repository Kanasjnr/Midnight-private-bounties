import { useWallet } from "@/hooks/use-wallet";
import { Status } from "@/midnight/private-bounties-api";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { isActive, yours } from "~/lib/board";
import { amount } from "~/lib/format";
import { href } from "~/router";
import { useSession } from "~/session";
import { BountyTable } from "~/components/bounty-table";
import { Loading } from "~/pages/board";
import { Amount, LinkButton } from "~/components/ui";

export function MinePage() {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { deployment, state, views, now, solvedHere, read } = useSession();

  if (status !== "connected" || locked || !deployment.address) {
    return (
      <div className="flex flex-col items-start gap-4 py-16">
        <p className="m-0 text-lg text-muted">Your bounties are recognized from keys in this browser's store, so connect and unlock it first.</p>
        <LinkButton href={href({ name: "setup" })}>Get set up</LinkButton>
      </div>
    );
  }
  if (!state) return <Loading what="Reading the board from the indexer" error={deployment.error} />;

  const address = deployment.address;
  const order = (b: (typeof views)[number]) =>
    b.status === Status.SOLVED && !read.set.has(b.idHex) ? 0 : b.status === Status.OPEN && now >= b.deadline ? 1 : isActive(b, now) ? 2 : 3;
  const posted = views.filter((b) => b.mine).sort((a, b) => order(a) - order(b));
  const solved = views.filter((b) => !b.mine && solvedHere.set.has(b.idHex));
  const you = yours(views, now, solvedHere.set, read.set);

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-end justify-between gap-6">
        <div className="flex max-w-[640px] flex-col gap-2">
          <h1 className="m-0 text-4xl font-semibold tracking-tight">My bounties</h1>
          <p className="m-0 text-muted">
            The chain doesn't record who posted or solved a bounty. This browser recognizes yours from the keys in its store, and
            remembers the ones it solved.
          </p>
        </div>
        <LinkButton href={href({ name: "post" })}>Post a bounty</LinkButton>
      </header>

      <section aria-labelledby="posted" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="posted" className="m-0 text-xl font-semibold">
            Posted by you
          </h2>
          <span className="text-sm text-muted">
            {you.answersToRead > 0 && `${you.answersToRead} to read · `}
            {you.refundCount > 0 && `${amount(you.refundReady)} TEST to refund · `}
            {you.waiting} waiting
          </span>
        </div>
        <BountyTable rows={posted} address={address} now={now} empty="You haven't posted on this board from this browser." />
      </section>

      <section aria-labelledby="solved" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="solved" className="m-0 text-xl font-semibold">
            Solved here
          </h2>
          <span className="text-sm text-muted">
            Earned <Amount value={amount(you.earned)} />
          </span>
        </div>
        <BountyTable rows={solved} address={address} now={now} empty="Nothing solved from this browser yet." />
      </section>
    </div>
  );
}
