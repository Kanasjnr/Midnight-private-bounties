import { createContext, useContext, useMemo, type ReactNode } from "react";
import { combineLatest, defer, map } from "rxjs";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { useDeployment, type Deployment } from "@/hooks/use-deployment";
import { useWallet } from "@/hooks/use-wallet";
import type { WalletBalances } from "@/hooks/use-wallet-balances";
import type { Ledger, PrivateBountiesPrivateState } from "@/midnight/contract";
import { useMidnightProviders } from "@/providers/midnight-providers";
import {
  bountyViews,
  deployPrivateBounties,
  joinPrivateBounties,
  ledger$,
  mintTestTokens,
  readPrivateState,
  deployTestToken,
  TOKEN_ZK_ASSETS_PATH,
  tokenColor,
  type BountyView,
  type PrivateBountiesContract,
  type TokenCircuits,
  type TokenProviders,
} from "@/midnight/private-bounties-api";
import { useLocalSet, useLocalValue } from "~/hooks/use-local-value";
import { useNow } from "~/hooks/use-now";
import { constantStore, observableStore, pollStore, promiseStore, useStore, type Poll, type Streamed } from "~/lib/store";
import { instrument, useTx } from "~/tx";

const TOKEN_KEY_PREFIX = "private-bounties-app:token-address:";

interface DeployInput {
  tokenAddress: string;
}

export interface Session {
  deployment: Deployment<PrivateBountiesContract, DeployInput>;
  /** The joined board's public ledger, live from the indexer. */
  state: Ledger | null;
  stateError: Error | null;
  /** This wallet account's private state for the board. */
  ps: PrivateBountiesPrivateState | null;
  views: BountyView[];
  /** The reward token's color as hex, which is how wallets key balances. */
  colorHex: string | null;
  token: TokenAddress;
  /** True when this browser knows the board's token address, so it can mint. */
  canMint: boolean;
  tokenProviders: TokenProviders | null;
  balances: WalletBalances | null;
  dust: { balance: bigint; cap: bigint } | null;
  /** The reward token this wallet holds, or null before the first poll. */
  rewardBalance: bigint | null;
  /** Seconds, refreshed every 10 s. Live countdowns read their own faster clock (<Countdown>). */
  now: bigint;
  /** Per-browser marks for this board. */
  hidden: ReturnType<typeof useLocalSet>;
  read: ReturnType<typeof useLocalSet>;
  solvedHere: ReturnType<typeof useLocalSet>;
  /** One transaction at a time, shown in the tray. Resolves to null when it failed. */
  run: <T>(label: string, subject: string, fn: () => Promise<T>, opts?: { href?: (r: T) => string }) => Promise<T | null>;
  deployToken: () => Promise<void>;
  mint: (amount: bigint) => Promise<void>;
}

export interface TokenAddress {
  address: string | null;
  remember: (a: string) => void;
  forget: () => void;
}

interface Board {
  state: Ledger;
  ps: PrivateBountiesPrivateState | null;
}

const NOTHING = constantStore<Streamed<Board>>({ value: null, error: null });
const NO_PROVIDERS = constantStore<TokenProviders | null>(null);
const NO_POLL: Poll<never> = { store: constantStore(null), refresh: () => {} };

/** Bigint-safe JSON, to compare poll replies. */
const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const tx = useTx();
  const deployment = useDeployment<PrivateBountiesContract, DeployInput>({
    // Contract handles keep the providers they were made with, so instrument
    // them here: every later call on the handle reports its steps.
    deploy: (providers, { tokenAddress }) =>
      tx.track("Starting a board", "Bounty contract", () =>
        deployPrivateBounties(instrument(providers, tx.report), tokenColor(tokenAddress).bytes),
      ),
    join: (providers, address) => joinPrivateBounties(instrument(providers, tx.report), address),
  });
  const { providers, contract, address, networkId } = deployment;
  const token = useTokenAddress(networkId);
  const now = useNow();

  // The ledger as the indexer pushes it, with this account's private state.
  // The private state is read once per join: its identity secret and poster
  // seed are made when the account joins and never change afterwards.
  const boardStore = useMemo(
    () =>
      providers && address && contract
        ? observableStore(
            combineLatest([ledger$(providers, address), defer(() => readPrivateState(providers, address).catch(() => null))]).pipe(
              map(([state, ps]) => ({ state, ps })),
            ),
          )
        : NOTHING,
    [providers, address, contract],
  );
  const board = useStore(boardStore);
  const state = board.value?.state ?? null;
  const ps = board.value?.ps ?? null;

  const { providersFor } = useMidnightProviders();
  const tokenStore = useMemo(
    () =>
      providersFor ? promiseStore(() => providersFor<TokenCircuits>(TOKEN_ZK_ASSETS_PATH).then((p) => instrument(p, tx.report))) : NO_PROVIDERS,
    [providersFor, tx.report],
  );
  const tokenProviders = useStore(tokenStore);

  const { connectedApi, status } = useWallet();
  const polls = useMemo(() => {
    if (status !== "connected" || !connectedApi) return { balances: NO_POLL as Poll<WalletBalances>, dust: NO_POLL as Poll<{ balance: bigint; cap: bigint }> };
    return {
      balances: pollStore<WalletBalances>(
        () => Promise.all([connectedApi.getUnshieldedBalances(), connectedApi.getShieldedBalances()]).then(([unshielded, shielded]) => ({ unshielded, shielded })),
        10_000,
        json,
      ),
      dust: pollStore(() => connectedApi.getDustBalance(), 10_000, json),
    };
  }, [connectedApi, status]);
  const balances = useStore(polls.balances.store);
  const dust = useStore(polls.dust.store);

  const views = useMemo(() => (state && address ? bountyViews(state, address, ps) : []), [state, address, ps]);
  const colorHex = state ? toHex(state.rewardColor) : null;
  const canMint = token.address !== null && colorHex !== null && tokenColor(token.address).hex === colorHex;
  const rewardBalance = balances && colorHex ? (balances.shielded[colorHex] ?? 0n) : null;

  const scope = `${networkId ?? "unknown"}:${address ?? "none"}`;
  const hidden = useLocalSet(`private-bounties-app:hidden:${scope}`);
  const read = useLocalSet(`private-bounties-app:read:${scope}`);
  const solvedHere = useLocalSet(`private-bounties-app:solved:${scope}`);

  const run: Session["run"] = async (label, subject, fn, opts) => {
    const box: { value?: Awaited<ReturnType<typeof fn>> } = {};
    const retry = () => void run(label, subject, fn, opts);
    const ok = await deployment.run(label, async () => {
      box.value = await tx.track(label, subject, fn, { href: opts?.href, retry });
    });
    // A call moves tokens, so read the balances again now.
    polls.balances.refresh();
    polls.dust.refresh();
    return ok && "value" in box ? (box.value as Awaited<ReturnType<typeof fn>>) : null;
  };

  const deployToken = async () => {
    if (!tokenProviders) return;
    const a = await run("Deploying the test token", "Reward token", () => deployTestToken(tokenProviders));
    if (a) token.remember(a);
  };

  const mint = async (n: bigint) => {
    if (!tokenProviders || !token.address || !canMint) return;
    const a = token.address;
    await run("Minting test tokens", `${n} TEST`, () => mintTestTokens(tokenProviders, a, n));
  };

  const value: Session = {
    deployment,
    state,
    stateError: board.error,
    ps,
    views,
    colorHex,
    token,
    canMint,
    tokenProviders,
    balances,
    dust,
    rewardBalance,
    now,
    hidden,
    read,
    solvedHere,
    run,
    deployToken,
    mint,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}

/** The test token's address on this network, kept in localStorage. */
function useTokenAddress(networkId: string | null): TokenAddress {
  const [address, write] = useLocalValue(`${TOKEN_KEY_PREFIX}${networkId ?? "unknown"}`);
  return { address, remember: write, forget: () => write(null) };
}
