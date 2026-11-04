// Keys and backup: download this account's keys for the board as one file,
// or restore them in a new browser before (or after) joining.
import { useState } from "react";
import { useWallet } from "@/hooks/use-wallet";
import { errorMessage } from "@/lib/errors";
import { TOKEN_ZK_ASSETS_PATH } from "@/midnight/private-bounties-api";
import { useMidnightProviders } from "@/providers/midnight-providers";
import { dateTime, short } from "~/lib/format";
import {
  backupConflicts,
  backupFileName,
  boardAddresses,
  makeBackup,
  parseBackup,
  restoreBackup,
  restoreError,
  type Backup,
} from "~/midnight/backup";
import { href } from "~/router";
import { useSession } from "~/session";
import { networkName } from "~/components/top-bar";
import { Button, cx, Input, LinkButton, Panel } from "~/components/ui";

export function BackupPage() {
  const { status } = useWallet();
  const { locked } = useMidnightProviders();
  const ready = status === "connected" && !locked;
  return (
    <div className="flex max-w-[720px] flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="m-0 text-3xl font-semibold tracking-tight">Keys and backup</h1>
        <p className="m-0 text-muted">
          This browser holds the keys that read your answers, claim refunds and get you paid. They never leave it, and nobody can
          recover them for you, so keep a backup somewhere safe.
        </p>
      </header>
      {ready ? (
        <>
          <MakeBackup />
          <RestoreBackup />
        </>
      ) : (
        <Panel className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <span className="text-muted">Connect your wallet and unlock the private store first.</span>
          <LinkButton href={href({ name: "setup" })} variant="ghost">
            Go to setup
          </LinkButton>
        </Panel>
      )}
    </div>
  );
}

/** A dedicated store handle, since midnight-js scopes a handle by the last contract address set on it. */
async function store(providersFor: NonNullable<ReturnType<typeof useMidnightProviders>["providersFor"]>) {
  const p = await providersFor(TOKEN_ZK_ASSETS_PATH);
  return p.privateStateProvider;
}

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function MakeBackup() {
  const { networkId } = useWallet();
  const { providersFor } = useMidnightProviders();
  const { board, token, backup } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    if (!providersFor || !board || !networkId) return;
    setBusy(true);
    setError(null);
    try {
      const b = await makeBackup(await store(providersFor), networkId, board, token.address);
      saveFile(backupFileName(b), JSON.stringify(b, null, 2));
      backup.mark(Object.keys(b.states));
    } catch (err: unknown) {
      setError(errorMessage(err, "Couldn't make the backup"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="m-0 text-xl font-semibold">Back up</h2>
      {board ? (
        <>
          <Panel tone={backup.needed ? "warn" : "ok"} className="flex flex-col gap-1 px-5 py-4 text-sm">
            <span className="font-medium">{backup.needed ? "Not backed up" : "Backed up"}</span>
            <span className="text-muted">
              {backup.needed
                ? backup.at
                  ? "The board has a contract your last backup doesn't cover. Download a new one."
                  : "Nothing from this browser is backed up yet."
                : `Last backup ${backup.at ? dateTime(BigInt(Math.floor(Date.parse(backup.at) / 1000))) : ""}. It stays current until you add a contract to the board.`}
            </span>
          </Panel>
          <p className="m-0 text-sm text-muted">
            One file covers every contract on this board ({boardAddresses(board).length}). It's encrypted with your passphrase, so
            you'll need that passphrase to restore it.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" busy={busy} onClick={() => void download()}>
              Download backup
            </Button>
            {error && <span className="text-sm text-bad">{error}</span>}
          </div>
        </>
      ) : (
        <p className="m-0 text-sm text-muted">Join a board first. There's nothing to back up until then.</p>
      )}
    </section>
  );
}

function RestoreBackup() {
  const { networkId } = useWallet();
  const { providersFor } = useMidnightProviders();
  const { deployment, work, templates, token } = useSession();
  const [file, setFile] = useState<Backup | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const pick = async (f: File | undefined) => {
    setFile(null);
    setFileError(null);
    setConflicts(null);
    setDone(false);
    if (!f) return;
    try {
      const b = parseBackup(await f.text());
      if (b.network !== networkId) throw new Error(`That backup is for ${networkName(b.network)}, and your wallet is on ${networkName(networkId)}.`);
      setFile(b);
    } catch (err: unknown) {
      setFileError(errorMessage(err, "Couldn't read that file"));
    }
  };

  /** Points the board's slots at the backup's contracts and joins them again, which reads the restored keys. */
  const rejoin = (b: Backup) => {
    const slots = [
      [work, b.board.work],
      [templates.factor, b.board.factor],
      [templates.signed, b.board.signed],
    ] as const;
    for (const [slot, a] of slots) {
      if (a !== null && slot.address === a) slot.retry();
      else slot.setAddress(a);
    }
    if (b.token) token.remember(b.token);
    void deployment.join(b.board.verified);
  };

  const restore = async (replace: boolean) => {
    if (!providersFor || !file) return;
    setBusy(true);
    setError(null);
    try {
      const s = await store(providersFor);
      if (!replace) {
        const c = await backupConflicts(s, file);
        if (c.length > 0) {
          setConflicts(c);
          return;
        }
      }
      await restoreBackup(s, file, pass);
      setConflicts(null);
      setDone(true);
      rejoin(file);
    } catch (err: unknown) {
      setError(restoreError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 border-t border-line pt-8">
      <h2 className="m-0 text-xl font-semibold">Restore</h2>
      <p className="m-0 text-sm text-muted">
        On a new browser or machine: connect the same wallet, unlock with any passphrase, then load your backup here. The app
        joins the backup's board for you.
      </p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void restore(false);
        }}
      >
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">Backup file</span>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => void pick(e.target.files?.[0])}
            className="text-sm text-muted file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border file:border-line file:bg-surface file:px-3 file:text-sm file:font-medium file:text-fg hover:file:border-line-hover"
          />
          {fileError && <span className="text-bad">{fileError}</span>}
          {file && (
            <span className="text-muted">
              Made {dateTime(BigInt(Math.floor(Date.parse(file.createdAt) / 1000)))} for board {short(file.board.verified, 10, 8)}, with
              keys for {Object.keys(file.states).length} contract{Object.keys(file.states).length === 1 ? "" : "s"}.
            </span>
          )}
        </label>
        <label className="flex flex-col gap-2 text-sm">
          <span className="font-medium">The passphrase you had when you made it</span>
          <Input type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} className="max-w-[420px]" />
        </label>
        {conflicts ? (
          <Panel tone="warn" className="flex flex-col gap-3 px-5 py-4 text-sm">
            <span>
              This browser already holds keys for {conflicts.length} of these contracts. Restoring replaces them. If you only joined
              here and haven't posted, applied or solved from this browser, that's safe. Otherwise, download a backup of this
              browser first.
            </span>
            <div className="flex flex-wrap gap-3">
              <Button busy={busy} onClick={() => void restore(true)}>
                Replace them
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConflicts(null)}>
                Cancel
              </Button>
            </div>
          </Panel>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="lg" disabled={!file || !pass} busy={busy}>
              Restore
            </Button>
          </div>
        )}
        {error && <p className="m-0 text-sm text-bad">{error}</p>}
        {done && (
          <p role="status" className={cx("m-0 text-sm", deployment.error ? "text-bad" : "text-ok")}>
            {deployment.error ?? "Restored. Joining the board with your keys now."}
          </p>
        )}
      </form>
    </section>
  );
}
