// Setup: the five things a wallet account needs before it can post or solve,
// each checked live. Browsing needs none of them once a board is joined.
import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { toHex, validatePassword } from "@midnight-ntwrk/midnight-js-utils";
import { useWallet } from "@/hooks/use-wallet";
import { errorMessage } from "@/lib/errors";
import { DEFAULT_PROOF_SERVER_URL } from "@/midnight/providers";
import { parseAmount } from "@/midnight/private-bounties-api";
import { NETWORK_IDS, type NetworkId } from "@/providers/wallet-context";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { amount, short, SPECK_PER_DUST, units } from "~/lib/format";
import { href } from "~/router";
import { useSession } from "~/session";
import { useProofServer } from "~/hooks/use-proof-server";
import { networkName } from "~/components/top-bar";
import { Button, CopyButton, cx, Input, LinkButton, Panel } from "~/components/ui";

const PROOF_COMMAND = "docker run -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:8.1.0 midnight-proof-server -v";

type StepState = "done" | "current" | "todo";

export function SetupPage() {
  const wallet = useWallet();
  const { locked, proving } = useMidnightProviders();
  const { dust, deployment, state } = useSession();
  const server = useProofServer(proving.mode === "local" ? proving.proofServerUrl : null);

  const connected = wallet.status === "connected";
  const unlocked = connected && !locked;
  const proofOk = proving.mode === "wallet" || server.status === "ready";
  const dustOk = dust !== null && dust.balance > 0n;
  const boardOk = deployment.contract !== null && state !== null;
  const done = [connected, unlocked, proofOk, dustOk, boardOk];
  const doneCount = done.filter(Boolean).length;
  const firstOpen = done.indexOf(false);
  const stepState = (i: number): StepState => (done[i] ? "done" : i === firstOpen ? "current" : "todo");

  return (
    <div className="flex flex-wrap items-start gap-12">
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
        <header className="flex flex-col gap-2">
          <span className="text-sm text-muted">
            <span className="font-mono text-fg">{doneCount}</span> of 5 done
          </span>
          <h1 className="m-0 text-4xl font-semibold tracking-tight">Get set up</h1>
          <p className="m-0 max-w-[600px] text-muted">
            Five things are needed before you can post or solve. Each one is checked live, so you'll see it turn green when it's
            ready.
          </p>
        </header>
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          <Step n={1} title="Connect a wallet" state={stepState(0)} note={connected ? `${wallet.wallets.find((w) => w.key === wallet.selectedWalletKey)?.name ?? "Wallet"} on ${networkName(wallet.networkId)}` : "Any wallet with the Midnight DApp Connector"}>
            {!connected && <WalletStep />}
          </Step>
          <Step n={2} title="Unlock this browser's private store" state={stepState(1)} note={unlocked ? "Unlocked for this session" : "Holds the keys that read your answers and claim refunds"}>
            {connected && locked && <StoreStep />}
          </Step>
          <Step
            n={3}
            title="Make proofs on this machine"
            state={stepState(2)}
            note={proving.mode === "wallet" ? "Your wallet makes the proofs instead" : proofOk ? `Proof server at ${proving.proofServerUrl}` : "A local proof server keeps your secrets on this machine"}
          >
            <ProofStep ready={server.status === "ready"} recheck={server.recheck} />
          </Step>
          <Step n={4} title="DUST for fees" state={stepState(3)} note={dust ? `${units(dust.balance, SPECK_PER_DUST, 2)} DUST` : "Checked once a wallet is connected"}>
            {connected && !dustOk && <DustStep />}
          </Step>
          <Step
            n={5}
            title="Join a board"
            state={stepState(4)}
            keepOpen
            note={boardOk && deployment.address ? `Bounty contract ${short(deployment.address, 10, 8)}` : "A board is one bounty contract"}
          >
            {unlocked && <BoardStep />}
          </Step>
        </ol>
        {doneCount === 5 && (
          <Panel tone="ok" className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <span className="font-semibold">You're ready to post and solve.</span>
            <LinkButton href={href({ name: "board" })}>Go to the board</LinkButton>
          </Panel>
        )}
      </div>
      <aside className="flex max-w-[360px] min-w-0 flex-[1_1_280px] flex-col gap-6 text-sm">
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[15px] font-semibold">Why each one</h2>
          <p className="m-0 text-muted">
            <strong className="text-fg">Wallet.</strong> Pays rewards in, receives payouts, and signs every transaction.
          </p>
          <p className="m-0 text-muted">
            <strong className="text-fg">Private store.</strong> Holds the keys that let you read answers and claim refunds. It never
            leaves this browser, and nobody can recover it for you.
          </p>
          <p className="m-0 text-muted">
            <strong className="text-fg">Proof server.</strong> Makes the zero-knowledge proofs on your machine, so your secrets stay
            on it.
          </p>
          <p className="m-0 text-muted">
            <strong className="text-fg">DUST.</strong> Every transaction costs a small fee in DUST. Solvers need nothing else.
          </p>
          <p className="m-0 text-muted">
            <strong className="text-fg">Board.</strong> One bounty contract that holds the rewards. Join one by its address, or start
            your own.
          </p>
        </section>
      </aside>
    </div>
  );
}

/** `keepOpen`: show the step's controls even once it's done (the board step, which has more to do after joining). */
function Step({ n, title, note, state, children, keepOpen = false }: { n: number; title: string; note: string; state: StepState; children?: ReactNode; keepOpen?: boolean }) {
  return (
    <li className={cx("rounded-lg border bg-surface", state === "current" ? "border-line-hover" : "border-line")}>
      <div className="flex items-start gap-4 px-5 py-4">
        <span
          aria-hidden="true"
          className={cx(
            "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs",
            state === "done" ? "bg-ok text-page" : state === "current" ? "border border-fg text-fg" : "border border-line-strong text-faint",
          )}
        >
          {state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : n}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={cx("font-semibold", state === "todo" && "text-muted")}>
            {title}
            <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (next)" : ""}</span>
          </span>
          <span className="text-sm break-words text-muted">{note}</span>
        </span>
      </div>
      {children && (state !== "done" || keepOpen) && <div className="flex flex-col gap-3 border-t border-line-soft px-5 py-4 sm:pl-15">{children}</div>}
    </li>
  );
}

function WalletStep() {
  const { wallets, selectedWalletKey, setSelectedWalletKey, requestedNetworkId, setRequestedNetworkId, connect, status, error } = useWallet();
  return (
    <>
      <label className="flex flex-wrap items-center gap-3 text-sm text-muted">
        Network
        <select
          value={requestedNetworkId}
          onChange={(e) => setRequestedNetworkId(e.target.value as NetworkId)}
          className="h-9 rounded-lg border border-line bg-page px-2 text-fg"
        >
          {NETWORK_IDS.map((id) => (
            <option key={id} value={id}>
              {networkName(id)}
            </option>
          ))}
        </select>
        <span className="text-faint">Pick the network your wallet is set to.</span>
      </label>
      {wallets.length === 0 ? (
        <p className="m-0 text-sm text-muted">No Midnight wallet found in this browser. Install one (Lace or 1AM), then reload.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {wallets.length > 1 && (
            <label className="flex items-center gap-3 text-sm text-muted">
              Wallet
              <select
                value={selectedWalletKey ?? ""}
                onChange={(e) => setSelectedWalletKey(e.target.value)}
                className="h-9 rounded-lg border border-line bg-page px-2 text-fg"
              >
                {wallets.map((w) => (
                  <option key={w.key} value={w.key}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button busy={status === "connecting"} onClick={() => void connect()}>
            Connect {wallets.find((w) => w.key === selectedWalletKey)?.name ?? "wallet"}
          </Button>
        </div>
      )}
      {error && <p className="m-0 text-sm text-bad">{error}</p>}
    </>
  );
}

function StoreStep() {
  const { unlock, unlockError } = useMidnightProviders();
  const [value, setValue] = useState("");
  let weak: string | null = null;
  if (value) {
    try {
      validatePassword(value);
    } catch (err: unknown) {
      weak = errorMessage(err, "Passphrase is too weak");
    }
  }
  return (
    <form
      className="flex flex-col gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (value && !weak) unlock(value);
      }}
    >
      <label htmlFor="pass" className="text-sm font-semibold">
        Passphrase
      </label>
      <div className="flex flex-wrap gap-2">
        <Input id="pass" type="password" autoComplete="current-password" className="flex-[1_1_260px]" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" size="lg" disabled={!value || weak !== null}>
          Unlock
        </Button>
      </div>
      <span role="status" className={cx("text-[13px]", weak ? "text-warn" : value ? "text-ok" : "text-muted")}>
        {weak ?? (value ? "Strong enough" : "16 or more characters, with three of: upper case, lower case, digits, symbols")}
      </span>
      {unlockError && <p className="m-0 text-sm text-bad">{unlockError}</p>}
      <span className="text-[13px] text-muted">
        The first passphrase you use for this wallet account becomes its passphrase. It's never stored, and there's no recovery:
        forgetting it, or clearing this site's data, loses the keys for bounties you posted.
      </span>
    </form>
  );
}

function ProofStep({ ready, recheck }: { ready: boolean; recheck: () => void }) {
  const { proving, setProving } = useMidnightProviders();
  if (proving.mode === "wallet") {
    return (
      <>
        <p className="m-0 text-sm text-warn">
          Your wallet, and any hosted prover it uses, sees each proof's inputs: your identity secret when you post or refund, and
          your answer when you solve.
        </p>
        <div>
          <Button variant="ghost" onClick={() => setProving({ mode: "local", proofServerUrl: proving.proofServerUrl || DEFAULT_PROOF_SERVER_URL })}>
            Prove on this machine instead
          </Button>
        </div>
      </>
    );
  }
  if (ready) return null;
  return (
    <>
      <span className="text-sm text-muted">Start the proof server on this machine. It needs Docker.</span>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-page py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap text-fg-2">{PROOF_COMMAND}</code>
        <CopyButton text={PROOF_COMMAND} label="Copy command" />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="ghost" onClick={recheck}>
          Check again
        </Button>
        <Button variant="quiet" onClick={() => setProving({ mode: "wallet", proofServerUrl: proving.proofServerUrl })}>
          Prove in my wallet instead
        </Button>
      </div>
      <span className="text-[13px] text-muted">
        Proving in your wallet skips this step, but your wallet, and any service it uses, then sees your answers and keys.
      </span>
    </>
  );
}

function DustStep() {
  const { networkId, connectedApi } = useWallet();
  const [dustAddress, setDustAddress] = useState<string | null>(null);
  return (
    <>
      <span className="text-sm text-muted">
        DUST pays network fees. Your wallet generates it from NIGHT you hold: turn on DUST generation in the wallet.
        {networkId === "preview" || networkId === "preprod" ? ` On ${networkName(networkId)}, get NIGHT from its faucet first.` : ""}
      </span>
      {networkId === "undeployed" && (
        <div className="flex flex-col gap-2 text-sm">
          <span className="text-muted">On the local devnet, fund this wallet from the examples repo:</span>
          {dustAddress ? (
            <div className="flex items-center gap-2 rounded-lg border border-line bg-page py-1 pr-1 pl-3">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[13px] whitespace-nowrap text-fg-2">yarn fund:wallet {dustAddress}</code>
              <CopyButton text={`yarn fund:wallet ${dustAddress}`} label="Copy command" />
            </div>
          ) : (
            <div>
              <Button variant="ghost" size="sm" onClick={() => void connectedApi?.getDustAddress().then((a) => setDustAddress(a.dustAddress))}>
                Show the command
              </Button>
            </div>
          )}
        </div>
      )}
      <span className="text-[13px] text-faint">This step turns green on its own once DUST arrives.</span>
    </>
  );
}

function BoardStep() {
  const { deployment, token, canMint, tokenProviders, deployToken, mint, rewardBalance, state, work, templates } = useSession();
  const [pasted, setPasted] = useState("");
  const [tokenPasted, setTokenPasted] = useState("");
  const [mintAmount, setMintAmount] = useState("1000");
  const busy = deployment.busy !== null;
  const joined = deployment.contract !== null;
  const validAddress = (s: string) => /^[0-9a-fA-F]{64}$/.test(s.trim());
  const parsed = parseBoardCode(pasted);

  if (joined && state) {
    return (
      <div className="flex flex-col gap-3 text-sm">
        <ExtraStep
          slot={work}
          name="reviewed work"
          about="A contract for work a person reviews, paying in the same token."
          busyLabel="Starting reviewed work"
        />
        <ExtraStep slot={templates.factor} name="factor bounties" about="Solvers prove they know two factors of a number." busyLabel="Adding factor bounties" />
        <ExtraStep
          slot={templates.signed}
          name="signed-record bounties"
          about="Solvers prove they hold a record an issuer signed."
          busyLabel="Adding signed record bounties"
        />
        {canMint ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Test tokens for rewards (they carry no value):</span>
            <Input aria-label="Amount to mint" className="h-9 w-28" value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} />
            <Button
              variant="ghost"
              disabled={busy || !tokenProviders || parseAmount(mintAmount) === null}
              onClick={() => {
                const n = parseAmount(mintAmount);
                if (n !== null) void mint(n);
              }}
            >
              Mint to my wallet
            </Button>
            {rewardBalance !== null && <span className="text-faint">You hold {amount(rewardBalance)} TEST</span>}
          </div>
        ) : (
          <span className="text-muted">Solvers need no reward tokens. To post here, ask the board's owner for some TEST.</span>
        )}
        <div>
          <Button variant="quiet" onClick={deployment.forget}>
            Leave this board
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 text-sm">
      {deployment.address && !joined && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-muted">{deployment.busy === "joining" ? "Joining" : "Couldn't join"} {short(deployment.address, 10, 8)}</span>
          {deployment.busy !== "joining" && (
            <>
              <Button variant="ghost" size="sm" onClick={() => void deployment.rejoin()}>
                Retry
              </Button>
              <Button variant="quiet" onClick={deployment.forget}>
                Forget it
              </Button>
            </>
          )}
        </div>
      )}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!parsed) return;
          work.setAddress(parsed.work);
          templates.factor.setAddress(parsed.factor);
          templates.signed.setAddress(parsed.signed);
          void deployment.join(parsed.verified);
        }}
      >
        <label htmlFor="board-address" className="font-semibold">
          Join a board by its code
        </label>
        <div className="flex flex-wrap gap-2">
          <Input id="board-address" className="flex-[1_1_320px] font-mono text-[13px]" placeholder="The board code, or a contract address" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <Button type="submit" size="lg" disabled={busy || !parsed} busy={deployment.busy === "joining"}>
            Join
          </Button>
        </div>
      </form>
      <div className="flex flex-col gap-2 border-t border-line-soft pt-4">
        <span className="font-semibold">Or start a new board</span>
        <span className="text-muted">Two transactions: a test token to pay rewards in, then a bounty contract that pays in it.</span>
        {token.address ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] text-fg-2">Token {short(token.address, 10, 8)}</span>
            <Button variant="quiet" disabled={busy} onClick={token.forget}>
              Use another
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" disabled={busy || !tokenProviders} onClick={() => void deployToken()}>
              1. Deploy a test token
            </Button>
            <span className="text-faint">or reuse one:</span>
            <Input aria-label="Token contract address" className="h-9 flex-[1_1_200px] font-mono text-[13px]" placeholder="token address" value={tokenPasted} onChange={(e) => setTokenPasted(e.target.value)} />
            <Button variant="ghost" size="sm" disabled={!validAddress(tokenPasted)} onClick={() => token.remember(tokenPasted.trim().toLowerCase())}>
              Use it
            </Button>
          </div>
        )}
        <div>
          <Button disabled={busy || !token.address} busy={deployment.busy === "deploying"} onClick={() => token.address && void deployment.deploy({ tokenAddress: token.address })}>
            2. Deploy the bounty contract
          </Button>
        </div>
      </div>
      {deployment.error && <p className="m-0 text-sm break-words text-bad">{deployment.error}</p>}
    </div>
  );
}

/**
 * A board code: the contracts' addresses joined by dots, in a fixed order
 * (verified answers, reviewed work, factor, signed record), with empty places
 * for ones the board doesn't have. A single address joins just the first.
 */
export function parseBoardCode(text: string): { verified: string; work: string | null; factor: string | null; signed: string | null } | null {
  const parts = text.trim().toLowerCase().split(".");
  if (parts.length > 4) return null;
  const [verified, work, factor, signed] = parts;
  const ok = (a: string | undefined) => a === undefined || a === "" || /^[0-9a-f]{64}$/.test(a);
  if (!verified || !/^[0-9a-f]{64}$/.test(verified) || ![work, factor, signed].every(ok)) return null;
  const or = (a: string | undefined) => (a ? a : null);
  return { verified, work: or(work), factor: or(factor), signed: or(signed) };
}

interface ExtraSlot {
  address: string | null;
  setAddress: (a: string | null) => void;
  providers: unknown;
  contract: unknown;
  joining: boolean;
  joinError: string | null;
  retry: () => void;
  state: { rewardColor: Uint8Array } | null;
  deploy: () => Promise<void>;
}

/** One of the board's other contracts: joined, joining, or not added yet. */
function ExtraStep({ slot, name, about, busyLabel }: { slot: ExtraSlot; name: string; about: string; busyLabel: string }) {
  const { deployment, colorHex } = useSession();
  const [pasted, setPasted] = useState("");
  const busy = deployment.busy !== null;
  const valid = /^[0-9a-f]{64}$/.test(pasted.trim().toLowerCase());
  const Name = name[0]!.toUpperCase() + name.slice(1);
  if (slot.address && slot.contract) {
    const otherToken = slot.state !== null && colorHex !== null && toHex(slot.state.rewardColor) !== colorHex;
    return (
      <div className="flex flex-col gap-1">
        <span className="text-muted">
          {Name}: joined {short(slot.address, 10, 8)}.
        </span>
        {otherToken && <span className="text-warn">It pays in a different token from this board, so rewards and balances won't line up. Use the one that came with this board's code.</span>}
      </div>
    );
  }
  if (slot.address) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted">
          {slot.joining ? `Joining ${name}` : `Couldn't join ${name}`} {short(slot.address, 10, 8)}
        </span>
        {!slot.joining && (
          <>
            <Button variant="ghost" size="sm" onClick={slot.retry}>
              Retry
            </Button>
            <Button variant="quiet" onClick={() => slot.setAddress(null)}>
              Forget it
            </Button>
          </>
        )}
        {slot.joinError && <p className="m-0 w-full text-sm break-words text-bad">{slot.joinError}</p>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 border-b border-line-soft pb-4">
      <span className="font-semibold">Add {name} to this board</span>
      <span className="text-muted">{about}</span>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" disabled={busy || !slot.providers} busy={deployment.busy === busyLabel} onClick={() => void slot.deploy()}>
          Deploy it
        </Button>
        <span className="text-faint">or join one:</span>
        <Input aria-label={`${Name} contract address`} className="h-9 flex-[1_1_200px] font-mono text-[13px]" placeholder="contract address" value={pasted} onChange={(e) => setPasted(e.target.value)} />
        <Button variant="ghost" size="sm" disabled={!valid} onClick={() => slot.setAddress(pasted.trim().toLowerCase())}>
          Join
        </Button>
      </div>
    </div>
  );
}
