import { useState } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { NIGHT_COLOR } from "@/lib/tokens";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { amount, short, SPECK_PER_DUST, STAR_PER_NIGHT, units } from "~/lib/format";
import { href, type Route } from "~/router";
import { useSession } from "~/session";
import { Button, cx, Dot, LinkButton } from "~/components/ui";

const NETWORK_NAMES: Record<string, string> = { undeployed: "Local devnet", preview: "Preview", preprod: "Preprod", mainnet: "Mainnet" };

export function networkName(id: string | null): string {
  return id ? (NETWORK_NAMES[id] ?? id) : "Not connected";
}

export function Logo() {
  return (
    <a href={href({ name: "board" })} className="inline-flex items-center gap-2.5 text-[17px] font-bold tracking-tight text-fg no-underline">
      <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
        <rect x="9" y="9" width="6" height="6" rx="1" fill="var(--color-brand)" />
      </svg>
      Private Bounties
    </a>
  );
}

export function TopBar({ route }: { route: Route }) {
  const { status, networkId, requestedNetworkId } = useWallet();
  const { locked } = useMidnightProviders();
  const { items } = useSession();
  const connected = status === "connected";
  const ready = connected && !locked;
  const toRead = items.filter((b) => b.needs !== null).length;

  const tabs: { route: Route; label: string; badge?: number }[] = [
    { route: { name: "board" }, label: "Board" },
    { route: { name: "mine" }, label: "My bounties", badge: toRead },
  ];

  return (
    <header className="border-b border-line bg-page">
      <div className="mx-auto flex min-h-16 max-w-[1240px] flex-wrap items-center gap-x-7 gap-y-3 px-4 py-3 sm:px-8">
        <Logo />
        <nav aria-label="Main" className="flex flex-wrap gap-6">
          {tabs.map((t) => {
            const on = t.route.name === route.name || (t.route.name === "board" && (route.name === "bounty" || route.name === "work"));
            return (
              <a
                key={t.label}
                href={href(t.route)}
                aria-current={on ? "page" : undefined}
                className={cx("inline-flex items-center gap-2 font-medium no-underline transition-colors hover:text-fg", on ? "text-fg" : "text-muted")}
              >
                {t.label}
                {t.badge ? <span className="rounded bg-chip px-1.5 font-mono text-xs text-fg">{t.badge}</span> : null}
              </a>
            );
          })}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          <span className="inline-flex h-9 items-center gap-2 px-1 text-sm text-muted">
            <Dot tone={connected ? "ok" : "muted"} />
            {networkName(connected ? networkId : requestedNetworkId)}
          </span>
          {connected && <Balances />}
          {connected ? <Account /> : <LinkButton href={href({ name: "setup" })} variant="ghost">Connect wallet</LinkButton>}
          <LinkButton href={href(ready ? { name: "post" } : { name: "setup" })}>Post a bounty</LinkButton>
        </div>
      </div>
    </header>
  );
}

/** NIGHT, DUST and the reward token, the three balances a user needs here. */
function Balances() {
  const { balances, dust, rewardBalance } = useSession();
  const night = balances?.unshielded[NIGHT_COLOR];
  const cell = "inline-flex items-baseline gap-1.5 px-3.5";
  const sep = <span aria-hidden="true" className="h-4 w-px bg-line-strong" />;
  return (
    <div aria-label="Wallet balances" className="inline-flex h-9 items-center rounded-full border border-line bg-surface text-sm">
      <span className={cell} title="Unshielded NIGHT">
        <span className="font-mono font-medium">{night === undefined ? "–" : units(night, STAR_PER_NIGHT)}</span>
        <span className="text-muted">NIGHT</span>
      </span>
      {sep}
      <span className={cell} title="DUST pays the network fees">
        <span className="font-mono font-medium">{dust ? units(dust.balance, SPECK_PER_DUST, 1) : "–"}</span>
        <span className="text-muted">DUST</span>
      </span>
      {rewardBalance !== null && (
        <>
          {sep}
          <span className={cx(cell, "items-center")} title="The board's reward token, shielded: only you see this balance">
            <Lock aria-hidden="true" className="size-3 text-private" strokeWidth={2.4} />
            <span className="font-mono font-medium">{amount(rewardBalance)}</span>
            <span className="text-muted">TEST</span>
          </span>
        </>
      )}
    </div>
  );
}

function Account() {
  const { shieldedAddress, wallets, selectedWalletKey, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const name = wallets.find((w) => w.key === selectedWalletKey)?.name ?? "Wallet";

  return (
    <div className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-line-strong pr-3.5 pl-1 text-sm font-medium transition-colors hover:border-line-hover"
      >
        <span aria-hidden="true" className="inline-flex size-7 items-center justify-center rounded-full bg-chip text-[11px] font-bold">
          {name.slice(0, 2).toUpperCase()}
        </span>
        {name}
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </button>
      {open && (
        // Clicking anywhere outside the menu lands on this backdrop and closes it.
        <div aria-hidden="true" className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
      )}
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-2 flex w-72 flex-col gap-1 rounded-lg border border-line bg-surface p-2 shadow-xl shadow-black/40">
          <div className="px-2 py-1.5 text-xs text-faint">
            Shielded address
            <div className="mt-0.5 font-mono text-[12px] break-all text-fg-2">{shieldedAddress ? short(shieldedAddress, 18, 8) : "–"}</div>
          </div>
          <a role="menuitem" href={href({ name: "setup" })} onClick={() => setOpen(false)} className="rounded-md px-2 py-1.5 text-sm text-fg no-underline hover:bg-chip">
            Setup and proving
          </a>
          <Button
            role="menuitem"
            variant="quiet"
            className="justify-start rounded-md px-2 py-1.5 text-left font-medium text-fg hover:bg-chip hover:text-fg"
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
          >
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}
