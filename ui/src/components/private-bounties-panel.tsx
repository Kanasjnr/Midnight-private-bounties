// Private Bounties, built on the seed `yarn new:ui` generated for the
// bounty_preimage contract. It runs the flow the Node test runs
// (src/test/bounty_preimage.test.ts) through a browser wallet, with the poster
// in one wallet account and the solver in another:
//
//   poster  deploy the test token → deploy a bounty contract → mint tokens →
//           post a bounty (the wallet funds the reward) → decrypt the answer,
//           or refund after the deadline
//   solver  join by address → submit the answer with a zero-value coin →
//           receive the reward
//
// This is the page for spike Q6: can a real wallet (Lace, 1AM) balance and
// submit these transactions? Every call is written to a results log that can
// be copied out, with its tx id, block and time, or the exact error.
//
// The test token is the example's second contract. Its providers come from
// useMidnightProviders().providersFor, and its address is kept here (the
// template's useDeployment remembers only the bounty contract's). What the
// board decides (whose bounty, what each account may do) comes from the pure
// helpers in @/midnight/private-bounties-api, which the circuits test checks
// against the real contract.
//
// Seed file: generated once by `yarn new:ui`, then yours to edit. The drift
// check ignores it.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Copy, Loader2 } from "lucide-react";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DeploymentCard } from "@/components/deployment-card";
import { WalletBalancesCard } from "@/components/wallet-balances-card";
import { useContractState } from "@/hooks/use-contract-state";
import { useDeployment, type Deployment } from "@/hooks/use-deployment";
import { useWallet } from "@/hooks/use-wallet";
import { errorMessage } from "@/lib/errors";
import { formatLedgerValue, type LedgerField } from "@/lib/ledger-format";
import { storage } from "@/lib/storage";
import type { Ledger, PrivateBountiesPrivateState } from "@/midnight/contract";
import { DEFAULT_PROOF_SERVER_URL } from "@/midnight/providers";
import { useMidnightProviders } from "@/providers/midnight-providers";
import {
  actionError,
  bountyViews,
  deployPrivateBounties,
  deployTestToken,
  joinPrivateBounties,
  ledger$,
  listingError,
  mintTestTokens,
  parseAmount,
  postNewBounty,
  readAnswer,
  readPrivateState,
  refund,
  Status,
  submitAnswer,
  TOKEN_ZK_ASSETS_PATH,
  tokenColor,
  type BountyView,
  type PrivateBountiesContract,
  type TokenCircuits,
  type TokenProviders,
} from "@/midnight/private-bounties-api";

/** Exported ledger fields and how they're stored, from contract-info.json. */
const LEDGER_FIELDS: LedgerField[] = [
  { name: "rewardColor", storage: "Cell" },
  { name: "bounties", storage: "Map" },
  { name: "escrows", storage: "Map" },
  { name: "deliveries", storage: "Map" },
];

const STATUS_NAMES = ["OPEN", "SOLVED", "REFUNDED"] as const;
const TOKEN_KEY_PREFIX = "private-bounties-ui:token-address:";
const LOG_KEY = "private-bounties-ui:q6-log";
/** Where the template's providers context remembers the proving choice. */
export const PROVING_KEY = "private-bounties-ui:proving";

/** What the deploy form collects: the reward token. */
interface DeployInput {
  tokenAddress: string;
}

type BountyDeployment = Deployment<PrivateBountiesContract, DeployInput>;

/** What a step put on chain, for the log. */
interface LogDetail {
  txId?: string;
  blockHeight?: number;
  note?: string;
}

interface LogEntry extends LogDetail {
  at: string;
  step: string;
  ok: boolean;
  seconds: number;
  error?: string;
}

/** Runs a step with the shared busy/error state, and logs how it went. */
type Logged = (step: string, fn: () => Promise<LogDetail | void>) => Promise<boolean>;

/** The test token's providers bundle, rebuilt with the bounty contract's. */
function useTokenProviders(): TokenProviders | null {
  const { providersFor } = useMidnightProviders();
  const [tokenProviders, setTokenProviders] = useState<TokenProviders | null>(null);
  useEffect(() => {
    setTokenProviders(null);
    if (!providersFor) return;
    let cancelled = false;
    providersFor<TokenCircuits>(TOKEN_ZK_ASSETS_PATH)
      .then((p) => !cancelled && setTokenProviders(p))
      .catch(() => !cancelled && setTokenProviders(null));
    return () => {
      cancelled = true;
    };
  }, [providersFor]);
  return tokenProviders;
}

/** The test token's address on this network, kept in localStorage. */
function useTokenAddress(networkId: string | null) {
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

/** The results log, kept in localStorage so a reload doesn't lose it. */
function useResultsLog() {
  const [entries, setEntries] = useState<LogEntry[]>(() => {
    try {
      return JSON.parse(storage.get(LOG_KEY) ?? "[]") as LogEntry[];
    } catch {
      return [];
    }
  });
  const add = (entry: LogEntry) =>
    setEntries((prev) => {
      const next = [...prev, entry];
      storage.set(LOG_KEY, JSON.stringify(next));
      return next;
    });
  return {
    entries,
    /** Runs `fn` and logs its outcome; rethrows its error. */
    record: async <T,>(step: string, fn: () => Promise<{ result: T; detail?: LogDetail }>): Promise<T> => {
      const t0 = performance.now();
      const at = new Date().toISOString();
      try {
        const { result, detail } = await fn();
        add({ at, step, ok: true, seconds: elapsed(t0), ...detail });
        return result;
      } catch (err: unknown) {
        add({ at, step, ok: false, seconds: elapsed(t0), error: errorText(err) });
        throw err;
      }
    },
    clear: () => {
      storage.remove(LOG_KEY);
      setEntries([]);
    },
  };
}

/**
 * Spike Q10: every circuit has secret inputs, so prove on a local proof server
 * unless the user has chosen otherwise. The template defaults to wallet
 * proving, so on a first visit (no remembered choice) switch to local once.
 * Choosing wallet proving afterwards is remembered and respected.
 */
function useLocalProvingByDefault() {
  const { setProving } = useMidnightProviders();
  useEffect(() => {
    if (storage.get(PROVING_KEY) === null) setProving({ mode: "local", proofServerUrl: DEFAULT_PROOF_SERVER_URL });
  }, [setProving]);
}

/** Seconds since the Unix epoch, refreshed every few seconds. */
function useNow(): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = window.setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 5_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function PrivateBountiesPanel() {
  useLocalProvingByDefault();
  const tokenProviders = useTokenProviders();
  const log = useResultsLog();
  const deployment = useDeployment<PrivateBountiesContract, DeployInput>({
    deploy: (providers, { tokenAddress }) =>
      log.record("deploy bounty contract", async () => {
        const deployed = await deployPrivateBounties(providers, tokenColor(tokenAddress).bytes);
        const tx = deployed.contract.deployTxData.public;
        return { result: deployed, detail: { txId: tx.txId, blockHeight: tx.blockHeight, note: `contract ${deployed.address}` } };
      }),
    // Reuses this browser's stored private state for the contract if it has
    // one (a reload, or the deployer coming back); otherwise a new one. Also
    // runs on every reload, so the log shows whether re-joining worked.
    join: (providers, a) =>
      log.record("join contract", async () => ({ result: await joinPrivateBounties(providers, a), detail: { note: `contract ${a}` } })),
  });
  const { providers, contract, address, busy, error, run, networkId } = deployment;
  const token = useTokenAddress(networkId);
  const { proving } = useMidnightProviders();
  const { wallets, selectedWalletKey } = useWallet();
  const now = useNow();

  const ledgerObservable = useMemo(
    () => (providers && address ? ledger$(providers, address) : null),
    [providers, address],
  );
  const { state, error: stateError } = useContractState(ledgerObservable);

  // This browser's private state. Re-read on every ledger update and after
  // each call: midnight-js stores a call's resulting state once the tx is final.
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

  const colorHex = state ? toHex(state.rewardColor) : null;
  // The contract's token, if it's the one this browser remembers (only then can it mint).
  const tokenOk = token.address !== null && colorHex !== null && tokenColor(token.address).hex === colorHex;

  const logged: Logged = (step, fn) =>
    run(step, () => log.record(step, async () => ({ result: undefined, detail: (await fn()) ?? {} })));

  const environment = {
    network: networkId,
    wallet: wallets.find((w) => w.key === selectedWalletKey)?.name ?? selectedWalletKey,
    proving: proving.mode === "local" ? `local proof server (${proving.proofServerUrl})` : "wallet",
    bountyContract: address,
    tokenContract: token.address,
  };

  return (
    <div className="flex flex-col gap-6">
      {proving.mode === "wallet" && <WalletProvingNote />}

      <DeploymentCard
        deployment={deployment}
        deployForm={
          <PosterSetup
            tokenProviders={tokenProviders}
            token={token}
            busy={busy}
            logged={logged}
            onDeploy={(input) => void deployment.deploy(input)}
          />
        }
      />

      {providers && address && (
        <>
          <WalletBalancesCard
            title="Your balances"
            description="The reward token is shielded: only you can see your balance. A solver's payout shows up here once the wallet has synced."
            labels={colorHex ? { [colorHex]: "Reward token" } : {}}
            refreshKey={busy}
          />

          {state === null || colorHex === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading the bounty board...
            </p>
          ) : (
            <>
              <TokenCard
                tokenProviders={tokenProviders}
                tokenAddress={tokenOk ? token.address : null}
                busy={busy}
                logged={logged}
              />
              <PostCard deployment={deployment} colorHex={colorHex} now={now} logged={logged} />
              <BoardCard
                state={state}
                ps={ps}
                deployment={deployment}
                colorHex={colorHex}
                now={now}
                logged={logged}
              />
            </>
          )}
          {stateError && <p className="text-xs text-destructive">{stateError.message}</p>}

          {state && (
            <details className="rounded-md border px-4 py-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">Raw public ledger</summary>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                {LEDGER_FIELDS.map((field) => (
                  <div key={field.name} className="contents">
                    <dt className="font-mono text-muted-foreground">{field.name}</dt>
                    <dd className="break-all font-mono">
                      {formatLedgerValue(field, state[field.name as keyof Ledger])}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <ResultsCard entries={log.entries} environment={environment} onClear={log.clear} />
    </div>
  );
}

/** Spike Q10: local proving is the default policy; wallet proving shows its cost. */
function WalletProvingNote() {
  return (
    <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm">
      <strong>The wallet is proving.</strong> The wallet, and any hosted prover it uses, sees each
      proof's inputs: your identity secret when you post or refund, and your answer when you solve.
      To keep them on this machine, choose <em>Local proof server</em> in the proving settings and
      run <code>yarn proof:up</code>.
    </p>
  );
}

/** Deploy form: the test token first, then a bounty contract bound to its color. */
function PosterSetup(props: {
  tokenProviders: TokenProviders | null;
  token: ReturnType<typeof useTokenAddress>;
  busy: string | null;
  logged: Logged;
  onDeploy: (input: DeployInput) => void;
}) {
  const { tokenProviders, token, busy, logged, onDeploy } = props;
  const [pasted, setPasted] = useState("");

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground">
        Solvers: paste the poster's contract address below to join. The poster deploys:
      </p>
      <Section title="a. The reward token">
        {token.address ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-muted px-2 py-1">{token.address}</code>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={token.forget}>
              Use another
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={busy !== null || !tokenProviders}
              onClick={() =>
                void logged("deploy test token", async () => {
                  if (!tokenProviders) return;
                  const a = await deployTestToken(tokenProviders);
                  token.remember(a);
                  return { note: `token ${a}` };
                })
              }
            >
              {busy === "deploy test token" && <Loader2 className="animate-spin" />}
              Deploy test token
            </Button>
            <span className="text-muted-foreground">or use one deployed before:</span>
            <Input
              className="min-w-0 flex-1 font-mono"
              placeholder="token contract address"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              aria-label="Token contract address"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!/^[0-9a-fA-F]{64}$/.test(pasted.trim())}
              onClick={() => token.remember(pasted.trim().toLowerCase())}
            >
              Use it
            </Button>
          </div>
        )}
      </Section>
      <Section title="b. A bounty contract that pays in it">
        <div>
          <Button disabled={busy !== null || !token.address} onClick={() => token.address && onDeploy({ tokenAddress: token.address })}>
            {busy === "deploying" && <Loader2 className="animate-spin" />}
            Deploy bounty contract
          </Button>
        </div>
      </Section>
    </div>
  );
}

function TokenCard(props: {
  tokenProviders: TokenProviders | null;
  tokenAddress: string | null;
  busy: string | null;
  logged: Logged;
}) {
  const { tokenProviders, tokenAddress, busy, logged } = props;
  const [amount, setAmount] = useState("1000");
  const parsed = parseAmount(amount);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reward tokens</CardTitle>
        <CardDescription>
          A test token with no value: anyone can mint it. Posters need some to fund rewards.
          Solvers need none.
        </CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {tokenAddress === null ? (
          <p className="text-muted-foreground">
            This browser doesn't know this contract's token address, so it can't mint here. Use the
            browser that deployed it, or paste the address on the setup step.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-32"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Amount to mint"
            />
            <Button
              disabled={busy !== null || !tokenProviders || parsed === null}
              onClick={() =>
                void logged("mint test tokens", async () => {
                  if (!tokenProviders || parsed === null) return;
                  const tx = await mintTestTokens(tokenProviders, tokenAddress, parsed);
                  return { txId: tx.public.txId, blockHeight: tx.public.blockHeight, note: `minted ${parsed}` };
                })
              }
            >
              {busy === "mint test tokens" && <Loader2 className="animate-spin" />}
              Mint to my wallet
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PostCard(props: { deployment: BountyDeployment; colorHex: string; now: bigint; logged: Logged }) {
  const { deployment, colorHex, now, logged } = props;
  const { providers, contract, address, busy } = deployment;
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [answer, setAnswer] = useState("");
  const [reward, setReward] = useState("100");
  const [minutes, setMinutes] = useState("60");
  const parsedReward = parseAmount(reward);
  const parsedMinutes = parseAmount(minutes);
  const textError = title === "" && details === "" ? null : listingError(title, details);
  const ready =
    listingError(title, details) === null && answer.trim().length > 0 && parsedReward !== null && parsedMinutes !== null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Post a bounty</CardTitle>
        <CardDescription>
          The title and question are public. Only the answer's hash goes on chain, so use something
          long and hard to guess. The reward
          is escrowed in the contract until someone proves they know the answer, or the deadline
          passes and you take it back.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <Input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
        <textarea
          className="min-h-20 rounded-md border bg-transparent px-3 py-2"
          placeholder="The question"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          aria-label="Question"
        />
        {textError && <p className="text-muted-foreground">{textError}</p>}
        <Input placeholder="The answer (up to 124 bytes)" value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label="Answer" />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            Reward
            <Input className="w-28" value={reward} onChange={(e) => setReward(e.target.value)} aria-label="Reward" />
          </label>
          <label className="flex items-center gap-2">
            Deadline in minutes
            <Input className="w-20" value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Deadline in minutes" />
          </label>
          <Button
            disabled={busy !== null || !contract || !ready}
            onClick={() =>
              void logged("post bounty", async () => {
                if (!contract || !providers || !address || parsedReward === null || parsedMinutes === null) return;
                const { id, tx } = await postNewBounty(contract, providers, address, {
                  title,
                  details,
                  answer,
                  reward: parsedReward,
                  deadline: now + parsedMinutes * 60n,
                  colorHex,
                });
                setTitle("");
                setDetails("");
                setAnswer("");
                return {
                  txId: tx.public.txId,
                  blockHeight: tx.public.blockHeight,
                  note: `bounty ${toHex(id).slice(0, 16)}…, reward ${parsedReward}, ${parsedMinutes} min`,
                };
              })
            }
          >
            {busy === "post bounty" && <Loader2 className="animate-spin" />}
            Post
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function BoardCard(props: {
  state: Ledger;
  ps: PrivateBountiesPrivateState | null;
  deployment: BountyDeployment;
  colorHex: string;
  now: bigint;
  logged: Logged;
}) {
  const { state, ps, deployment, colorHex, now, logged } = props;
  const { providers, contract, address, busy } = deployment;
  const rows = address ? bountyViews(state, address, ps) : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [plaintexts, setPlaintexts] = useState<Record<string, string>>({});
  const disabled = busy !== null || !contract || !providers || !address;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bounties</CardTitle>
        <CardDescription>
          Every bounty on this contract, streamed from the indexer. Solving takes one transaction:
          the proof checks your answer, encrypts it to the poster, and pays you the reward.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {rows.length === 0 && <p className="text-muted-foreground">No bounties yet.</p>}
        {rows.map((b) => {
          const short = `${b.idHex.slice(0, 16)}…`;
          const text = answers[b.idHex] ?? "";
          const submitError = actionError("submit", state, b, now, text);
          const refundError = actionError("refund", state, b, now);
          const decryptError = actionError("decrypt", state, b, now);
          return (
            <div key={b.idHex} className="flex flex-col gap-2 rounded-md border px-3 py-2">
              <div className="font-medium">{b.title || <code>{short}</code>}</div>
              {b.details && <p className="whitespace-pre-wrap text-muted-foreground">{b.details}</p>}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-medium">{STATUS_NAMES[b.status]}</span>
                {b.reward !== null && <span>reward {b.reward.toString()}</span>}
                <span className="text-muted-foreground">{deadlineText(b, now)}</span>
                {b.mine && <span className="text-muted-foreground">posted by you</span>}
              </div>

              {b.status === Status.OPEN && !b.mine && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    placeholder="Your answer"
                    value={text}
                    onChange={(e) => setAnswers({ ...answers, [b.idHex]: e.target.value })}
                    aria-label={`Answer for ${short}`}
                  />
                  <Button
                    disabled={disabled || submitError !== null}
                    title={submitError ?? undefined}
                    onClick={() =>
                      void logged("submit answer", async () => {
                        if (!contract || !providers || !address) return;
                        const tx = await submitAnswer(contract, providers, address, b.id, text, colorHex);
                        setAnswers({ ...answers, [b.idHex]: "" });
                        return { txId: tx.public.txId, blockHeight: tx.public.blockHeight, note: `bounty ${short}, zero-value coin` };
                      })
                    }
                  >
                    {busy === "submit answer" && <Loader2 className="animate-spin" />}
                    Solve
                  </Button>
                  {text.trim() && submitError && <span className="text-xs text-muted-foreground">{submitError}</span>}
                </div>
              )}

              {b.mine && b.status === Status.OPEN && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || refundError !== null}
                    title={refundError ?? undefined}
                    onClick={() =>
                      void logged("refund", async () => {
                        if (!contract) return;
                        const tx = await refund(contract, b.id);
                        return { txId: tx.public.txId, blockHeight: tx.public.blockHeight, note: `bounty ${short}` };
                      })
                    }
                  >
                    {busy === "refund" && <Loader2 className="animate-spin" />}
                    Refund
                  </Button>
                  {refundError && <span className="text-xs text-muted-foreground">{refundError}</span>}
                </div>
              )}

              {b.mine && b.status === Status.SOLVED && (
                <div className="flex flex-wrap items-center gap-2">
                  {plaintexts[b.idHex] !== undefined ? (
                    <span>
                      Answer: <strong className="break-all">{plaintexts[b.idHex]}</strong>
                    </span>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null || decryptError !== null || !ps?.posterSeed}
                      title={decryptError ?? undefined}
                      onClick={() =>
                        void logged("decrypt answer", async () => {
                          if (!address || !ps?.posterSeed) return;
                          const plain = await readAnswer(state, address, b.id, ps.posterSeed);
                          setPlaintexts({ ...plaintexts, [b.idHex]: plain });
                          return { note: `bounty ${short}, ${new TextEncoder().encode(plain).length} bytes` };
                        })
                      }
                    >
                      Decrypt the answer
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/** The spike's record: every step this browser ran, copyable as JSON. */
function ResultsCard(props: {
  entries: LogEntry[];
  environment: Record<string, string | null | undefined>;
  onClear: () => void;
}) {
  const { entries, environment, onClear } = props;
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify({ environment, entries }, null, 2);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Results log</CardTitle>
        <CardDescription>
          Every call from this browser: how long it took (including your approval in the wallet),
          its tx id and block, or the exact error. Copy it into the spike results.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {entries.length === 0 ? (
          <p className="text-muted-foreground">Nothing yet.</p>
        ) : (
          <ol className="flex flex-col gap-1 font-mono text-xs">
            {entries.map((e, i) => (
              <li key={i} className={e.ok ? "" : "text-destructive"}>
                {e.ok ? "✓" : "✗"} {e.step} · {e.seconds}s
                {e.blockHeight !== undefined && ` · block ${e.blockHeight}`}
                {e.txId && ` · tx ${e.txId.slice(0, 16)}…`}
                {e.note && ` · ${e.note}`}
                {e.error && ` · ${e.error}`}
              </li>
            ))}
          </ol>
        )}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void navigator.clipboard.writeText(json).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2_000);
              })
            }
          >
            <Copy /> {copied ? "Copied" : "Copy as JSON"}
          </Button>
          <Button variant="ghost" size="sm" disabled={entries.length === 0} onClick={onClear}>
            Clear
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium">{title}</span>
      {children}
    </div>
  );
}

function deadlineText(b: BountyView, now: bigint): string {
  const left = b.deadline - now;
  if (left <= 0n) return "deadline passed";
  return left < 120n ? `${left}s left` : `${left / 60n} min left`;
}

function elapsed(t0: number): number {
  return Math.round((performance.now() - t0) / 100) / 10;
}

/**
 * The readable message plus the cause chain, so a node rejection's
 * `1010 Custom error: N` makes it into the log. Wallet errors carry bigints,
 * which plain JSON.stringify throws on.
 */
function errorText(err: unknown): string {
  const parts = [errorMessage(err, "Unknown error")];
  let cur: unknown = err;
  for (let i = 0; cur && i < 6; i++) {
    const msg = cur instanceof Error ? cur.message : typeof cur === "object" ? safeJson(cur) : String(cur);
    if (msg && !parts.some((p) => p.includes(msg))) parts.push(msg);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" | cause: ").replace(/\s+/g, " ").slice(0, 2_000);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}
