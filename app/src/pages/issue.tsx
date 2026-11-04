// For issuers of signed records: make a signing key, and sign records into
// files to hand to the people they describe. Signing runs in this browser
// (contract/signing.ts, the same Schnorr the signed-record template checks).
// The secret key is held in memory only: copy it to keep it.
import { useState } from "react";
import { parseAmount } from "@/midnight/private-bounties-api";
import { issueRecord, issuerPublicKey, newIssuerKey, pointText, recordToFile, RECORD_TYPES } from "~/midnight/verified-api";
import { Button, CopyButton, Field, Input, Panel } from "~/components/ui";

export function IssuePage() {
  const [sk, setSk] = useState<bigint | null>(null);
  const [pasted, setPasted] = useState("");
  const [type, setType] = useState(RECORD_TYPES[0]!.name);
  const [values, setValues] = useState(["", "", ""]);
  const [file, setFile] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const fields = RECORD_TYPES.find((r) => r.name === type)?.fields ?? ["Field 1", "Field 2", "Field 3"];
  const parsed = values.map((v) => (v.trim() === "0" ? 0n : parseAmount(v)));

  const issue = async () => {
    setFailed(null);
    if (sk === null || parsed.some((p) => p === null)) return;
    try {
      setFile(recordToFile(await issueRecord(sk, type, parsed as [bigint, bigint, bigint])));
    } catch (e: unknown) {
      setFailed(e instanceof Error ? e.message : String(e));
    }
  };

  const download = () => {
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type.replace(/\W+/g, "-").toLowerCase()}-record.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex max-w-[760px] flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="m-0 text-3xl font-semibold tracking-tight">Issue signed records</h1>
        <p className="m-0 text-muted">
          For banks, schools, communities: anyone whose word a poster trusts. You sign a record about someone; they can prove what it
          shows to win a signed-record bounty, and only the poster ever reads it.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-lg font-semibold">1. Your signing key</h2>
        {sk === null ? (
          <div className="flex flex-col gap-3">
            <div>
              <Button onClick={() => setSk(newIssuerKey().sk)}>Make a new key</Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-faint">or use yours:</span>
              <Input aria-label="Signing secret" type="password" className="h-9 flex-[1_1_260px] font-mono text-[13px]" placeholder="secret, in hex" value={pasted} onChange={(e) => setPasted(e.target.value)} />
              <Button variant="ghost" size="sm" disabled={!/^[0-9a-f]{1,64}$/i.test(pasted.trim())} onClick={() => setSk(BigInt(`0x${pasted.trim()}`))}>
                Use it
              </Button>
            </div>
          </div>
        ) : (
          <Panel className="flex flex-col gap-3 px-5 py-4 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-muted">Public key, for posters:</span>
              <span className="font-mono break-all text-fg-2">{pointText(issuerPublicKey(sk))}</span>
              <CopyButton text={pointText(issuerPublicKey(sk))} label="Copy the public key" />
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-muted">Secret key, for you only:</span>
              <CopyButton text={sk.toString(16)} label="Copy the secret key" />
              <span className="text-warn">This page doesn't store it. Copy it somewhere safe, or you'll need a new key next time.</span>
            </span>
          </Panel>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="m-0 text-lg font-semibold">2. A record</h2>
        <Field id="type" label="Record type">
          <Input id="type" list="record-types" value={type} onChange={(e) => setType(e.target.value)} />
          <datalist id="record-types">
            {RECORD_TYPES.map((r) => (
              <option key={r.name} value={r.name} />
            ))}
          </datalist>
        </Field>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-4">
          {fields.map((f, i) => (
            <Field key={f} id={`f${i}`} label={f}>
              <Input id={`f${i}`} inputMode="numeric" className="font-mono" value={values[i]} onChange={(e) => setValues(values.map((v, j) => (j === i ? e.target.value : v)))} placeholder="a whole number" />
            </Field>
          ))}
        </div>
        <span className="text-[13px] text-muted">Each field is a whole number below 2^64: an amount, a date as seconds, an ID.</span>
        <div>
          <Button size="lg" disabled={sk === null || parsed.some((p) => p === null)} onClick={() => void issue()}>
            Sign the record
          </Button>
        </div>
        {failed && <p className="m-0 text-sm text-bad">{failed}</p>}
      </section>

      {file && (
        <section className="flex flex-col gap-3">
          <h2 className="m-0 text-lg font-semibold">3. Give it to its holder</h2>
          <p className="m-0 text-muted">They choose this file when they solve a bounty. Treat it like the record itself: whoever has it can use it.</p>
          <div className="flex gap-3">
            <Button onClick={download}>Download the file</Button>
            <CopyButton text={file} label="Copy the file's contents" />
          </div>
        </section>
      )}
    </div>
  );
}
