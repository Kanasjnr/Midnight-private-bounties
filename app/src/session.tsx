// The board this browser has joined, and everything the pages need about it:
// the contract handle, the live public ledger, this account's private state,
// the reward token, balances, and a way to run a transaction with the tray.
//
// The wallet, providers and private-state store are the UI template's
// (../ui/src/providers), and every contract call is the api file's
// (../ui/src/midnight/private-bounties-api.ts), which the circuits test checks
// against the compiled contract. This file only wires them together.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { useContractState } from "@/hooks/use-contract-state";
import { useDeployment, type Deployment } from "@/hooks/use-deployment";
import { useDustBalance } from "@/hooks/use-dust-balance";
import { useWalletBalances, type WalletBalances } from "@/hooks/use-wallet-balances";
import { storage } from "@/lib/storage";
import type { Ledger, PrivateBountiesPrivateState } from "@/midnight/contract";
import { DEFAULT_PROOF_SERVER_URL } from "@/midnight/providers";
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
import { useLocalSet } from "~/hooks/use-local-set";
import { useNow } from "~/hooks/use-now";
import { instrument, useTx } from "~/tx";

/** Where the template's providers context keeps the proving choice. */
const PROVING_KEY = "private-bounties-ui:proving";
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

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  useLocalProvingByDefault();
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
  const { providers, contract, address, busy, networkId } = deployment;
  const token = useTokenAddress(networkId);
  const tokenProviders = useTokenProviders(tx.report);
  const now = useNow();

  const ledgerObservable = useMemo(
    () => (providers && address ? ledger$(providers, address) : null),
    [providers, address],
  );
  const { state, error: stateError } = useContractState(ledgerObservable);

  // Re-read on every ledger update and after each call: midnight-js stores a
  // call's resulting private state once its transaction is final.
  const [ps, setPs] = useState<PrivateBountiesPrivateState | null>(null);
  useEffect(() => {
    if (!providers || !address || !contract) {
      setPs(null);
      return;
    }
    let cancelled = false;
    readPrivateState(providers, address)
      .then((p) => !cancelled && setPs(p))
      .catch(() => !cancelled && setPs(null));
    return () => {
      cancelled = true;
    };
  }, [providers, address, contract, state, busy]);

  const views = useMemo(() => (state && address ? bountyViews(state, address, ps) : []), [state, address, ps]);
  const colorHex = state ? toHex(state.rewardColor) : null;
  const canMint = token.address !== null && colorHex !== null && tokenColor(token.address).hex === colorHex;

  const balances = useWalletBalances(busy);
  const dust = useDustBalance();
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
    stateError,
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

/**
 * Spike Q10: every circuit has secret inputs, so prove on a local proof
 * server unless the user has chosen otherwise. The template defaults to wallet
 * proving, so on a first visit (no remembered choice) switch to local once.
 */
function useLocalProvingByDefault() {
  const { setProving } = useMidnightProviders();
  useEffect(() => {
    if (storage.get(PROVING_KEY) === null) setProving({ mode: "local", proofServerUrl: DEFAULT_PROOF_SERVER_URL });
  }, [setProving]);
}

/** The test token's providers, rebuilt with the bounty contract's, reporting their steps. */
function useTokenProviders(report: Parameters<typeof instrument>[1]): TokenProviders | null {
  const { providersFor } = useMidnightProviders();
  const [tokenProviders, setTokenProviders] = useState<TokenProviders | null>(null);
  useEffect(() => {
    setTokenProviders(null);
    if (!providersFor) return;
    let cancelled = false;
    providersFor<TokenCircuits>(TOKEN_ZK_ASSETS_PATH)
      .then((p) => !cancelled && setTokenProviders(instrument(p, report)))
      .catch(() => !cancelled && setTokenProviders(null));
    return () => {
      cancelled = true;
    };
  }, [providersFor, report]);
  return tokenProviders;
}

/** The test token's address on this network, kept in localStorage. */
function useTokenAddress(networkId: string | null): TokenAddress {
  const key = `${TOKEN_KEY_PREFIX}${networkId ?? "unknown"}`;
  const [address, setAddress] = useState<string | null>(() => storage.get(key));
  useEffect(() => setAddress(storage.get(key)), [key]);
  return {
    address,
    remember: (a: string) => {
      storage.set(key, a);
      setAddress(a);
    },
    forget: () => {
      storage.remove(key);
      setAddress(null);
    },
  };
}
