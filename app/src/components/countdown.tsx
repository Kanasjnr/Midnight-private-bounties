import { useNow } from "~/hooks/use-now";
import { deadlineText, span } from "~/lib/format";

/**
 * A deadline counting down each second. It reads its own one-second clock, so
 * only this text rerenders on a tick; the page around it uses the session's
 * slower clock. `bare` drops the "Ends in" / "Ended … ago" wording.
 */
export function Countdown({ deadline, bare = false }: { deadline: bigint; bare?: boolean }) {
  const now = useNow(1_000);
  if (!bare) return <>{deadlineText(deadline, now)}</>;
  return <>{deadline > now ? span(deadline - now) : `${span(now - deadline)} ago`}</>;
}
