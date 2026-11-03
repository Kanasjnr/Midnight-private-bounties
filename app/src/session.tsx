import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
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
import { errorMessage } from "@/lib/errors";
import { constantStore, observableStore, pollStore, promiseStore, settledStore, useStore, type Poll, type Settled, type Streamed } from "~/lib/store";
import {
  deployWork,
  joinWork,
  readWorkState,
  WORK_ZK_ASSETS_PATH,
  work$,
  workViews,
  type WorkCircuits,
  type WorkContract,
  type WorkLedger,
  type WorkProviders,
  type WorkView,
} from "~/midnight/work-api";
import { answerItem, workItem, type BoardItem } from "~/lib/items";
import { instrument, useTx } from "~/tx";

const TOKEN_KEY_PREFIX = "private-bounties-app:token-address:";
const WORK_KEY_PREFIX = "private-bounties-app:work-address:";

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
  /** The board's reviewed-work contract, if it has one. */
  work: WorkSession;
  /** Every bounty of both kinds, as board rows. */
  items: BoardItem[];
}

export interface WorkSession {
  address: string | null;
  /** Remember an address to join (null forgets it). */
  setAddress: (a: string | null) => void;
  providers: WorkProviders | null;
  contract: WorkContract | null;
  joining: boolean;
  joinError: string | null;
  retry: () => void;
  state: WorkLedger | null;
  stateError: Error | null;
  ps: PrivateBountiesPrivateState | null;
  views: WorkView[];
  /** Deploy one that pays in this board's token. */
  deploy: () => Promise<void>;
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
const NO_WORK_BOARD = constantStore<Streamed<{ state: WorkLedger; ps: PrivateBountiesPrivateState | null }>>({ value: null, error: null });
const NO_WORK_PROVIDERS = constantStore<WorkProviders | null>(null);
const NO_JOIN = constantStore<Settled<WorkContract>>({ value: null, error: null, pending: false });
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

  // The reviewed-work contract: its own providers bundle, joined from the
  // remembered address, then streamed like the verified-answer one.
  const [workAddress, setWorkAddress] = useLocalValue(`${WORK_KEY_PREFIX}${networkId ?? "unknown"}`);
  const workProvidersStore = useMemo(
    () => (providersFor ? promiseStore(() => providersFor<WorkCircuits>(WORK_ZK_ASSETS_PATH).then((p) => instrument(p, tx.report))) : NO_WORK_PROVIDERS),
    [providersFor, tx.report],
  );
  const workProviders = useStore(workProvidersStore);
  const [attempt, setAttempt] = useState(0);
  const joinStore = useMemo(
    () => (workProviders && workAddress ? settledStore(() => joinWork(workProviders, workAddress)) : NO_JOIN),
    // `attempt` makes a new store, which joins again.
    [workProviders, workAddress, attempt],
  );
  const joined = useStore(joinStore);
  const workContract = joined.value;
  const workBoardStore = useMemo(
    () =>
      workProviders && workAddress && workContract
        ? observableStore(
            combineLatest([work$(workProviders, workAddress), defer(() => readWorkState(workProviders, workAddress).catch(() => null))]).pipe(
              map(([state, ps]) => ({ state, ps })),
            ),
          )
        : NO_WORK_BOARD,
    [workProviders, workAddress, workContract],
  );
  const workBoard = useStore(workBoardStore);
  const workState = workBoard.value?.state ?? null;
  const workPs = workBoard.value?.ps ?? null;
  const workViewList = useMemo(
    () => (workState && workAddress ? workViews(workState, workAddress, workPs) : []),
    [workState, workAddress, workPs],
  );
  const work: WorkSession = {
    address: workAddress,
    setAddress: setWorkAddress,
    providers: workProviders,
    contract: workContract,
    joining: joined.pending && workAddress !== null,
    joinError: joined.error ? errorMessage(joined.error, "Couldn't join the reviewed-work contract") : null,
    retry: () => setAttempt((n) => n + 1),
    state: workState,
    stateError: workBoard.error,
    ps: workPs,
    views: workViewList,
    deploy: async () => {
      if (!workProviders || !state) return;
      const out = await run("Starting reviewed work", "Reviewed-work contract", () => deployWork(workProviders, state.rewardColor));
      if (out) setWorkAddress(out.address);
    },
  };

  const items = useMemo(
    () => [
      ...(address ? views.map((b) => answerItem(b, address, now, { read: read.set, solvedHere: solvedHere.set })) : []),
      ...(workAddress && workState ? workViewList.map((w) => workItem(w, workState, workAddress, now)) : []),
    ],
    [views, workViewList, workState, address, workAddress, now, read.set, solvedHere.set],
  );

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
    work,
    items,
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
