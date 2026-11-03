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
import { useContractSlot, type Slot, type SlotConfig } from "~/hooks/use-contract-slot";
import {
  deployWork,
  joinWork,
  readWorkState,
  WORK_ZK_ASSETS_PATH,
  work$,
  workViews,
  type WorkContract,
  type WorkLedger,
  type WorkProviders,
  type WorkView,
} from "~/midnight/work-api";
import {
  deployTemplate,
  joinTemplate,
  readTemplateState,
  template$,
  templateViews,
  TEMPLATES,
  type Template,
  type TemplateContract,
  type TemplateLedger,
  type TemplateProviders,
  type TemplateView,
} from "~/midnight/verified-api";
import { answerItem, templateItem, workItem, type BoardItem } from "~/lib/items";
import { readOnlyIndexer } from "~/midnight/read-only";
import type { BoardAddresses } from "~/midnight/backup";
import { instrument, useTx } from "~/tx";

const TOKEN_KEY_PREFIX = "private-bounties-app:token-address:";

interface DeployInput {
  tokenAddress: string;
}

export interface Session {
  deployment: Deployment<PrivateBountiesContract, DeployInput>;
  /** The network shown: the wallet's, or the one picked in setup before connecting. */
  network: string;
  /** The verified-answer contract of the board shown, joined or only browsed. */
  boardAddress: string | null;
  /** True when the board is only being read: no wallet, or not joined yet. */
  browsing: boolean;
  /** Show a board from its code: joins it when the wallet is ready, else just reads it. */
  openBoard: (code: { verified: string; work: string | null; factor: string | null; signed: string | null }) => void;
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
  /** The board's factor and signed-record contracts, if it has them. */
  templates: Record<Template, TemplateSession>;
  /** Every bounty of both kinds, as board rows. */
  items: BoardItem[];
  /** The joined board's contracts, or null before joining. */
  board: BoardAddresses | null;
  backup: BackupStatus;
}

export interface BackupStatus {
  /** True when a joined contract's keys aren't in a backup made in this browser. */
  needed: boolean;
  /** When the last backup was made here (ISO), if ever. */
  at: string | null;
  /** Record that these contracts' keys are now backed up. */
  mark: (addresses: string[]) => void;
}

export interface WorkSession extends Omit<Slot<WorkContract, WorkLedger, WorkView>, "providers"> {
  providers: WorkProviders | null;
  /** Deploy one that pays in this board's token. */
  deploy: () => Promise<void>;
}

export interface TemplateSession extends Omit<Slot<TemplateContract, TemplateLedger, TemplateView>, "providers"> {
  providers: TemplateProviders | null;
  deploy: () => Promise<void>;
}

// Module-level, so their identity is stable for the slot's stores.
const WORK_SLOT: SlotConfig<WorkContract, WorkLedger, WorkView> = {
  storageKey: "private-bounties-app:work-address:",
  zk: WORK_ZK_ASSETS_PATH,
  join: (p, a) => joinWork(p as WorkProviders, a),
  stream: (p, a) => work$(p as WorkProviders, a),
  readState: (p, a) => readWorkState(p as WorkProviders, a),
  views: workViews,
};

const templateSlot = (t: Template): SlotConfig<TemplateContract, TemplateLedger, TemplateView> => ({
  storageKey: `private-bounties-app:${t}-address:`,
  zk: TEMPLATES[t].zk,
  join: (p, a) => joinTemplate(t, p as TemplateProviders, a),
  stream: (p, a) => template$(t, p as TemplateProviders, a),
  readState: (p, a) => readTemplateState(p as TemplateProviders, a),
  views: (state, a, ps) => templateViews(t, state, a, ps),
});
const FACTOR_SLOT = templateSlot("factor");
const SIGNED_SLOT = templateSlot("signed");

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
  const raw = useDeployment<PrivateBountiesContract, DeployInput>({
    // Contract handles keep the providers they were made with, so instrument
    // them here: every later call on the handle reports its steps.
    deploy: (providers, { tokenAddress }) =>
      tx.track("Starting a board", "Bounty contract", () =>
        deployPrivateBounties(instrument(providers, tx.report), tokenColor(tokenAddress).bytes),
      ),
    join: (providers, address) => joinPrivateBounties(instrument(providers, tx.report), address),
  });
  const { requestedNetworkId } = useWallet();
  const network = raw.networkId ?? requestedNetworkId;
  // useDeployment keeps its address in storage under this key, but reads it only
  // once it has providers. Reading it here too lets a board be browsed with no wallet.
  const [savedBoard, setSavedBoard] = useLocalValue(`private-bounties-ui:contract-address:${network}`);
  const deployment: Deployment<PrivateBountiesContract, DeployInput> = {
    ...raw,
    join: async (a) => {
      await raw.join(a);
      setSavedBoard(a.trim());
    },
    forget: () => {
      raw.forget();
      setSavedBoard(null);
    },
  };
  const { providers, contract, networkId } = deployment;
  const boardAddress = raw.address ?? savedBoard;
  const address = boardAddress;
  const browse = providers ? null : readOnlyIndexer(network);
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
        : browse && address
          ? observableStore(ledger$({ publicDataProvider: browse } as Parameters<typeof ledger$>[0], address).pipe(map((state) => ({ state, ps: null }))))
          : NOTHING,
    [providers, address, contract, browse],
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

  const scope = `${network}:${address ?? "none"}`;
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

  // The board's other contracts, each in its own slot (~/hooks/use-contract-slot).
  const workSlot = useContractSlot(WORK_SLOT, network, tx.report, browse);
  const factorSlot = useContractSlot(FACTOR_SLOT, network, tx.report, browse);
  const signedSlot = useContractSlot(SIGNED_SLOT, network, tx.report, browse);
  const work: WorkSession = {
    ...workSlot,
    providers: workSlot.providers as WorkProviders | null,
    deploy: async () => {
      const p = workSlot.providers as WorkProviders | null;
      if (!p || !state) return;
      const out = await run("Starting reviewed work", "Reviewed-work contract", () => deployWork(p, state.rewardColor));
      if (out) workSlot.setAddress(out.address);
    },
  };
  const templateSession = (t: Template, slot: Slot<TemplateContract, TemplateLedger, TemplateView>): TemplateSession => ({
    ...slot,
    providers: slot.providers as TemplateProviders | null,
    deploy: async () => {
      const p = slot.providers as TemplateProviders | null;
      if (!p || !state) return;
      const out = await run(`Adding ${TEMPLATES[t].name.toLowerCase()} bounties`, `${TEMPLATES[t].name} contract`, () => deployTemplate(t, p, state.rewardColor));
      if (out) slot.setAddress(out.address);
    },
  });
  const templates = { factor: templateSession("factor", factorSlot), signed: templateSession("signed", signedSlot) };

  const items = useMemo(
    () => [
      ...(address ? views.map((b) => answerItem(b, address, now, { read: read.set, solvedHere: solvedHere.set })) : []),
      ...(workSlot.address && workSlot.state ? workSlot.views.map((w) => workItem(w, workSlot.state!, workSlot.address!, now)) : []),
      ...[factorSlot, signedSlot].flatMap((slot) =>
        slot.address ? slot.views.map((v) => templateItem(v, slot.address!, now, { read: read.set, solvedHere: solvedHere.set })) : [],
      ),
    ],
    [views, address, now, read.set, solvedHere.set, workSlot.views, workSlot.state, workSlot.address, factorSlot.views, factorSlot.address, signedSlot.views, signedSlot.address],
  );

  const joined: BoardAddresses | null =
    address && contract
      ? {
          verified: address,
          work: workSlot.contract ? workSlot.address : null,
          factor: factorSlot.contract ? factorSlot.address : null,
          signed: signedSlot.contract ? signedSlot.address : null,
        }
      : null;
  const backedUp = useLocalSet(`private-bounties-app:backed-up:${networkId ?? "unknown"}`);
  const [backedUpAt, setBackedUpAt] = useLocalValue(`private-bounties-app:backed-up-at:${networkId ?? "unknown"}`);
  const backup: BackupStatus = {
    needed: joined !== null && [joined.verified, joined.work, joined.factor, joined.signed].some((a) => a !== null && !backedUp.set.has(a)),
    at: backedUpAt,
    mark: (addresses) => {
      backedUp.addAll(addresses);
      setBackedUpAt(new Date().toISOString());
    },
  };

  const openBoard: Session["openBoard"] = (code) => {
    workSlot.setAddress(code.work);
    factorSlot.setAddress(code.factor);
    signedSlot.setAddress(code.signed);
    if (providers) void deployment.join(code.verified);
    else setSavedBoard(code.verified);
  };

  const value: Session = {
    deployment,
    network,
    boardAddress,
    browsing: contract === null,
    openBoard,
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
    templates,
    items,
    board: joined,
    backup,
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
