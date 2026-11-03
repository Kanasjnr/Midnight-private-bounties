// @vitest-environment node
//
// The key backup against midnight-js's real level store (classic-level on
// disk here, IndexedDB in the browser): what goes in the file, the file's
// checks, and restoring into a different browser's store under a different
// passphrase.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import type { PrivateStateProvider } from "@midnight-ntwrk/midnight-js-types";
import { PRIVATE_STATE_ID } from "@/midnight/contract";
import { newPrivateState } from "@/midnight/private-bounties-api";
import { backupConflicts, makeBackup, parseBackup, restoreBackup, restoreError, type BoardAddresses } from "~/midnight/backup";

const dir = mkdtempSync(join(tmpdir(), "pb-backup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PASS_A = "Tq7#mPz!vL2@wNx4";
const PASS_B = "Hb5$kRw&yD8%cJf3";

function browserStore(name: string, passphrase: string): PrivateStateProvider {
  return levelPrivateStateProvider({
    midnightDbName: join(dir, name),
    accountId: "a".repeat(64),
    privateStoragePasswordProvider: () => passphrase,
    cryptoBackend: "webcrypto",
  });
}

const board: BoardAddresses = { verified: "11".repeat(32), work: "22".repeat(32), factor: null, signed: "33".repeat(32) };

describe("key backup", { timeout: 240_000 }, () => {
  it("backs up each contract with keys, and restores them into another browser", async () => {
    const a = browserStore("a", PASS_A);
    const verified = newPrivateState();
    const work = newPrivateState();
    a.setContractAddress(board.verified);
    await a.set(PRIVATE_STATE_ID, verified);
    a.setContractAddress(board.work!);
    await a.set(PRIVATE_STATE_ID, work);
    // The signed-record contract is on the board but this browser never joined it.

    const backup = await makeBackup(a, "preview", board, "44".repeat(32));
    expect(Object.keys(backup.states).sort()).toEqual([board.verified, board.work].sort());
    expect(JSON.stringify(backup)).not.toContain(Buffer.from(verified.sk).toString("hex"));

    const file = parseBackup(JSON.stringify(backup));
    const b = browserStore("b", PASS_B);
    expect(await backupConflicts(b, file)).toEqual([]);

    // A wrong passphrase writes nothing.
    const wrong = await restoreBackup(b, file, PASS_B).catch((e: unknown) => e);
    expect(restoreError(wrong)).toContain("doesn't open this backup");
    b.setContractAddress(board.verified);
    expect(await b.get(PRIVATE_STATE_ID)).toBeNull();

    expect(await restoreBackup(b, file, PASS_A)).toEqual(2);
    b.setContractAddress(board.verified);
    expect(await b.get(PRIVATE_STATE_ID)).toEqual(verified);
    b.setContractAddress(board.work!);
    expect(await b.get(PRIVATE_STATE_ID)).toEqual(work);
    expect((await backupConflicts(b, file)).sort()).toEqual([board.verified, board.work].sort());
  });

  it("refuses an empty backup and files that aren't backups", async () => {
    await expect(makeBackup(browserStore("empty", PASS_A), "preview", board, null)).rejects.toThrow("no keys to back up");
    expect(() => parseBackup("not json")).toThrow("isn't a Private Bounties backup");
    expect(() => parseBackup(JSON.stringify({ kind: "private-bounties/signed-record" }))).toThrow("isn't a Private Bounties backup");
    // A state for a contract that isn't on the backup's board.
    const stray = { kind: "private-bounties/backup", version: 1, network: "preview", createdAt: "", board, token: null, signingKeys: null, states: { ["55".repeat(32)]: { format: "midnight-private-state-export", encryptedPayload: "x", salt: "y" } } };
    expect(() => parseBackup(JSON.stringify(stray))).toThrow("isn't a Private Bounties backup");
  });
});
