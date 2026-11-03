// One piece of reviewed work. What it shows depends on who's looking: anyone
// can apply or claim; the assigned contributor delivers and collects; the
// poster reads applications, assigns, reviews and takes back an unearned
// reward; the arbiter can overturn a rejection. Every button is gated by
// workActionError, which mirrors the circuit's asserts.
import { useState, type ReactNode } from "react";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { useWallet } from "@/hooks/use-wallet";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { amount, dateTime, short, span } from "~/lib/format";
import { workStatus } from "~/lib/items";
import { cleanDetails, cleanTitle, hadHiddenCharacters } from "~/lib/sanitize";
import {
  approve,
  assign,
  claim,
  collect,
  contributorPseudonym,
  makeApplication,
  openApplication,
  overturn,
  PLAN_MAX,
  readSubmission,
  refundWork,
  reject,
  release,
  reopen,
  submitWork,
  workActionError,
  WorkStatus,
  type Application,
  type WorkAction,
  type WorkView,
} from "~/midnight/work-api";
import { href, type Route } from "~/router";
import { useSession } from "~/session";
import { Countdown } from "~/components/countdown";
import { Loading } from "~/pages/board";
import { Amount, Button, Chip, CopyButton, Facts, Field, Input, LinkButton, Panel, StatusText, Textarea, Visibility } from "~/components/ui";

export function WorkPage({ route }: { route: Extract<Route, { name: "work" }> }) {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { work } = useSession();

  if (status !== "connected" || locked) return <Note text="Connect a wallet and unlock this browser's store to see this work." action="Get set up" to={href({ name: "setup" })} />;
  if (work.address !== route.address) {
    return (
      <div className="flex flex-col items-start gap-4 py-16">
        <p className="m-0 text-lg text-muted">This work is on another board's reviewed-work contract, {short(route.address, 10, 8)}.</p>
        <Button onClick={() => work.setAddress(route.address)}>Join that contract</Button>
      </div>
    );
  }
  if (!work.state) return <Loading what="Reading reviewed work from the indexer" error={work.joinError} />;
  const v = work.views.find((w) => w.idHex === route.id);
  if (!v) return <Note text="There's no work with this ID on this contract." action="Back to the board" to={href({ name: "board" })} />;
  return <WorkDetail v={v} />;
}

function Note({ text, action, to }: { text: string; action: string; to: string }) {
  return (
    <div className="flex flex-col items-start gap-4 py-16">
      <p className="m-0 text-lg text-muted">{text}</p>
      <LinkButton href={to}>{action}</LinkButton>
    </div>
  );
}

const ACTION_LABELS: Record<WorkAction, string> = {
  claim: "Claiming work",
  assign: "Assigning work",
  release: "Releasing the claim",
  submit: "Submitting work",
  approve: "Approving work",
  reject: "Rejecting work",
  overturn: "Overturning the rejection",
  reopen: "Reopening work",
  collect: "Collecting the reward",
  refund: "Taking the reward back",
};

function WorkDetail({ v }: { v: WorkView }) {
  const { work, now, colorHex, hidden } = useSession();
  const contract = work.contract;
  const title = cleanTitle(v.title) || "Untitled";
  const err = (a: WorkAction) => workActionError(a, work.state!, v, now);

  const role = v.mine ? "poster" : v.assignedToMe ? "contributor" : v.arbiterMe ? "arbiter" : "visitor";
  const s = workStatus(v, now);
  const t = v.terms;

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-muted">
        <a href={href(v.mine || v.assignedToMe ? { name: "mine" } : { name: "board" })} className="text-muted no-underline hover:text-fg">
          {v.mine || v.assignedToMe ? "My bounties" : "Bounties"}
        </a>
        <span aria-hidden="true">/</span>
        <span className="truncate text-fg-2">{title}</span>
      </nav>
      <div className="flex flex-wrap items-start gap-12">
        <article className="flex min-w-0 flex-[999_1_560px] flex-col gap-8">
          <header className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Chip>Reviewed work</Chip>
              {v.mine && <Chip>Yours</Chip>}
              {v.assignedToMe && <Chip className="border-private/40 text-private">You're on it</Chip>}
              {v.arbiterMe && <Chip>You're the arbiter</Chip>}
            </div>
            <h1 className="m-0 text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">{title}</h1>
            <p className="m-0 text-lg whitespace-pre-wrap text-fg-2">{cleanDetails(v.details) || "No description was given."}</p>
            {(hadHiddenCharacters(v.title) || hadHiddenCharacters(v.details)) && (
              <p className="m-0 text-[13px] text-warn">This listing had hidden characters (text direction or zero-width marks), removed here.</p>
            )}
          </header>

          {role === "poster" && <PosterActions v={v} />}
          {role === "contributor" && <ContributorActions v={v} />}
          {role === "arbiter" && v.status === WorkStatus.REJECTED && (
            <Section title="The contributor's work was rejected">
              <p className="m-0 text-muted">
                You can overturn the rejection until <Countdown deadline={v.until} before="the appeal window ends, in" after="the appeal window ended" />. Then the
                contributor collects the reward.
              </p>
              <div>
                <Act v={v} a="overturn" label="Overturn the rejection" call={() => overturn(contract!, v)} />
              </div>
            </Section>
          )}
          {role === "visitor" && <VisitorActions v={v} />}

          {err("reopen") === null && (
            <Section title={v.status === WorkStatus.ASSIGNED ? "The delivery window has run out" : "The appeal window has run out"}>
              <p className="m-0 text-muted">Anyone can reopen it, so someone else can take it on.</p>
              <div>
                <Act v={v} a="reopen" variant="ghost" label="Reopen it" call={() => reopen(contract!, v)} />
              </div>
            </Section>
          )}
        </article>

        <aside aria-label="Work details" className="flex max-w-[360px] min-w-0 flex-[1_1_300px] flex-col gap-6">
          <Panel className="px-5 py-2">
            <Facts
              rows={[
                ["Status", <StatusText {...s} />],
                ["Reward", <Amount value={v.reward !== null ? amount(v.reward) : "–"} />],
                ["Who works on it", t.firstToClaim ? "First to claim" : "The poster picks"],
                ["Time to deliver", span(t.deliveryWindow)],
                ["Time to review", span(t.reviewWindow)],
                ["Final deadline", dateTime(t.deadline)],
                ["Arbiter", t.hasArbiter ? `Yes, ${span(t.appealWindow)} to appeal` : "None"],
                [
                  "Work ID",
                  <span className="inline-flex items-center gap-1 font-mono text-[13px]">
                    {short(v.idHex, 8, 6)}
                    <CopyButton text={v.idHex} label="Copy work ID" />
                  </span>,
                ],
              ]}
            />
          </Panel>
          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-[15px] font-semibold">Who sees what</h2>
            <Visibility
              pub="The terms, the status, and a fresh pseudonym for whoever is assigned"
              priv="Who applied, who did the work, the submitted link (only the poster can read it), and where the reward goes"
            />
          </section>
          {!v.mine && (
            <div className="flex flex-col gap-1 text-sm">
              <Button variant="quiet" className="self-start" onClick={() => (hidden.set.has(v.idHex) ? hidden.remove(v.idHex) : hidden.add(v.idHex))}>
                {hidden.set.has(v.idHex) ? "Show it on my board again" : "Hide this from my board"}
              </Button>
              <span className="text-[13px] text-faint">Only in this browser. Anyone can post anything here.</span>
            </div>
          )}
          {colorHex === null && <p className="m-0 text-[13px] text-warn">The board's token isn't loaded yet, so collecting is disabled.</p>}
        </aside>
      </div>
    </div>
  );
}

/** A button for one contract call, disabled with the circuit's reason when it would fail. */
function Act({ v, a, label, call, variant = "primary" }: { v: WorkView; a: WorkAction; label: string; call: () => Promise<unknown>; variant?: "primary" | "ghost" }) {
  const { work, now, run, deployment } = useSession();
  const e = work.state ? workActionError(a, work.state, v, now) : "Not loaded";
  const title = cleanTitle(v.title) || "Untitled";
  return (
    <Button
      size="lg"
      variant={variant}
      disabled={e !== null || deployment.busy !== null || !work.contract}
      busy={deployment.busy === ACTION_LABELS[a]}
      title={e ?? undefined}
      onClick={() => void run(ACTION_LABELS[a], title, call, { href: () => href({ name: "work", address: work.address!, id: v.idHex }) })}
    >
      {label}
    </Button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** Anyone who isn't the poster or assigned: claim it, or apply for it. */
function VisitorActions({ v }: { v: WorkView }) {
  const { work, now } = useSession();
  const state = work.state!;
  if (v.status !== WorkStatus.OPEN) {
    return <Panel className="px-5 py-4 text-muted">{v.status === WorkStatus.PAID ? "Someone delivered it and was paid." : v.status === WorkStatus.REFUNDED ? "The poster took the reward back." : "Someone is working on it."}</Panel>;
  }
  if (v.terms.firstToClaim) {
    const e = workActionError("claim", state, v, now);
    return (
      <Section title="Claim it">
        <p className="m-0 text-muted">
          Claiming gives you {span(v.terms.deliveryWindow)} to deliver, and nobody else can take it meanwhile. The poster can release
          your claim before you submit, so check in with them if the description asks you to.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Act v={v} a="claim" label="Claim it" call={() => claim(work.contract!, v, now)} />
          {e && <span className="text-sm text-muted">{e}</span>}
        </div>
      </Section>
    );
  }
  return <ApplyForm v={v} />;
}

function ApplyForm({ v }: { v: WorkView }) {
  const { work } = useSession();
  const [plan, setPlan] = useState("");
  const [name, setName] = useState("");
  const [links, setLinks] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const ps = work.ps;
  const tooLong = [...plan].length > PLAN_MAX;

  const make = async () => {
    setFailed(null);
    if (!ps || !work.address || !work.state) return;
    try {
      const pseudonym = contributorPseudonym(work.address, v.id, ps.sk);
      const posterPk = work.state.works.lookup(v.id).posterPk;
      setCode(await makeApplication(v, posterPk, { pseudonym, plan, name, links: links.split(/[\n,]/) }));
    } catch (err: unknown) {
      setFailed(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section title="Apply">
      <p className="m-0 text-muted">
        The poster picks who works on it. Write your plan here: the page turns it into a code only the poster can read, which you send
        them however the description says. If they pick you, it shows up here as yours to deliver.
      </p>
      {code ? (
        <Panel tone="navy" className="flex flex-col gap-3 px-5 py-4">
          <span className="text-[13px] text-private">Your application code. Anyone can see it, but only the poster can read it.</span>
          <code className="font-mono text-[12px] break-all text-fg-2">{code}</code>
          <div className="flex items-center gap-3">
            <CopyButton text={code} label="Copy application code" />
            <Button variant="quiet" onClick={() => setCode(null)}>
              Edit the application
            </Button>
          </div>
        </Panel>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (plan.trim() && !tooLong) void make();
          }}
        >
          <Field id="plan" label="Your plan" aside={`${[...plan].length}/${PLAN_MAX}`}>
            <Textarea id="plan" rows={4} value={plan} onChange={(e) => setPlan(e.target.value)} placeholder="How you'd do it, and roughly when." />
          </Field>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
            <Field id="name" label="Name (optional)">
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="How the poster should know you" />
            </Field>
            <Field id="links" label="Links (optional)">
              <Input id="links" value={links} onChange={(e) => setLinks(e.target.value)} placeholder="GitHub, Discord, portfolio; comma-separated" />
            </Field>
          </div>
          <span className="text-[13px] text-muted">Only the poster sees your name and links, and only if you include them. Nothing about your application goes on chain.</span>
          <div>
            <Button type="submit" size="lg" disabled={!plan.trim() || tooLong || !ps}>
              Make my application code
            </Button>
          </div>
          {failed && <p className="m-0 text-sm text-bad">{failed}</p>}
        </form>
      )}
    </Section>
  );
}

function ContributorActions({ v }: { v: WorkView }) {
  const { work, now, colorHex } = useSession();
  const [link, setLink] = useState("");
  const bytes = new TextEncoder().encode(link.trim()).length;

  if (v.status === WorkStatus.ASSIGNED) {
    return (
      <Section title="Deliver">
        <p className="m-0 text-muted">
          It's yours: <Countdown deadline={v.until} before="deliver within" after="the delivery window ended" />. Submit a link to the work. It's encrypted
          so only the poster can read it, and their review window starts when it lands.
        </p>
        <Field id="link" label="Link to the work" aside={`${bytes}/124 bytes`}>
          <Input id="link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://github.com/…/pull/42" />
        </Field>
        <div>
          <Act v={v} a="submit" label="Submit" call={() => submitWork(work.contract!, work.providers!, work.address!, v, link, now)} />
        </div>
        {bytes > 124 && <p className="m-0 text-sm text-warn">That's too long: a link has to fit in 124 bytes.</p>}
      </Section>
    );
  }
  if (v.status === WorkStatus.SUBMITTED || v.status === WorkStatus.APPROVED) {
    const ready = workActionError("collect", work.state!, v, now) === null;
    return (
      <Section title={ready ? "Collect your reward" : "Waiting for the review"}>
        <p className="m-0 text-muted">
          {v.status === WorkStatus.APPROVED
            ? "The poster approved it."
            : ready
              ? "The review window passed without a review, so the reward is yours."
              : <>The poster has until the review window ends, <Countdown deadline={v.until} before="in" after="" />, to approve or reject it. If they do nothing, you're paid anyway.</>}{" "}
          Collect by {dateTime(v.until + work.state!.collectWindow)}. The payout goes to your shielded balance, and nothing links it to you.
        </p>
        <div>
          <Act v={v} a="collect" label={`Collect ${v.reward !== null ? `${amount(v.reward)} TEST` : ""}`} call={() => collect(work.contract!, v, colorHex!)} />
        </div>
      </Section>
    );
  }
  if (v.status === WorkStatus.REJECTED) {
    return (
      <Section title="The poster rejected it">
        <p className="m-0 text-muted">
          The arbiter can overturn the rejection until <Countdown deadline={v.until} before="the appeal ends, in" after="the appeal ended" />. If they do, you can
          collect the reward.
        </p>
      </Section>
    );
  }
  return <Panel tone="ok" className="px-5 py-4 text-fg-2">{v.status === WorkStatus.PAID ? "You were paid for this work." : "This work is closed."}</Panel>;
}

function PosterActions({ v }: { v: WorkView }) {
  const { work, now } = useSession();
  const state = work.state!;
  const contract = work.contract!;
  const canRefund = workActionError("refund", state, v, now) === null;

  return (
    <>
      {v.status === WorkStatus.OPEN && !v.terms.firstToClaim && workActionError("assign", state, v, now) === null && <Applications v={v} />}
      {v.status === WorkStatus.OPEN && v.terms.firstToClaim && !canRefund && (
        <Section title="Waiting for someone to claim it">
          <p className="m-0 text-muted">The first person to claim it gets {span(v.terms.deliveryWindow)} to deliver.</p>
          <ShareLink v={v} />
        </Section>
      )}
      {v.status === WorkStatus.ASSIGNED && (
        <Section title="Someone is working on it">
          <p className="m-0 text-muted">
            Assigned to <span className="font-mono text-fg-2">{short(toHex(state.works.lookup(v.id).contributor), 6, 4)}</span>, a pseudonym for this bounty
            only. <Countdown deadline={v.until} before="They have" after="Their window ended" />
            {v.terms.firstToClaim && ". You can release the claim before they submit, if it's going nowhere."}
          </p>
          {v.terms.firstToClaim && (
            <div>
              <Act v={v} a="release" variant="ghost" label="Release the claim" call={() => release(contract, v)} />
            </div>
          )}
        </Section>
      )}
      {v.status === WorkStatus.SUBMITTED && <Review v={v} />}
      {(v.status === WorkStatus.APPROVED || (v.status === WorkStatus.SUBMITTED && now >= v.until)) && !canRefund && (
        <Section title="Waiting for the contributor to collect">
          <p className="m-0 text-muted">
            If they never collect, you can take the reward back after {dateTime(v.until + state.collectWindow)}.
          </p>
        </Section>
      )}
      {v.status === WorkStatus.REJECTED && (
        <Section title="You rejected it">
          <p className="m-0 text-muted">
            The arbiter can overturn it until <Countdown deadline={v.until} before="the appeal ends, in" after="the appeal ended" />. After that anyone can reopen it.
          </p>
        </Section>
      )}
      {canRefund && (
        <Section title="The reward can come back to you">
          <p className="m-0 text-muted">
            {v.status === WorkStatus.SUBMITTED || v.status === WorkStatus.APPROVED
              ? "The contributor didn't collect in time."
              : "The deadline passed and nobody earned it."}{" "}
            It returns to your shielded balance.
          </p>
          <div>
            <Act v={v} a="refund" label={`Take back ${v.reward !== null ? `${amount(v.reward)} TEST` : "the reward"}`} call={() => refundWork(contract, v)} />
          </div>
        </Section>
      )}
      {v.status === WorkStatus.PAID && <Panel tone="ok" className="px-5 py-4 text-fg-2">Delivered and paid.</Panel>}
    </>
  );
}

function ShareLink({ v }: { v: WorkView }) {
  const { work } = useSession();
  const link = `${window.location.origin}${window.location.pathname}${href({ name: "work", address: work.address!, id: v.idHex })}`;
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted">Link to share</span>
      <CopyButton text={link} label="Copy link to share" />
    </div>
  );
}

/** The poster pastes application codes, reads them here, and assigns one. */
function Applications({ v }: { v: WorkView }) {
  const { work, now } = useSession();
  const [code, setCode] = useState("");
  const [app, setApp] = useState<Application | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const open = async () => {
    setFailed(null);
    setApp(null);
    if (!work.ps?.posterSeed) {
      setFailed("This browser's store has no key for this contract. Was it posted from another browser or wallet account?");
      return;
    }
    try {
      setApp(await openApplication(work.state!, work.address!, v, work.ps.posterSeed, code));
    } catch (err: unknown) {
      setFailed(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section title="Applications">
      <p className="m-0 text-muted">
        Applicants send you a code. Paste one to read it: it opens only with this browser's key for this bounty. Assigning gives them{" "}
        {span(v.terms.deliveryWindow)} to deliver.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Application code" className="flex-[1_1_320px] font-mono text-[12px]" placeholder="pbapp1.…" value={code} onChange={(e) => setCode(e.target.value)} />
        <Button size="lg" variant="ghost" disabled={!code.trim()} onClick={() => void open()}>
          Read it
        </Button>
      </div>
      {failed && <p className="m-0 text-sm text-bad">{failed}</p>}
      {app && (
        <Panel tone="navy" className="flex flex-col gap-3 px-5 py-4">
          <span className="text-[13px] text-private">Decrypted in this browser. Only you can read it.</span>
          <span className="font-semibold">{cleanTitle(app.name) || "No name given"}</span>
          {app.links.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
              {app.links.map((l, i) => (
                <li key={i}>
                  <SafeLink text={l} />
                </li>
              ))}
            </ul>
          )}
          <p className="m-0 whitespace-pre-wrap text-fg-2">{cleanDetails(app.plan)}</p>
          <span className="text-[13px] text-faint">The name and links are what they wrote; nothing here checks them.</span>
          <div>
            <Act v={v} a="assign" label="Assign them" call={() => assign(work.contract!, v, app.pseudonym, now)} />
          </div>
        </Panel>
      )}
      <ShareLink v={v} />
    </Section>
  );
}

function Review({ v }: { v: WorkView }) {
  const { work, now } = useSession();
  const [link, setLink] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const inWindow = now < v.until;

  const read = async () => {
    setFailed(null);
    if (!work.ps?.posterSeed) {
      setFailed("This browser's store has no key for this contract.");
      return;
    }
    try {
      setLink(await readSubmission(work.state!, work.address!, v.id, work.ps.posterSeed));
    } catch (err: unknown) {
      setFailed(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Section title={inWindow ? "Review the submission" : "The review window has passed"}>
      <p className="m-0 text-muted">
        {inWindow ? (
          <>
            <Countdown deadline={v.until} before="You have" after="" /> to approve or reject it. If you do nothing, the contributor is paid anyway.
          </>
        ) : (
          "You didn't review it in time, so the contributor can collect."
        )}
      </p>
      {link === null ? (
        <div>
          <Button variant="ghost" size="lg" onClick={() => void read()}>
            Decrypt the link
          </Button>
        </div>
      ) : (
        <Panel tone="navy" className="flex flex-col gap-2 px-5 py-4">
          <span className="text-[13px] text-private">Decrypted in this browser. Only you can read it.</span>
          <SafeLink text={link} />
        </Panel>
      )}
      {failed && <p className="m-0 text-sm text-bad">{failed}</p>}
      {inWindow && (
        <div className="flex flex-wrap gap-3">
          <Act v={v} a="approve" label="Approve" call={() => approve(work.contract!, v)} />
          <Act v={v} a="reject" variant="ghost" label={v.terms.hasArbiter ? "Reject (the arbiter can overturn it)" : "Reject and reopen it"} call={() => reject(work.contract!, v, now)} />
        </div>
      )}
    </Section>
  );
}

/** Text from someone else: a link only when it's plainly http(s), and never sent our page as referrer. */
function SafeLink({ text }: { text: string }) {
  const clean = cleanTitle(text);
  let url: URL | null = null;
  try {
    url = new URL(clean);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return <span className="font-mono text-sm break-all">{clean}</span>;
  return (
    <a href={url.toString()} target="_blank" rel="noreferrer noopener" className="font-mono text-sm break-all text-link">
      {clean}
    </a>
  );
}
