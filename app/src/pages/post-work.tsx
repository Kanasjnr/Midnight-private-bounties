// Posting: first the kind, then, for reviewed work, its terms. The windows
// are what the contract enforces, so the form says what each one means for
// both sides before anything is signed.
import { useState } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { DETAILS_MAX, parseAmount, postTime, TITLE_MAX } from "@/midnight/private-bounties-api";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { amount, dateTime, span } from "~/lib/format";
import { cleanTitle } from "~/lib/sanitize";
import { postWork, termsError } from "~/midnight/work-api";
import { go, href } from "~/router";
import { useSession } from "~/session";
import { KindCard, Loading } from "~/pages/board";
import { Amount, Button, cx, Field, Input, LinkButton, Panel, Textarea, Visibility } from "~/components/ui";

const DAY = 86_400n;

export function PostStart() {
  const { work } = useSession();
  return (
    <div className="flex flex-col gap-8">
      <header className="flex max-w-[640px] flex-col gap-2">
        <h1 className="m-0 text-4xl font-semibold tracking-tight">Post a bounty</h1>
        <p className="m-0 text-muted">Pick by who decides the work is done: you, or a proof.</p>
      </header>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <KindCard to={{ name: "post-work" }} title="Reviewed work" foot="Building, writing, design, events, community work">
          You pick an applicant or let someone claim it. They deliver within a window, and you approve before they're paid. If you
          don't review in time, they're paid anyway.
        </KindCard>
        <KindCard to={{ name: "post-answer" }} title="Verified answer" foot="Puzzles, crypto challenges, verified data">
          A zero-knowledge proof checks the answer and pays the solver in the same transaction. Only you can read the answer.
        </KindCard>
      </div>
      {!work.address && (
        <p className="m-0 text-sm text-muted">
          This board has no reviewed-work contract yet. <a href={href({ name: "setup" })} className="text-link">Add one in setup</a>.
        </p>
      )}
    </div>
  );
}

export function PostWorkPage() {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { work, deployment } = useSession();
  if (status !== "connected" || locked || !deployment.address || !work.address) {
    return (
      <div className="flex flex-col items-start gap-4 py-16">
        <p className="m-0 text-lg text-muted">Posting reviewed work needs a wallet, an unlocked store, and a board with a reviewed-work contract.</p>
        <LinkButton href={href({ name: "setup" })}>Get set up</LinkButton>
      </div>
    );
  }
  if (!work.state) return <Loading what="Reading reviewed work from the indexer" error={work.joinError} />;
  return <PostWorkForm />;
}

function days(text: string): bigint | null {
  const n = parseAmount(text);
  return n === null ? null : n * DAY;
}

function PostWorkForm() {
  const { work, now, colorHex, rewardBalance, run, deployment } = useSession();
  const state = work.state!;
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [reward, setReward] = useState("300");
  const [firstToClaim, setFirstToClaim] = useState(false);
  const [deliver, setDeliver] = useState("14");
  const [review, setReview] = useState("7");
  const [deadline, setDeadline] = useState("30");
  const [arbiter, setArbiter] = useState("");
  const [appeal, setAppeal] = useState("7");

  const parsedReward = parseAmount(reward);
  const arbiterHex = arbiter.trim().toLowerCase();
  const arbiterOk = arbiterHex === "" || /^[0-9a-f]{64}$/.test(arbiterHex);
  const input = {
    title,
    details,
    reward: parsedReward ?? 0n,
    colorHex: colorHex ?? "",
    firstToClaim,
    deliveryWindow: days(deliver) ?? 0n,
    reviewWindow: days(review) ?? 0n,
    deadline: now + (days(deadline) ?? 0n),
    arbiter: arbiterHex && arbiterOk ? Uint8Array.from(arbiterHex.match(/../g)!, (h) => parseInt(h, 16)) : null,
    appealWindow: days(appeal) ?? 0n,
    postedAt: postTime(Number(now) * 1000),
  };
  const short = parsedReward !== null && rewardBalance !== null && rewardBalance < parsedReward;
  const error =
    parsedReward === null
      ? "Enter the reward as a whole number"
      : !arbiterOk
        ? "An arbiter ID is 64 hex characters"
        : (termsError(state, input, now) ?? (short ? "Your wallet doesn't hold enough TEST" : null));
  const claimsClose = input.deadline - input.deliveryWindow + 60n;
  const shownTitle = cleanTitle(title) || "Untitled work";
  const { contract, providers, address } = { contract: work.contract, providers: work.providers, address: work.address };

  const post = async () => {
    if (!contract || !providers || !address || error) return;
    const out = await run("Posting work", shownTitle, () => postWork(contract, providers, address, input), {
      href: (r) => href({ name: "work", address, id: toHex(r.id) }),
    });
    if (out) go({ name: "work", address, id: toHex(out.id) });
  };

  return (
    <div className="flex flex-wrap-reverse items-start gap-12">
      <aside aria-label="Summary" className="flex max-w-[380px] min-w-0 flex-[1_1_300px] flex-col gap-6">
        <Panel className="flex flex-col gap-3 p-5">
          <span className="text-[13px] font-semibold text-muted">You are posting</span>
          <span className="text-lg leading-snug font-semibold break-words">{shownTitle}</span>
          <Amount value={parsedReward !== null ? amount(parsedReward) : "–"} className="text-3xl" />
          <ul className="m-0 flex list-disc flex-col gap-1.5 pl-4.5 text-sm text-fg-2 marker:text-faint">
            <li>{firstToClaim ? "Anyone can claim it; you can release a claim before they submit" : "You read applications and pick who works on it"}</li>
            <li>They have {days(deliver) ? span(days(deliver)!) : "–"} to deliver</li>
            <li>You have {days(review) ? span(days(review)!) : "–"} to review, or they're paid anyway</li>
            <li>{input.arbiter ? `An arbiter can overturn a rejection within ${days(appeal) ? span(days(appeal)!) : "–"}` : "No arbiter: a rejection reopens the work"}</li>
          </ul>
        </Panel>
        <Visibility
          pub="Title, description, reward, the windows and deadline, the status, and a pseudonym for whoever is assigned"
          privLabel="Never public"
          priv="Who you are, who applied, who did the work, what they submitted, and where the reward goes"
        />
      </aside>

      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
        <div className="flex items-center justify-between gap-4 text-sm text-muted">
          <span>
            Step {step === "edit" ? 1 : 2} of 2 · {step === "edit" ? "Terms" : "Review"}
          </span>
          <span aria-hidden="true" className="flex w-24 gap-1">
            <span className="h-1 flex-1 rounded-full bg-fg" />
            <span className={cx("h-1 flex-1 rounded-full", step === "review" ? "bg-fg" : "bg-chip")} />
          </span>
        </div>

        {step === "edit" ? (
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (!error) setStep("review");
            }}
          >
            <h1 className="m-0 text-3xl font-semibold tracking-tight">Work someone delivers and you review</h1>
            <Field id="title" label="Title" aside={`${[...title.trim()].length}/${TITLE_MAX}`}>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Write a migration guide for the latest SDK" />
            </Field>
            <Field id="details" label="What the work is" aside={`${[...details.trim()].length}/${DETAILS_MAX}`}>
              <Textarea id="details" rows={5} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="What should be delivered, and how you'll judge it. The contributor submits a link." />
            </Field>
            <Field id="reward" label="Reward" hint={<span className="text-[13px] text-muted">{rewardBalance !== null ? `You hold ${amount(rewardBalance)} TEST. ` : ""}At least {amount(state.minReward)}. Locked in the contract until it's paid or comes back to you.</span>}>
              <div className="flex h-11 items-center rounded-lg border border-line bg-surface pr-3.5 transition-colors focus-within:border-focus hover:border-line-hover">
                <input id="reward" inputMode="numeric" value={reward} onChange={(e) => setReward(e.target.value)} className="h-full min-w-0 flex-1 border-0 bg-transparent px-3.5 font-mono text-fg outline-none" />
                <span className="text-sm text-muted">TEST</span>
              </div>
            </Field>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-sm font-semibold">Who works on it</legend>
              <div role="group" className="flex overflow-hidden rounded-lg border border-line">
                {([[false, "You pick an applicant"], [true, "First to claim"]] as const).map(([v, label], i) => (
                  <button key={label} type="button" aria-pressed={firstToClaim === v} onClick={() => setFirstToClaim(v)} className={cx("h-11 flex-1 text-sm font-semibold transition-colors", i > 0 && "border-l border-line", firstToClaim === v ? "bg-fg text-page" : "bg-surface text-fg-2 hover:bg-raised")}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="text-[13px] text-muted">
                {firstToClaim
                  ? "For small, well-defined tasks. Anyone can claim it at once; if a claim goes nowhere, you can release it before they submit."
                  : "Applicants send you an application code with their plan. You read it here and assign one of them."}
              </span>
            </fieldset>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4">
              <DaysField id="deliver" label="Time to deliver" value={deliver} onChange={setDeliver} />
              <DaysField id="review" label="Time to review" value={review} onChange={setReview} />
              <DaysField id="deadline" label="Final deadline" value={deadline} onChange={setDeadline} suffix="days from now" />
            </div>
            <span className="-mt-3 text-[13px] text-muted">
              Claims and assignments close on {dateTime(claimsClose)}, when a full delivery window no longer fits before the deadline.
              Work nobody delivered comes back to you after the deadline.
            </span>
            <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
              <legend className="mb-2 text-sm font-semibold">Arbiter (optional)</legend>
              <Input aria-label="Arbiter ID" className="font-mono text-[13px]" placeholder="Their arbiter ID, from their board card. Leave empty for none." value={arbiter} onChange={(e) => setArbiter(e.target.value)} />
              {arbiterHex && <DaysField id="appeal" label="Time to appeal" value={appeal} onChange={setAppeal} />}
              <span className="text-[13px] text-muted">An arbiter's only power is to overturn your rejection. Without one, a rejection reopens the work for someone else.</span>
            </fieldset>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
              {error && (title || details) && <span className="mr-auto text-sm text-warn">{error}</span>}
              <LinkButton href={href({ name: "post" })} variant="ghost" size="lg">
                Back
              </LinkButton>
              <Button type="submit" size="lg" disabled={error !== null}>
                Continue
              </Button>
            </div>
          </form>
        ) : (
          <section aria-labelledby="rv" className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <h1 id="rv" className="m-0 text-3xl font-semibold tracking-tight">
                Review
              </h1>
              <p className="m-0 text-muted">This goes on chain exactly as shown. The contract holds both of you to these terms.</p>
            </div>
            <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] rounded-lg border border-line bg-surface text-sm">
              {(
                [
                  ["Title", shownTitle],
                  ["What the work is", details.trim()],
                  ["Reward", `${parsedReward !== null ? amount(parsedReward) : "–"} TEST`],
                  ["Who works on it", firstToClaim ? "First to claim" : "You pick an applicant"],
                  ["Time to deliver", span(input.deliveryWindow)],
                  ["Time to review", span(input.reviewWindow)],
                  ["Final deadline", dateTime(input.deadline)],
                  ["Arbiter", input.arbiter ? `${arbiterHex.slice(0, 8)}…, ${span(input.appealWindow)} to appeal` : "None"],
                ] as const
              ).map(([k, v], i) => (
                <div key={k} className="contents">
                  <dt className={cx("px-5 py-3 text-muted", i > 0 && "border-t border-line-soft")}>{k}</dt>
                  <dd className={cx("m-0 px-5 py-3 break-words whitespace-pre-wrap", i > 0 && "border-t border-line-soft")}>{v}</dd>
                </div>
              ))}
            </dl>
            <Panel tone="warn" className="px-5 py-4 text-sm text-fg-2">
              The title and description are public forever. Once someone has submitted, you can't take the reward back until it's
              gone uncollected for {span(state.collectWindow)} after the review window.
            </Panel>
            <div className="flex flex-wrap justify-end gap-3 border-t border-line pt-5">
              <Button variant="ghost" size="lg" onClick={() => setStep("edit")} disabled={deployment.busy !== null}>
                Edit
              </Button>
              <Button size="lg" disabled={error !== null || deployment.busy !== null || !contract} busy={deployment.busy === "Posting work"} onClick={() => void post()}>
                Sign and post
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function DaysField({ id, label, value, onChange, suffix = "days" }: { id: string; label: string; value: string; onChange: (v: string) => void; suffix?: string }) {
  return (
    <Field id={id} label={label}>
      <div className="flex h-11 items-center rounded-lg border border-line bg-surface pr-3.5 transition-colors focus-within:border-focus hover:border-line-hover">
        <input id={id} inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} className="h-full w-full min-w-0 border-0 bg-transparent px-3.5 font-mono text-fg outline-none" />
        <span className="text-sm whitespace-nowrap text-muted">{suffix}</span>
      </div>
    </Field>
  );
}

