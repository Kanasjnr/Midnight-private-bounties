import { useMemo, useState } from "react";
import { combineLatest, defer, map, type Observable } from "rxjs";
import { errorMessage } from "@/lib/errors";
import type { PrivateBountiesPrivateState } from "@/midnight/contract";
import type { ContractProviders } from "@/midnight/providers";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { useLocalValue } from "~/hooks/use-local-value";
import { constantStore, observableStore, promiseStore, settledStore, useStore, type Settled, type Streamed } from "~/lib/store";
import { instrument, type TxPhase } from "~/tx";

type PS = PrivateBountiesPrivateState;
// The circuit ids differ per contract; the slot only passes providers along.
type AnyProviders = ContractProviders<string>;

/** How to reach one kind of contract. Keep it at module level: its identity keys the stores. */
export interface SlotConfig<C, L, V> {
  /** localStorage key prefix for the remembered address; the network id is appended. */
  storageKey: string;
  /** Where its keys and zkir are served (`managed/<contract>`). */
  zk: string;
  join: (providers: AnyProviders, address: string) => Promise<C>;
  stream: (providers: AnyProviders, address: string) => Observable<L>;
  readState: (providers: AnyProviders, address: string) => Promise<PS | null>;
  views: (state: L, address: string, ps: PS | null) => V[];
}

export interface Slot<C, L, V> {
  address: string | null;
  /** Remember an address to join (null forgets it). */
  setAddress: (a: string | null) => void;
  providers: AnyProviders | null;
  contract: C | null;
  joining: boolean;
  joinError: string | null;
  retry: () => void;
  state: L | null;
  stateError: Error | null;
  ps: PS | null;
  views: V[];
}

const NO_PROVIDERS = constantStore<AnyProviders | null>(null);
const NOT_JOINING = constantStore<Settled<never>>({ value: null, error: null, pending: false });
const NO_STREAM = constantStore<Streamed<never>>({ value: null, error: null });

/**
 * One contract of the board, other than the verified-answer one the
 * template's useDeployment handles: its own providers bundle (reporting each
 * transaction step to the tray), joined from the address remembered for this
 * network, then the ledger as the indexer pushes it with this account's
 * private state. Private state is read once per join: its secrets are made
 * when the account joins and never change.
 */
export function useContractSlot<C, L, V>(cfg: SlotConfig<C, L, V>, networkId: string | null, report: (p: TxPhase) => void): Slot<C, L, V> {
  const { providersFor } = useMidnightProviders();
  const [address, setAddress] = useLocalValue(`${cfg.storageKey}${networkId ?? "unknown"}`);
  const providersStore = useMemo(
    () => (providersFor ? promiseStore(() => providersFor<string>(cfg.zk).then((p) => instrument(p, report))) : NO_PROVIDERS),
    [providersFor, report, cfg],
  );
  const providers = useStore(providersStore);
  // A new attempt makes a new store, which joins again.
  const [attempt, setAttempt] = useState(0);
  const joinStore = useMemo(
    () => (providers && address ? settledStore(() => cfg.join(providers, address)) : (NOT_JOINING as typeof NOT_JOINING)),
    [providers, address, attempt, cfg],
  );
  const joined = useStore(joinStore) as Settled<C>;
  const contract = joined.value;
  const streamStore = useMemo(
    () =>
      providers && address && contract
        ? observableStore(
            combineLatest([cfg.stream(providers, address), defer(() => cfg.readState(providers, address).catch(() => null))]).pipe(
              map(([state, ps]) => ({ state, ps })),
            ),
          )
        : (NO_STREAM as typeof NO_STREAM),
    [providers, address, contract, cfg],
  );
  const streamed = useStore(streamStore) as Streamed<{ state: L; ps: PS | null }>;
  const state = streamed.value?.state ?? null;
  const ps = streamed.value?.ps ?? null;
  const views = useMemo(() => (state && address ? cfg.views(state, address, ps) : []), [state, address, ps, cfg]);
  return {
    address,
    setAddress,
    providers,
    contract,
    joining: joined.pending && address !== null,
    joinError: joined.error ? errorMessage(joined.error, "Couldn't join the contract") : null,
    retry: () => setAttempt((n) => n + 1),
    state,
    stateError: streamed.error,
    ps,
    views,
  };
}
