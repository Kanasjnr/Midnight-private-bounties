import { useSession } from "~/session";
import { Button } from "~/components/ui";

/**
 * Mints test tokens from where they're needed (a post form), when this
 * browser knows the board's token. Test tokens carry no value; anyone can mint.
 */
export function MintButton({ amount = 1_000n }: { amount?: bigint }) {
  const { canMint, mint, deployment } = useSession();
  if (!canMint) return <span className="text-[13px] text-muted">Ask the board's owner for some TEST.</span>;
  return (
    <Button variant="ghost" size="sm" disabled={deployment.busy !== null} busy={deployment.busy === "Minting test tokens"} onClick={() => void mint(amount)}>
      Mint {amount.toLocaleString("en-US")} TEST
    </Button>
  );
}
