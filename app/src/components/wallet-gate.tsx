import type { ReactNode } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { href } from "~/router";
import { useSession } from "~/session";
import { LinkButton, Panel } from "~/components/ui";

/** True when this browser can act on the board shown: a wallet, an unlocked store, and the board joined. */
export function useCanAct(): boolean {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { browsing } = useSession();
  return status === "connected" && !locked && !browsing;
}

/** Its children once this browser can act on the board; until then, what's missing and a way to fix it. */
export function WalletGate({ doing, children }: { doing: string; children: ReactNode }) {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { deployment } = useSession();
  const canAct = useCanAct();
  if (canAct) return <>{children}</>;
  const ready = status === "connected" && !locked;
  return (
    <Panel className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
      <span className="text-muted">
        {ready ? `Join this board to ${doing}.` : `To ${doing}, connect a wallet${status === "connected" ? " and unlock this browser's store" : ""}.`}
      </span>
      {ready ? (
        <LinkButton href={href({ name: "setup" })} variant="ghost">
          {deployment.busy === "joining" ? "Joining…" : "Go to setup"}
        </LinkButton>
      ) : (
        <LinkButton href={href({ name: "setup" })}>{status === "connected" ? "Unlock" : "Connect a wallet"}</LinkButton>
      )}
    </Panel>
  );
}
