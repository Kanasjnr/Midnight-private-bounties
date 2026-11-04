// One bounty. The solver's view checks the answer in the browser as it's
// typed, then proves and submits it in one transaction. The poster's view
// decrypts the delivered answer here, or claims the refund after the deadline.
import { useState, type ReactNode } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { pureCircuits } from "@/midnight/contract";
import { useMidnightProviders } from "@/providers/midnight-providers";
import {
  actionError,
  encodeAnswer,
  readAnswer,
  refund,
  Status,
  submitAnswer,
  type BountyView,
} from "@/midnight/private-bounties-api";
import { statusOf } from "~/lib/board";
import { ago, amount, dateTime, short, span } from "~/lib/format";
import { cleanDetails, cleanTitle, hadHiddenCharacters } from "~/lib/sanitize";
import { href, type Route } from "~/router";
import { useSession } from "~/session";
import { Loading } from "~/pages/board";
import { TemplateBounty } from "~/pages/template-bounty";
import { canBrowse } from "~/midnight/read-only";
import { WalletGate } from "~/components/wallet-gate";
import { Countdown } from "~/components/countdown";
import { Amount, Button, Chip, CopyButton, cx, Dot, Facts, LinkButton, Panel, StatusText, Textarea, Visibility } from "~/components/ui";

export function BountyPage({ route }: { route: Extract<Route, { name: "bounty" }> }) {
  const { status } = useWallet();
  const { deployment, state, views, templates, boardAddress, browsing, network, openBoard } = useSession();

  if (status !== "connected" && !canBrowse(network)) {
    return <Elsewhere text="Connect a wallet to see this bounty." action="Get set up" href={href({ name: "setup" })} />;
  }
  // A factor or signed-record bounty: same route, the template's own contract.
  const slot = Object.values(templates).find((t) => t.address === route.address);
  if (slot) {
    if (!slot.state) return <Loading what="Reading the board from the indexer" error={slot.joinError} />;
    const v = slot.views.find((x) => x.idHex === route.id);
    if (!v) return <Elsewhere text="There's no bounty with this ID on this board." action="Back to the board" href={href({ name: "board" })} />;
    return <TemplateBounty slot={slot} v={v} />;
  }
  if (boardAddress !== route.address) {
    return (
      <Elsewhere
        text={`This bounty is on another board, ${short(route.address, 10, 8)}.`}
        action={browsing && status !== "connected" ? "Open that board" : "Join that board"}
        onClick={() => openBoard({ verified: route.address, work: null, factor: null, signed: null })}
        busy={deployment.busy === "joining"}
        error={deployment.error}
      />
    );
  }
  if (!state) return <Loading what="Reading the board from the indexer" error={deployment.error} />;
  const b = views.find((v) => v.idHex === route.id);
  if (!b) return <Elsewhere text="There's no bounty with this ID on this board." action="Back to the board" href={href({ name: "board" })} />;
  return b.mine ? <PosterView b={b} /> : <SolverView b={b} />;
}

function Elsewhere({ text, action, href: to, onClick, busy, error }: { text: string; action: string; href?: string; onClick?: () => void; busy?: boolean; error?: string | null }) {
  return (
    <div className="flex flex-col items-start gap-4 py-16">
      <p className="m-0 text-lg text-muted">{text}</p>
      {to ? <LinkButton href={to}>{action}</LinkButton> : <Button onClick={onClick} busy={busy}>{action}</Button>}
      {error && <p className="m-0 text-sm text-bad">{error}</p>}
    </div>
  );
}

function Layout({ b, crumb, children, aside }: { b: BountyView; crumb: Route; children: ReactNode; aside: ReactNode }) {
  const title = cleanTitle(b.title) || "Untitled";
  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-muted">
        <a href={href(crumb)} className="text-muted no-underline hover:text-fg">
          {crumb.name === "mine" ? "My bounties" : "Bounties"}
        </a>
        <span aria-hidden="true">/</span>
        <span className="truncate text-fg-2">{title}</span>
      </nav>
      <div className="flex flex-wrap items-start gap-12">
        <article className="flex min-w-0 flex-[999_1_560px] flex-col gap-8">{children}</article>
        <aside aria-label="Bounty details" className="flex max-w-[360px] min-w-0 flex-[1_1_300px] flex-col gap-6">
          {aside}
        </aside>
      </div>
    </div>
  );
}

function Heading({ b, mine }: { b: BountyView; mine?: boolean }) {
  const hidden = hadHiddenCharacters(b.title) || hadHiddenCharacters(b.details);
  return (
    <header className="flex flex-col gap-3">
      {mine && (
        <div>
          <Chip>Yours</Chip>
        </div>
      )}
      <h1 className="m-0 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">{cleanTitle(b.title) || "Untitled"}</h1>
      <p className="m-0 text-lg whitespace-pre-wrap text-fg-2">{cleanDetails(b.details) || "No question was given."}</p>
      {hidden && <p className="m-0 text-[13px] text-warn">This listing had hidden characters (text direction or zero-width marks), removed here.</p>}
    </header>
  );
}

function Details({ b, extra }: { b: BountyView; extra?: [ReactNode, ReactNode][] }) {
  const { now } = useSession();
  const s = statusOf(b, now);
  return (
    <Panel className="px-5 py-2">
      <Facts
        rows={[
          ["Status", <StatusText {...s} />],
          ["Reward", <Amount value={b.reward !== null ? amount(b.reward) : "–"} />],
          [
            b.status === Status.OPEN ? (now < b.deadline ? "Ends" : "Ended") : "Deadline",
            <span className="flex flex-col items-end">
              <span>{b.status === Status.OPEN ? <Countdown deadline={b.deadline} bare /> : dateTime(b.deadline)}</span>
              {b.status === Status.OPEN && <span className="text-[13px] text-faint">{dateTime(b.deadline)}</span>}
            </span>,
          ],
          ...(b.postedAt !== null ? ([["Posted", ago(b.postedAt, now)]] as [ReactNode, ReactNode][]) : []),
          ["Template", "Preimage"],
          ...(extra ?? []),
          [
            "Bounty ID",
            <span className="inline-flex items-center gap-1 font-mono text-[13px]">
              {short(b.idHex, 8, 6)}
              <CopyButton text={b.idHex} label="Copy bounty ID" />
            </span>,
          ],
        ]}
      />
    </Panel>
  );
}

function SolverView({ b }: { b: BountyView }) {
  const { state, deployment, now, colorHex, run, solvedHere, hidden } = useSession();
  const { proving } = useMidnightProviders();
  const [answer, setAnswer] = useState("");
  const { contract, providers, address, busy } = deployment;
  if (!state || !address) return null;

  const text = answer.trim();
  const err = actionError("submit", state, b, now, answer);
  const closed = b.status !== Status.OPEN || now >= b.deadline;
  const solvedByMe = solvedHere.set.has(b.idHex);
  const title = cleanTitle(b.title) || "Untitled";

  const check: { tone: "ok" | "warn" | "muted"; text: string } =
    err === null
      ? { tone: "ok", text: "Matches. Checked in your browser, nothing sent yet" }
      : text === ""
        ? { tone: "muted", text: "Checked in your browser as you type" }
        : err === "Wrong answer"
          ? { tone: "warn", text: "Not a match. Nothing is proved or sent until it matches" }
          : { tone: "warn", text: err };

  const submit = async () => {
    if (!contract || !providers || !colorHex) return;
    const ok = await run("Submitting answer", title, () => submitAnswer(contract, providers, address, b.id, answer, colorHex), {
      href: () => href({ name: "bounty", address, id: b.idHex }),
    });
    if (ok) {
      solvedHere.add(b.idHex);
      setAnswer("");
    }
  };

  return (
    <Layout
      b={b}
      crumb={{ name: "board" }}
      aside={
        <>
          <Details b={b} extra={[["Poster", <span>Anonymous <span className="text-faint">(a new identity per bounty)</span></span>]]} />
          <section aria-labelledby="vis" className="flex flex-col gap-3">
            <h2 id="vis" className="m-0 text-[15px] font-semibold">
              When you solve it
            </h2>
            <Visibility
              pub="That it was solved and paid, and your answer as ciphertext"
              priv="Your answer (only the poster can decrypt it), your identity, and where the reward lands"
            />
          </section>
          <div className="flex flex-col gap-1 text-sm">
            {hidden.set.has(b.idHex) ? (
              <Button variant="quiet" className="self-start" onClick={() => hidden.remove(b.idHex)}>
                Show it on my board again
              </Button>
            ) : (
              <Button variant="quiet" className="self-start" onClick={() => hidden.add(b.idHex)}>
                Hide this bounty from my board
              </Button>
            )}
            <span className="text-[13px] text-faint">Only in this browser. Anyone can post anything here.</span>
          </div>
        </>
      }
    >
      <Heading b={b} />
      <section aria-labelledby="checked" className="flex flex-col gap-2">
        <h2 id="checked" className="m-0 text-lg font-semibold">
          How your answer is checked
        </h2>
        <p className="m-0 text-muted">
          The poster published a hash of the right answer. Your browser compares your answer with it first. Your machine then makes
          a zero-knowledge proof that it matches, and the contract checks the proof, never the answer. In the same transaction,
          your answer is stored encrypted to the poster and the reward is paid to you.
        </p>
      </section>

      {solvedByMe && b.status === Status.SOLVED ? (
        <Panel tone="ok" className="flex flex-col gap-1 px-5 py-4">
          <span className="font-medium">You solved it</span>
          <span className="text-sm text-fg-2">
            {b.reward !== null ? `${amount(b.reward)} TEST` : "The reward"} went to your shielded balance. It shows in your wallet once it
            has synced.
          </span>
        </Panel>
      ) : closed ? (
        <Panel className="px-5 py-4 text-muted">
          {b.status === Status.SOLVED ? "Someone already solved this one." : b.status === Status.REFUNDED ? "The poster took the reward back." : "The deadline has passed, so it can't be solved any more."}
        </Panel>
      ) : (
        <WalletGate doing="solve it">
        <section aria-labelledby="answer-label" className="flex flex-col gap-3">
          <div className={cx("flex flex-col rounded-lg border bg-surface", err === null ? "border-ok-line" : "border-line")}>
            <label id="answer-label" htmlFor="answer" className="px-4 pt-3 text-sm font-medium">
              Your answer
            </label>
            <Textarea
              id="answer"
              rows={3}
              placeholder="Type your answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              className="min-h-21 border-0 bg-transparent px-4 pt-2 text-base hover:border-0 focus:border-0"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft px-4 py-3">
              <span role="status" className={cx("inline-flex items-center gap-2 text-sm", check.tone === "ok" ? "text-ok" : check.tone === "warn" ? "text-warn" : "text-muted")}>
                <Dot tone={check.tone === "ok" ? "ok" : check.tone === "warn" ? "warn" : "muted"} />
                {check.text}
              </span>
              <Button disabled={err !== null || busy !== null || !contract} busy={busy === "Submitting answer"} onClick={() => void submit()}>
                Prove and submit
              </Button>
            </div>
          </div>
          {proving.mode === "wallet" && (
            <p className="m-0 text-sm text-warn">
              Your wallet is set to make the proof, so it sees your answer. <a href={href({ name: "setup" })} className="text-link">Prove on this machine</a> to keep it here.
            </p>
          )}
          <p className="m-0 text-sm text-faint">
            The proof is made on your machine. Expect a few minutes in all, with one approval in your wallet. You only need DUST for
            the fee: the reward is paid in the same transaction.
          </p>
        </section>
        </WalletGate>
      )}
    </Layout>
  );
}

function PosterView({ b }: { b: BountyView }) {
  const { state, deployment, now, ps, run, read } = useSession();
  const { contract, address, busy } = deployment;
  const [plain, setPlain] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  if (!state || !address) return null;
  const title = cleanTitle(b.title) || "Untitled";
  const expired = b.status === Status.OPEN && now >= b.deadline;
  const refundErr = actionError("refund", state, b, now);
  const decryptErr = actionError("decrypt", state, b, now);
  const link = `${window.location.origin}${window.location.pathname}${href({ name: "bounty", address, id: b.idHex })}`;

  const decrypt = async () => {
    setFailed(null);
    if (!ps?.posterSeed) {
      setFailed("This browser's store has no key for this board. Was it posted from another browser or wallet account?");
      return;
    }
    try {
      const text = await readAnswer(state, address, b.id, ps.posterSeed);
      setPlain(text);
      read.add(b.idHex);
    } catch (err: unknown) {
      setFailed(err instanceof Error ? err.message : String(err));
    }
  };

  // Re-check the decrypted answer against the hash the bounty was posted with.
  let matches: boolean | null = null;
  if (plain !== null) {
    try {
      matches = pureCircuits.checkAnswer(encodeAnswer(plain), b.target);
    } catch {
      matches = false;
    }
  }

  return (
    <Layout
      b={b}
      crumb={{ name: "mine" }}
      aside={
        <>
          <Details b={b} extra={[["Listed", "On the public board"]]} />
          <section aria-labelledby="key-title" className="flex flex-col gap-2 rounded-lg border border-line p-4 text-sm">
            <h2 id="key-title" className="m-0 text-[15px] font-semibold">
              Key for this bounty
            </h2>
            <span className="text-muted">
              Derived from the seed in this browser's encrypted store. It's what reads the answer and claims the refund, so clearing
              this site's data, or losing the passphrase, loses it.
            </span>
          </section>
        </>
      }
    >
      <Heading b={b} mine />

      {b.status === Status.SOLVED && (
        <section aria-labelledby="ans" className="flex flex-col gap-3">
          <h2 id="ans" className="m-0 text-lg font-semibold">
            The answer
          </h2>
          {plain === null ? (
            <Panel className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
              <span className="text-sm text-muted">Someone solved it and was paid. Their answer is on chain, encrypted to you.</span>
              <Button disabled={decryptErr !== null} onClick={() => void decrypt()}>
                Decrypt here
              </Button>
            </Panel>
          ) : (
            <Panel tone="navy" className="flex flex-col gap-3 px-5 py-4">
              <span className="text-[13px] text-private">Decrypted in this browser. Only you can read it.</span>
              <p className="m-0 font-mono text-lg break-words whitespace-pre-wrap">{plain}</p>
              <span className={cx("inline-flex items-center gap-2 text-sm", matches ? "text-ok" : "text-warn")}>
                <Dot tone={matches ? "ok" : "warn"} />
                {matches ? "Matches the hash you published" : "Doesn't match the published hash"}
              </span>
              <div className="flex gap-2">
                <CopyButton text={plain} label="Copy answer" />
              </div>
            </Panel>
          )}
          {failed && <p className="m-0 text-sm text-bad">{failed}</p>}
        </section>
      )}

      {expired && (
        <section aria-labelledby="rf" className="flex flex-col gap-3">
          <h2 id="rf" className="m-0 text-lg font-semibold">
            Nobody solved it before the deadline
          </h2>
          <p className="m-0 text-muted">The reward is still held by the contract. Only you can take it back, and it returns to your shielded balance.</p>
          <div>
            <Button
              size="lg"
              disabled={refundErr !== null || busy !== null || !contract}
              busy={busy === "Claiming refund"}
              onClick={() =>
                void run("Claiming refund", title, async () => {
                  if (!contract) throw new Error("Not joined to this board");
                  return refund(contract, b.id);
                })
              }
            >
              Refund {b.reward !== null ? `${amount(b.reward)} TEST` : ""}
            </Button>
          </div>
        </section>
      )}

      {b.status === Status.OPEN && !expired && (
        <section aria-labelledby="wt" className="flex flex-col gap-3">
          <h2 id="wt" className="m-0 text-lg font-semibold">
            Waiting for answers
          </h2>
          <p className="m-0 text-muted">
            The reward is locked in the contract until someone solves it or the deadline passes, in {span(b.deadline - now)}. You can't
            cancel early. If nobody solves it, you can take it back here.
          </p>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">Link to share</span>
            <CopyButton text={link} label="Copy link to share" />
          </div>
        </section>
      )}

      {b.status === Status.REFUNDED && (
        <Panel className="px-5 py-4 text-muted">You took the reward back after the deadline.</Panel>
      )}
    </Layout>
  );
}
