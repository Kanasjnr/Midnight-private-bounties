// A factor or signed-record bounty. The page around the answer is the same as
// the preimage one; what differs is the answer (two factors, or a signed
// record file) and what the poster reads back.
import { useState, type ReactNode } from "react";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { Status } from "@/midnight/private-bounties-api";
import { statusOf } from "~/lib/board";
import { ago, amount, dateTime, short, span } from "~/lib/format";
import { cleanDetails, cleanTitle, hadHiddenCharacters } from "~/lib/sanitize";
import {
  factorAnswer,
  fieldNames,
  pointText,
  readTemplateAnswer,
  recordFromFile,
  refundTemplate,
  schemaName,
  submitTemplate,
  templateRefundError,
  templateSubmitError,
  TEMPLATES,
  type SignedRecord,
  type TemplateView,
} from "~/midnight/verified-api";
import { href } from "~/router";
import { useSession, type TemplateSession } from "~/session";
import { Countdown } from "~/components/countdown";
import { Amount, Button, Chip, CopyButton, cx, Dot, Facts, Field, Input, Panel, StatusText, Visibility, Prose } from "~/components/ui";
import { WalletGate } from "~/components/wallet-gate";

export function TemplateBounty({ slot, v }: { slot: TemplateSession; v: TemplateView }) {
  const { now, hidden } = useSession();
  const title = cleanTitle(v.title) || "Untitled";
  const rule = v.rule;
  const names = rule ? fieldNames(rule.schema) : null;
  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-muted">
        <a href={href(v.mine ? { name: "mine" } : { name: "board" })} className="text-muted no-underline hover:text-fg">
          {v.mine ? "My bounties" : "Bounties"}
        </a>
        <span aria-hidden="true">/</span>
        <span className="truncate text-fg-2">{title}</span>
      </nav>
      <div className="flex flex-wrap items-start gap-12">
        <article className="flex min-w-0 flex-[999_1_560px] flex-col gap-8">
          <header className="flex flex-col gap-3">
            <div className="flex gap-2">
              <Chip>{TEMPLATES[v.template].name}</Chip>
              {v.mine && <Chip>Yours</Chip>}
            </div>
            <h1 className="m-0 text-[26px] leading-tight font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <Prose text={cleanDetails(v.details) || "No question was given."} />
            {(hadHiddenCharacters(v.title) || hadHiddenCharacters(v.details)) && (
              <p className="m-0 text-[13px] text-warn">This listing had hidden characters (text direction or zero-width marks), removed here.</p>
            )}
          </header>
          <Panel tone="navy" className="flex flex-col gap-2 px-5 py-4">
            <span className="text-[13px] font-medium text-muted">What the proof checks</span>
            {v.template === "factor" ? (
              <span>
                Two whole numbers above 1 whose product is <span className="font-mono break-all">N = {v.n?.toString()}</span>.
              </span>
            ) : (
              <span>
                A <strong>{schemaName(rule!.schema) ?? "record"}</strong> signed by issuer <span className="font-mono">{short(pointText(rule!.issuerPk), 8, 6)}</span>, with{" "}
                <strong>{names![rule!.field - 1]}</strong> at least <span className="font-mono">{amount(rule!.threshold)}</span>.
              </span>
            )}
          </Panel>
          {v.mine ? <PosterSide slot={slot} v={v} /> : <SolverSide slot={slot} v={v} />}
        </article>
        <aside aria-label="Bounty details" className="flex max-w-[360px] min-w-0 flex-[1_1_300px] flex-col gap-6">
          <Panel className="px-5 py-2">
            <Facts
              rows={[
                ["Status", <StatusText {...statusOf(v, now)} />],
                ["Reward", <Amount value={v.reward !== null ? amount(v.reward) : "–"} />],
                [
                  v.status === Status.OPEN ? (now < v.deadline ? "Ends" : "Ended") : "Deadline",
                  <span className="flex flex-col items-end">
                    <span>{v.status === Status.OPEN ? <Countdown deadline={v.deadline} bare /> : dateTime(v.deadline)}</span>
                    {v.status === Status.OPEN && <span className="text-[13px] text-faint">{dateTime(v.deadline)}</span>}
                  </span>,
                ],
                ...((v.postedAt !== null ? [["Posted", ago(v.postedAt, now)]] : []) as [ReactNode, ReactNode][]),
                ["Template", TEMPLATES[v.template].name],
                ["Poster", v.mine ? "You" : "Anonymous"],
                [
                  "Bounty ID",
                  <span className="inline-flex items-center gap-1 font-mono text-[13px] whitespace-nowrap">
                    {short(v.idHex, 6, 4)}
                    <CopyButton text={v.idHex} label="Copy bounty ID" />
                  </span>,
                ],
              ]}
            />
          </Panel>
          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-[15px] font-semibold">When it's solved</h2>
            <Visibility
              pub={v.template === "factor" ? "That it was solved and paid, and the factors as ciphertext" : "That it was solved and paid, and the record as ciphertext"}
              priv={v.template === "factor" ? "The factors (only the poster can decrypt them), who solved it, and where the reward lands" : "The whole record (only the poster can decrypt it), who submitted it, and where the reward lands"}
            />
          </section>
          {!v.mine && (
            <Button variant="quiet" className="self-start text-sm" onClick={() => (hidden.set.has(v.idHex) ? hidden.remove(v.idHex) : hidden.add(v.idHex))}>
              {hidden.set.has(v.idHex) ? "Show it on my board again" : "Hide this from my board"}
            </Button>
          )}
        </aside>
      </div>
    </div>
  );
}

function SolverSide({ slot, v }: { slot: TemplateSession; v: TemplateView }) {
  const { now, run, deployment, colorHex, solvedHere } = useSession();
  const { proving } = useMidnightProviders();
  const [p, setP] = useState("");
  const [q, setQ] = useState("");
  const [file, setFile] = useState<SignedRecord | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const title = cleanTitle(v.title) || "Untitled";

  if (solvedHere.set.has(v.idHex) && v.status === Status.SOLVED) {
    return <Panel tone="ok" className="px-5 py-4 text-fg-2">You solved it. {v.reward !== null ? `${amount(v.reward)} TEST` : "The reward"} went to your shielded balance.</Panel>;
  }
  if (v.status !== Status.OPEN || now >= v.deadline) {
    return <Panel className="px-5 py-4 text-muted">{v.status === Status.SOLVED ? "Someone already solved this one." : v.status === Status.REFUNDED ? "The poster took the reward back." : "The deadline has passed."}</Panel>;
  }

  let answer: bigint[] | null = null;
  let inputError: string | null = null;
  if (v.template === "factor") {
    if (p.trim() || q.trim()) {
      try {
        answer = factorAnswer(p, q);
      } catch (err: unknown) {
        inputError = err instanceof Error ? err.message : String(err);
      }
    }
  } else if (file) answer = file.record;
  const err = inputError ?? templateSubmitError(v, now, answer, file?.issuerPk);
  const empty = v.template === "factor" ? !p.trim() && !q.trim() : !file;

  const loadFile = async (f: File | undefined) => {
    setFileError(null);
    setFile(null);
    if (!f) return;
    try {
      setFile(recordFromFile(await f.text()));
    } catch (e: unknown) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  };

  const submit = async () => {
    if (!slot.contract || !slot.providers || !slot.address || !colorHex || !answer) return;
    const a = answer;
    const ok = await run("Submitting answer", title, () => submitTemplate(slot.contract!, slot.providers!, slot.address!, v, a, file?.signature, colorHex), {
      href: () => href({ name: "bounty", address: slot.address!, id: v.idHex }),
    });
    if (ok) solvedHere.add(v.idHex);
  };

  return (
    <WalletGate doing="solve it">
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-lg font-semibold">{v.template === "factor" ? "Your two factors" : "Your signed record"}</h2>
      {v.template === "factor" ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Field id="p" label="p">
            <Input id="p" inputMode="numeric" className="font-mono" value={p} onChange={(e) => setP(e.target.value)} />
          </Field>
          <Field id="q" label="q">
            <Input id="q" inputMode="numeric" className="font-mono" value={q} onChange={(e) => setQ(e.target.value)} />
          </Field>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-line-strong bg-surface px-5 py-6 text-center text-sm text-muted hover:border-line-hover">
            <span className="font-medium text-fg">Choose the record file your issuer gave you</span>
            <span>It's read in this browser only.</span>
            <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void loadFile(e.target.files?.[0])} />
          </label>
          {fileError && <p className="m-0 text-sm text-bad">{fileError}</p>}
          {file && <RecordFacts record={file.record} />}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span role="status" className={cx("inline-flex items-center gap-2 text-sm", err === null ? "text-ok" : empty ? "text-muted" : "text-warn")}>
          <Dot tone={err === null ? "ok" : empty ? "muted" : "warn"} />
          {err === null
            ? v.template === "factor"
              ? "p × q = N. Checked in your browser, nothing sent yet"
              : "Right type, issuer and threshold. The proof checks the signature"
            : empty
              ? "Checked in your browser as you go"
              : err}
        </span>
        <Button disabled={err !== null || deployment.busy !== null || !slot.contract} busy={deployment.busy === "Submitting answer"} onClick={() => void submit()}>
          Prove and submit
        </Button>
      </div>
      {proving.mode === "wallet" && <p className="m-0 text-sm text-warn">Your wallet is set to make the proof, so it sees your answer.</p>}
      <p className="m-0 text-sm text-faint">
        Only the poster will be able to read it. Everyone else sees ciphertext, and nothing links it to you. Ends in{" "}
        {span(v.deadline - now)}; a submit can take a few minutes to land.
      </p>
    </section>
    </WalletGate>
  );
}

function RecordFacts({ record }: { record: bigint[] }) {
  const names = fieldNames(record[0]!);
  return (
    <Panel className="px-5 py-2">
      <Facts
        rows={[
          ["Type", schemaName(record[0]!) ?? "Unknown"],
          [names[0], <span className="font-mono">{record[1]!.toString()}</span>],
          [names[1], <span className="font-mono">{record[2]!.toString()}</span>],
          [names[2], <span className="font-mono">{record[3]!.toString()}</span>],
        ]}
      />
    </Panel>
  );
}

function PosterSide({ slot, v }: { slot: TemplateSession; v: TemplateView }) {
  const { now, run, deployment, read } = useSession();
  const [answer, setAnswer] = useState<bigint[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const title = cleanTitle(v.title) || "Untitled";

  if (v.status === Status.SOLVED) {
    const decrypt = async () => {
      setFailed(null);
      if (!slot.ps?.posterSeed || !slot.state || !slot.address) {
        setFailed("This browser's store has no key for this contract. Was it posted from another browser or wallet account?");
        return;
      }
      try {
        setAnswer(await readTemplateAnswer(slot.state, slot.address, v, slot.ps.posterSeed));
        read.add(v.idHex);
      } catch (err: unknown) {
        setFailed(err instanceof Error ? err.message : String(err));
      }
    };
    return (
      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-lg font-semibold">{v.template === "factor" ? "The factors" : "The record"}</h2>
        {answer === null ? (
          <Panel className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
            <span className="text-sm text-muted">Someone solved it and was paid. What they sent is on chain, encrypted to you.</span>
            <Button onClick={() => void decrypt()}>Decrypt here</Button>
          </Panel>
        ) : v.template === "factor" ? (
          <Panel tone="navy" className="flex flex-col gap-2 px-5 py-4">
            <span className="text-[13px] text-private">Decrypted in this browser. Only you can read it.</span>
            <span className="font-mono text-lg break-all">
              {answer[0]!.toString()} × {answer[1]!.toString()}
            </span>
            <span className={cx("inline-flex items-center gap-2 text-sm", answer[0]! * answer[1]! === v.n ? "text-ok" : "text-warn")}>
              <Dot tone={answer[0]! * answer[1]! === v.n ? "ok" : "warn"} />
              {answer[0]! * answer[1]! === v.n ? "Their product is N" : "Their product isn't N"}
            </span>
          </Panel>
        ) : (
          <>
            <span className="text-[13px] text-private">Decrypted in this browser. Only you can read it.</span>
            <RecordFacts record={answer} />
          </>
        )}
        {failed && <p className="m-0 text-sm text-bad">{failed}</p>}
      </section>
    );
  }
  if (v.status === Status.REFUNDED) return <Panel className="px-5 py-4 text-muted">You took the reward back after the deadline.</Panel>;
  if (now < v.deadline) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-lg font-semibold">Waiting for answers</h2>
        <p className="m-0 text-muted">The reward is locked in the contract until someone solves it or the deadline passes, in {span(v.deadline - now)}.</p>
      </section>
    );
  }
  const refundErr = templateRefundError(v, now);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="m-0 text-lg font-semibold">Nobody solved it before the deadline</h2>
      <p className="m-0 text-muted">The reward is still held by the contract. Only you can take it back.</p>
      <div>
        <Button
          size="lg"
          disabled={refundErr !== null || deployment.busy !== null || !slot.contract}
          busy={deployment.busy === "Claiming refund"}
          onClick={() => void run("Claiming refund", title, () => refundTemplate(slot.contract!, v))}
        >
          Refund {v.reward !== null ? `${amount(v.reward)} TEST` : ""}
        </Button>
      </div>
    </section>
  );
}

