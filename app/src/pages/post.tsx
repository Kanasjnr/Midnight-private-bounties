// Post a verified-answer bounty (the preimage template): details, then a
// review of exactly what goes on chain, then one signed transaction that
// escrows the reward.
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useWallet } from "@/hooks/use-wallet";
import { pureCircuits } from "@/midnight/contract";
import { useMidnightProviders } from "@/providers/midnight-providers";
import {
  DETAILS_MAX,
  encodeAnswer,
  listingError,
  parseAmount,
  postError,
  postNewBounty,
  postTime,
  TITLE_MAX,
} from "@/midnight/private-bounties-api";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { amount, span } from "~/lib/format";
import { cleanTitle } from "~/lib/sanitize";
import { go, href } from "~/router";
import { useSession } from "~/session";
import { Loading } from "~/pages/board";
import { TemplatePostForm } from "~/pages/post-template";
import { Amount, Button, cx, Dot, Field, Input, LinkButton, Panel, Textarea, Visibility } from "~/components/ui";

const PRESETS = [
  { label: "1 hour", seconds: 3_600n },
  { label: "24 hours", seconds: 86_400n },
  { label: "7 days", seconds: 604_800n },
] as const;

/** How hard the answer is to find by hashing guesses: 0 (empty) to 3. */
export function answerStrength(answer: string): 0 | 1 | 2 | 3 {
  const a = answer.trim();
  const len = [...a].length;
  if (len === 0) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(a)).length;
  if (len < 12) return 1;
  return len < 20 || classes < 3 ? 2 : 3;
}

const STRENGTH = [
  { tone: "muted", text: "Only its hash is published, so anyone can test guesses against it" },
  { tone: "warn", text: "Easy to find by hashing guesses. Make it longer" },
  { tone: "muted", text: "Findable with effort. Make it longer, or add numbers and symbols" },
  { tone: "ok", text: "Hard to find by guessing" },
] as const;

export function PostPage() {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const { deployment, state } = useSession();
  if (status !== "connected" || locked || !deployment.address) {
    return (
      <div className="flex flex-col items-start gap-4 py-16">
        <p className="m-0 text-lg text-muted">Posting needs a wallet, an unlocked store and a board.</p>
        <LinkButton href={href({ name: "setup" })}>Get set up</LinkButton>
      </div>
    );
  }
  if (!state) return <Loading what="Reading the board from the indexer" error={deployment.error} />;
  return <TemplateChoice />;
}

const CHOICES = [
  ["preimage", "Preimage", "Solvers find a word or phrase; only its hash is public"],
  ["factor", "Factor", "Solvers find two factors of a number you publish"],
  ["signed", "Signed record", "Solvers hold a record an issuer signed, meeting a threshold"],
] as const;

/** Which checker: the preimage form below, or a factor or signed-record one. */
function TemplateChoice() {
  const { templates } = useSession();
  const [pick, setPick] = useState<(typeof CHOICES)[number][0]>("preimage");
  const t = pick === "preimage" ? null : pick;
  const slot = t === null ? null : templates[t];
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <h1 className="m-0 text-3xl font-semibold tracking-tight">A question with a checked answer</h1>
        <div role="group" aria-label="Template" className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {CHOICES.map(([k, label, about]) => (
            <button
              key={k}
              type="button"
              aria-pressed={pick === k}
              onClick={() => setPick(k)}
              className={cx("flex flex-col gap-1 rounded-lg border px-4 py-3 text-left transition-colors", pick === k ? "border-fg bg-raised" : "border-line bg-surface hover:border-line-hover")}
            >
              <span className="font-semibold">{label}</span>
              <span className="text-[13px] text-muted">{about}</span>
            </button>
          ))}
        </div>
      </header>
      {slot === null || t === null ? (
        <PostForm />
      ) : !slot.address ? (
        <p className="m-0 text-muted">
          This board has no {t === "factor" ? "factor" : "signed-record"} contract yet. <a href={href({ name: "setup" })} className="text-link">Add one in setup</a>.
        </p>
      ) : !slot.state ? (
        <Loading what="Reading the contract from the indexer" error={slot.joinError} />
      ) : (
        <TemplatePostForm key={t} t={t} />
      )}
    </div>
  );
}

function PostForm() {
  const { state, deployment, views, now, colorHex, rewardBalance, canMint, run } = useSession();
  const { proving } = useMidnightProviders();
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [answer, setAnswer] = useState("");
  const [show, setShow] = useState(false);
  const [reward, setReward] = useState("100");
  const [preset, setPreset] = useState<string>("24 hours");
  const [customHours, setCustomHours] = useState("48");
  if (!state) return null;
  const { contract, providers, address, busy } = deployment;

  const window_ = preset === "Custom" ? (parseAmount(customHours) ?? 0n) * 3_600n : (PRESETS.find((p) => p.label === preset)?.seconds ?? 0n);
  const postedAt = postTime(Number(now) * 1000);
  const deadline = now + window_;
  const parsedReward = parseAmount(reward);

  let answerError: string | null = null;
  let answerTaken = false;
  if (answer.trim()) {
    try {
      const hash = pureCircuits.answerHash(encodeAnswer(answer));
      answerTaken = views.some((b) => b.target === hash);
    } catch (err: unknown) {
      answerError = err instanceof Error ? err.message : String(err);
    }
  }
  const strength = answerStrength(answer);
  const textError = listingError(title, details);
  const termsError = parsedReward === null ? "Enter a whole number" : postError(state, parsedReward, deadline, postedAt);
  const short = parsedReward !== null && rewardBalance !== null && rewardBalance < parsedReward;
  const ready = !textError && answer.trim() !== "" && !answerError && !answerTaken && !termsError && !short && window_ > 0n;
  const blocker = textError ?? (answer.trim() === "" ? "Enter the answer" : (answerError ?? (answerTaken ? "Another bounty on this board has the same answer" : termsError ? termsText(termsError, state.minReward, state.minWindow) : short ? "Your wallet doesn't hold enough TEST" : null)));

  const post = async () => {
    if (!contract || !providers || !address || !colorHex || parsedReward === null) return;
    const out = await run(
      "Posting bounty",
      cleanTitle(title),
      () => postNewBounty(contract, providers, address, { title, details, answer, reward: parsedReward, deadline, postedAt, colorHex }),
      { href: (r) => href({ name: "bounty", address, id: toHex(r.id) }) },
    );
    if (out) {
      setAnswer("");
      go({ name: "bounty", address, id: toHex(out.id) });
    }
  };

  const shownTitle = cleanTitle(title) || "Untitled bounty";
  return (
    <div className="flex flex-wrap-reverse items-start gap-12">
      <aside aria-label="Summary" className="flex max-w-[380px] min-w-0 flex-[1_1_300px] flex-col gap-6">
        <Panel className="flex flex-col gap-3 p-5">
          <span className="text-[13px] font-semibold text-muted">You are posting</span>
          <span className="text-lg leading-snug font-semibold break-words">{shownTitle}</span>
          <Amount value={parsedReward !== null ? amount(parsedReward) : "–"} className="text-3xl" />
          <span className="text-sm text-muted">
            Held by the contract until someone solves it, or comes back to you after the deadline{window_ > 0n ? `, in ${span(window_)}` : ""}.
          </span>
        </Panel>
        <Visibility
          pub="Title, question, reward, deadline, and a hash of the answer"
          privLabel="Stays with you"
          priv="The answer, your wallet, and the key that decrypts what solvers send"
        />
      </aside>

      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
        <div className="flex items-center justify-between gap-4 text-sm text-muted">
          <span>Step {step === "edit" ? 1 : 2} of 2 · {step === "edit" ? "Details" : "Review"}</span>
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
              if (ready) setStep("review");
            }}
          >
            <Field id="title" label="Title" aside={`${[...title.trim()].length}/${TITLE_MAX}`}>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short name for the board" />
            </Field>
            <Field id="details" label="Question" aside={`${[...details.trim()].length}/${DETAILS_MAX}`}>
              <Textarea id="details" rows={4} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="What should solvers answer? Say exactly what format you expect." />
            </Field>
            <Field
              id="answer"
              label="Answer"
              aside={`${new TextEncoder().encode(answer.trim()).length}/124 bytes`}
              hint={
                <span role="status" className={cx("inline-flex items-center gap-2 text-[13px]", answerError || answerTaken ? "text-bad" : STRENGTH[strength].tone === "ok" ? "text-ok" : STRENGTH[strength].tone === "warn" ? "text-warn" : "text-muted")}>
                  <Dot tone={answerError || answerTaken ? "bad" : STRENGTH[strength].tone} />
                  {answerError ?? (answerTaken ? "Another bounty on this board already has this answer" : STRENGTH[strength].text)}
                </span>
              }
            >
              <div className="relative">
                <Input id="answer" type={show ? "text" : "password"} autoComplete="off" spellCheck={false} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Never leaves this browser" className="pr-11" />
                <button type="button" aria-label={show ? "Hide the answer" : "Show the answer"} onClick={() => setShow(!show)} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1.5 text-muted hover:text-fg">
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            <Field
              id="reward"
              label="Reward"
              hint={
                <span className="text-[13px] text-muted">
                  {rewardBalance !== null ? `You hold ${amount(rewardBalance)} TEST. ` : ""}The wallet takes the reward from these when you sign. At least {amount(state.minReward)}.
                  {short && canMint && (
                    <>
                      {" "}
                      <a href={href({ name: "setup" })} className="text-link">Mint more</a>
                    </>
                  )}
                </span>
              }
            >
              <div className="flex h-11 items-center rounded-lg border border-line bg-surface pr-3.5 transition-colors focus-within:border-focus hover:border-line-hover">
                <input id="reward" inputMode="numeric" value={reward} onChange={(e) => setReward(e.target.value)} className="h-full min-w-0 flex-1 border-0 bg-transparent px-3.5 font-mono text-fg outline-none" />
                <span className="text-sm text-muted">TEST</span>
              </div>
            </Field>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-sm font-semibold">Deadline</legend>
              <div role="group" className="flex overflow-hidden rounded-lg border border-line">
                {[...PRESETS.map((p) => p.label), "Custom"].map((label, i) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={preset === label}
                    onClick={() => setPreset(label)}
                    className={cx("h-11 flex-1 text-sm font-semibold transition-colors", i > 0 && "border-l border-line", preset === label ? "bg-fg text-page" : "bg-surface text-fg-2 hover:bg-raised")}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {preset === "Custom" && (
                <label className="flex items-center gap-2 text-sm text-muted">
                  <Input aria-label="Hours until the deadline" inputMode="numeric" className="h-9 w-24 font-mono" value={customHours} onChange={(e) => setCustomHours(e.target.value)} />
                  hours from now
                </label>
              )}
              <span className="text-[13px] text-muted">
                This board needs at least {span(state.minWindow)}. After the deadline nobody can solve it, and you can take the reward back.
              </span>
            </fieldset>
            <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-5">
              {blocker && (title || details || answer) && <span className="mr-auto text-sm text-warn">{blocker}</span>}
              <LinkButton href={href({ name: "post" })} variant="ghost" size="lg">
                Back
              </LinkButton>
              <Button type="submit" size="lg" disabled={!ready}>
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
              <p className="m-0 text-muted">This goes on chain exactly as shown, and can't be edited or removed later.</p>
            </div>
            <dl className="m-0 grid grid-cols-[140px_minmax(0,1fr)] rounded-lg border border-line bg-surface text-sm">
              {(
                [
                  ["Title", shownTitle],
                  ["Question", details.trim()],
                  ["Reward", `${parsedReward !== null ? amount(parsedReward) : "–"} TEST`],
                  ["Deadline", `In ${span(window_)}`],
                  ["Answer", "Only its hash is published"],
                ] as const
              ).map(([k, v], i) => (
                <div key={k} className="contents">
                  <dt className={cx("px-5 py-3 text-muted", i > 0 && "border-t border-line-soft")}>{k}</dt>
                  <dd className={cx("m-0 px-5 py-3 break-words whitespace-pre-wrap", i > 0 && "border-t border-line-soft")}>{v}</dd>
                </div>
              ))}
            </dl>
            <Panel tone="warn" className="px-5 py-4 text-sm text-fg-2">
              The title and question are public forever. Leave out anything that could identify you or link this bounty to others you
              post.
            </Panel>
            {proving.mode === "wallet" && (
              <p className="m-0 text-sm text-warn">Your wallet is set to make the proof, so it sees this bounty's key and your identity secret.</p>
            )}
            <div className="flex flex-wrap justify-end gap-3 border-t border-line pt-5">
              <Button variant="ghost" size="lg" onClick={() => setStep("edit")} disabled={busy !== null}>
                Edit
              </Button>
              <Button size="lg" disabled={!ready || busy !== null || !contract} busy={busy === "Posting bounty"} onClick={() => void post()}>
                Sign and post
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function termsText(err: string, minReward: bigint, minWindow: bigint): string {
  if (err === "Deadline is too soon") return `The deadline has to be at least ${span(minWindow)} away`;
  if (err === "Reward is below the minimum") return `The reward has to be at least ${amount(minReward)}`;
  return err;
}
