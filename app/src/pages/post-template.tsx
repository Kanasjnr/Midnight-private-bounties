// Posting a factor or signed-record bounty. Like the preimage form: details,
// then a review of exactly what goes on chain, then one signed transaction.
import { useState } from "react";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { DETAILS_MAX, parseAmount, postTime, TITLE_MAX } from "@/midnight/private-bounties-api";
import { amount, span } from "~/lib/format";
import { cleanTitle } from "~/lib/sanitize";
import {
  pointFromText,
  postTemplate,
  RECORD_TYPES,
  schemaTag,
  templatePostError,
  TEMPLATES,
  type Template,
  type TemplatePost,
} from "~/midnight/verified-api";
import { go, href } from "~/router";
import { useSession } from "~/session";
import { Amount, Button, cx, Field, Input, LinkButton, Panel, Textarea, Visibility } from "~/components/ui";

const PRESETS = [
  ["1 hour", 3_600n],
  ["24 hours", 86_400n],
  ["7 days", 604_800n],
] as const;

export function TemplatePostForm({ t }: { t: Template }) {
  const { templates, now, colorHex, rewardBalance, run, deployment } = useSession();
  const slot = templates[t];
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [reward, setReward] = useState("100");
  const [preset, setPreset] = useState<bigint>(86_400n);
  // factor
  const [n, setN] = useState("");
  // signed record
  const [issuer, setIssuer] = useState("");
  const [type, setType] = useState(RECORD_TYPES[0]!.name);
  const [field, setField] = useState(1);
  const [threshold, setThreshold] = useState("");

  if (!slot.state) return null;
  const state = slot.state;
  const parsedReward = parseAmount(reward);
  const issuerPk = pointFromText(issuer);
  const fields = RECORD_TYPES.find((r) => r.name === type)?.fields ?? ["Field 1", "Field 2", "Field 3"];
  let schema: bigint | null = null;
  let typeError: string | null = null;
  try {
    schema = schemaTag(type);
  } catch (e: unknown) {
    typeError = e instanceof Error ? e.message : String(e);
  }
  const input: TemplatePost = {
    title,
    details,
    reward: parsedReward ?? 0n,
    deadline: now + preset,
    colorHex: colorHex ?? "",
    postedAt: postTime(Number(now) * 1000),
    n: /^\d+$/.test(n.trim()) ? BigInt(n.trim()) : undefined,
    rule:
      issuerPk && schema !== null && /^\d+$/.test(threshold.trim())
        ? { issuerPk, schema, field, threshold: BigInt(threshold.trim()) }
        : undefined,
  };
  const short = parsedReward !== null && rewardBalance !== null && rewardBalance < parsedReward;
  const error =
    parsedReward === null
      ? "Enter the reward as a whole number"
      : t === "signed" && issuer.trim() && !issuerPk
        ? "An issuer key looks like two hex numbers joined by a colon"
        : (typeError ?? templatePostError(t, state, input, now) ?? (short ? "Your wallet doesn't hold enough TEST" : null));
  const shownTitle = cleanTitle(title) || "Untitled bounty";

  const post = async () => {
    if (!slot.contract || !slot.providers || !slot.address || error) return;
    const address = slot.address;
    const out = await run("Posting bounty", shownTitle, () => postTemplate(t, slot.contract!, slot.providers!, address, input), {
      href: (r) => href({ name: "bounty", address, id: toHex(r.id) }),
    });
    if (out) go({ name: "bounty", address, id: toHex(out.id) });
  };

  const checks =
    t === "factor"
      ? `Two factors of ${input.n !== undefined ? input.n.toString() : "N"}`
      : `A ${type} signed by that issuer, with ${fields[field - 1]} at least ${threshold.trim() || "the threshold"}`;

  return (
    <div className="flex flex-wrap-reverse items-start gap-12">
      <aside aria-label="Summary" className="flex max-w-[380px] min-w-0 flex-[1_1_300px] flex-col gap-6">
        <Panel className="flex flex-col gap-3 p-5">
          <span className="text-[13px] font-semibold text-muted">You are posting</span>
          <span className="text-lg leading-snug font-semibold break-words">{shownTitle}</span>
          <Amount value={parsedReward !== null ? amount(parsedReward) : "–"} className="text-3xl" />
          <span className="text-sm text-muted">Paid to whoever proves: {checks}.</span>
        </Panel>
        <Visibility
          pub={t === "factor" ? "Title, question, reward, deadline, and N" : "Title, question, reward, deadline, the issuer's key, the record type, field and threshold"}
          privLabel="Stays private"
          priv={t === "factor" ? "The factors (only you can read them), and who found them" : "The record itself (only you can read it), and whose record it is"}
        />
      </aside>
      <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
        {step === "edit" ? (
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (!error) setStep("review");
            }}
          >
            <Field id="title" label="Title" aside={`${[...title.trim()].length}/${TITLE_MAX}`}>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A short name for the board" />
            </Field>
            <Field id="details" label="Question" aside={`${[...details.trim()].length}/${DETAILS_MAX}`}>
              <Textarea
                id="details"
                rows={3}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={t === "factor" ? "Where N comes from, and any context." : "Which record you want, and from whom."}
              />
            </Field>
            {t === "factor" ? (
              <Field
                id="n"
                label="N, the number to factor"
                hint={<span className="text-[13px] text-muted">From 4 to just under 2^128. Solvers can't tell whether you know the factors, so say in the question where N comes from.</span>}
              >
                <Input id="n" inputMode="numeric" className="font-mono" value={n} onChange={(e) => setN(e.target.value)} placeholder="4611685975477714963" />
              </Field>
            ) : (
              <>
                <Field id="issuer" label="Issuer's public key" hint={<span className="text-[13px] text-muted">From the issuer. Only records they signed can be submitted.</span>}>
                  <Input id="issuer" className="font-mono text-[13px]" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="x:y in hex" />
                </Field>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
                  <Field id="type" label="Record type">
                    <Input id="type" list="record-types" value={type} onChange={(e) => setType(e.target.value)} />
                    <datalist id="record-types">
                      {RECORD_TYPES.map((r) => (
                        <option key={r.name} value={r.name} />
                      ))}
                    </datalist>
                  </Field>
                  <Field id="field" label="Field to check">
                    <select id="field" value={field} onChange={(e) => setField(Number(e.target.value))} className="h-11 rounded-lg border border-line bg-surface px-3 text-fg">
                      {fields.map((f, i) => (
                        <option key={f} value={i + 1}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field id="threshold" label="Must be at least">
                    <Input id="threshold" inputMode="numeric" className="font-mono" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="3000" />
                  </Field>
                </div>
                <span className="-mt-3 text-[13px] text-muted">You'll receive the whole record, encrypted to you.</span>
              </>
            )}
            <Field id="reward" label="Reward" hint={<span className="text-[13px] text-muted">{rewardBalance !== null ? `You hold ${amount(rewardBalance)} TEST. ` : ""}At least {amount(state.minReward)}.</span>}>
              <div className="flex h-11 items-center rounded-lg border border-line bg-surface pr-3.5 transition-colors focus-within:border-focus hover:border-line-hover">
                <input id="reward" inputMode="numeric" value={reward} onChange={(e) => setReward(e.target.value)} className="h-full min-w-0 flex-1 border-0 bg-transparent px-3.5 font-mono text-fg outline-none" />
                <span className="text-sm text-muted">TEST</span>
              </div>
            </Field>
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend className="mb-2 text-sm font-semibold">Deadline</legend>
              <div role="group" className="flex overflow-hidden rounded-lg border border-line">
                {PRESETS.map(([label, secs], i) => (
                  <button key={label} type="button" aria-pressed={preset === secs} onClick={() => setPreset(secs)} className={cx("h-11 flex-1 text-sm font-semibold transition-colors", i > 0 && "border-l border-line", preset === secs ? "bg-fg text-page" : "bg-surface text-fg-2 hover:bg-raised")}>
                    {label}
                  </button>
                ))}
              </div>
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
          <section className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <h1 className="m-0 text-3xl font-semibold tracking-tight">Review</h1>
              <p className="m-0 text-muted">This goes on chain exactly as shown, and can't be edited or removed later.</p>
            </div>
            <dl className="m-0 grid grid-cols-[160px_minmax(0,1fr)] rounded-lg border border-line bg-surface text-sm">
              {(
                [
                  ["Template", TEMPLATES[t].name],
                  ["Title", shownTitle],
                  ["Question", details.trim()],
                  ["The proof checks", checks],
                  ["Reward", `${parsedReward !== null ? amount(parsedReward) : "–"} TEST`],
                  ["Deadline", `In ${span(preset)}`],
                ] as const
              ).map(([k, v], i) => (
                <div key={k} className="contents">
                  <dt className={cx("px-5 py-3 text-muted", i > 0 && "border-t border-line-soft")}>{k}</dt>
                  <dd className={cx("m-0 px-5 py-3 break-words whitespace-pre-wrap", i > 0 && "border-t border-line-soft")}>{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap justify-end gap-3 border-t border-line pt-5">
              <Button variant="ghost" size="lg" onClick={() => setStep("edit")} disabled={deployment.busy !== null}>
                Edit
              </Button>
              <Button size="lg" disabled={error !== null || deployment.busy !== null || !slot.contract} busy={deployment.busy === "Posting bounty"} onClick={() => void post()}>
                Sign and post
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
