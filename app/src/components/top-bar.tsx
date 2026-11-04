import { useState } from "react";
import { ChevronDown, Lock } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { NIGHT_COLOR } from "@/lib/tokens";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { amount, short, SPECK_PER_DUST, STAR_PER_NIGHT, units } from "~/lib/format";
import { href, type Route } from "~/router";
import { useSession } from "~/session";
import { Button, cx, Dot, LinkButton } from "~/components/ui";
import { Notifications } from "~/components/my-activity";

const NETWORK_NAMES: Record<string, string> = { undeployed: "Local devnet", preview: "Preview", preprod: "Preprod", mainnet: "Mainnet" };

export function networkName(id: string | null): string {
  return id ? (NETWORK_NAMES[id] ?? id) : "Not connected";
}

export function Logo() {
  return (
    <a href={href({ name: "board" })} className="inline-flex items-center gap-2 text-[15px] font-semibold tracking-tight text-fg no-underline">
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
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
    <header className="sticky top-0 z-20 border-b border-line bg-page/85 backdrop-blur-md">
      <div className="mx-auto flex min-h-14 max-w-[1240px] flex-wrap items-center gap-x-8 gap-y-3 px-4 py-2.5 sm:px-8">
        <Logo />
        <nav aria-label="Main" className="flex flex-wrap gap-1">
          {tabs.map((t) => {
            const on = t.route.name === route.name || (t.route.name === "board" && (route.name === "bounty" || route.name === "work"));
            return (
              <a
                key={t.label}
                href={href(t.route)}
                aria-current={on ? "page" : undefined}
                className={cx("inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-sm font-medium no-underline transition-colors hover:text-fg", on ? "bg-chip text-fg" : "text-muted")}
              >
                {t.label}
                {t.badge ? <span className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-fg px-1 text-[11px] font-medium text-on-fg tabular">{t.badge}</span> : null}
              </a>
            );
          })}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="inline-flex h-8 items-center gap-2 px-1 text-[13px] text-muted">
            <Dot tone={connected ? "ok" : "muted"} />
            {networkName(connected ? networkId : requestedNetworkId)}
          </span>
          {connected && <Balances />}
          {ready && <Notifications />}
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
  const cell = "inline-flex items-baseline gap-1.5 px-3";
  const sep = <span aria-hidden="true" className="h-4 w-px bg-line-strong" />;
  return (
    <div aria-label="Wallet balances" className="inline-flex h-8 items-center rounded-md border border-line bg-surface text-[13px]">
      <span className={cell} title="Unshielded NIGHT">
        <span className="tabular font-medium">{night === undefined ? "–" : units(night, STAR_PER_NIGHT)}</span>
        <span className="text-muted">NIGHT</span>
      </span>
      {sep}
      <span className={cell} title="DUST pays the network fees">
        <span className="tabular font-medium">{dust ? units(dust.balance, SPECK_PER_DUST, 1) : "–"}</span>
        <span className="text-muted">DUST</span>
      </span>
      {rewardBalance !== null && (
        <>
          {sep}
          <span className={cx(cell, "items-center")} title="The board's reward token, shielded: only you see this balance">
            <Lock aria-hidden="true" className="size-3 text-private" strokeWidth={2.4} />
            <span className="tabular font-medium">{amount(rewardBalance)}</span>
            <span className="text-muted">TEST</span>
          </span>
        </>
      )}
    </div>
  );
}

function Account() {
  const { shieldedAddress, wallets, selectedWalletKey, disconnect } = useWallet();
  const { backup } = useSession();
  const [open, setOpen] = useState(false);
  const name = wallets.find((w) => w.key === selectedWalletKey)?.name ?? "Wallet";

  return (
    <div className="relative" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-line-strong pr-2.5 pl-1 text-[13px] font-medium transition-colors hover:border-line-hover hover:bg-raised"
      >
        <span aria-hidden="true" className="inline-flex size-6 items-center justify-center rounded-[5px] bg-chip text-[10px] font-semibold">
          {name.slice(0, 2).toUpperCase()}
        </span>
        {name}
        {backup.needed && <Dot tone="warn" />}
        <span className="sr-only">{backup.needed ? " (keys not backed up)" : ""}</span>
        <ChevronDown aria-hidden="true" className="size-3.5" />
      </button>
      {open && (
        // Clicking anywhere outside the menu lands on this backdrop and closes it.
        <div aria-hidden="true" className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
      )}
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-2 flex w-72 flex-col gap-1 rounded-lg border border-line bg-surface p-2 shadow-pop">
          <div className="px-2 py-1.5 text-xs text-faint">
            Shielded address
            <div className="mt-0.5 font-mono text-[12px] break-all text-fg-2">{shieldedAddress ? short(shieldedAddress, 18, 8) : "–"}</div>
          </div>
          <a role="menuitem" href={href({ name: "setup" })} onClick={() => setOpen(false)} className="rounded-md px-2 py-1.5 text-sm text-fg no-underline hover:bg-chip">
            Setup and proving
          </a>
          <a role="menuitem" href={href({ name: "backup" })} onClick={() => setOpen(false)} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm text-fg no-underline hover:bg-chip">
            Keys and backup
            {backup.needed && <span className="text-xs text-warn">Not backed up</span>}
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
