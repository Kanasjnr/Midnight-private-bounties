import { useNow } from "~/hooks/use-now";
import { span } from "~/lib/format";

/**
 * A deadline counting down each second. It reads its own one-second clock, so
 * only this text rerenders on a tick; the page around it uses the session's
 * slower clock. `bare` drops the wording; `before` and `after` change it
 * ("Ends in 3h 12m", "Ended 1d ago" by default).
 */
export function Countdown({ deadline, bare = false, before = "Ends in", after = "Ended" }: { deadline: bigint; bare?: boolean; before?: string; after?: string }) {
  const now = useNow(1_000);
  if (deadline > now) return <>{bare ? span(deadline - now) : `${before} ${span(deadline - now)}`}</>;
  const past = now - deadline < 60n ? "just now" : `${span(now - deadline)} ago`;
  return <>{bare ? past : `${after} ${past}`}</>;
}
