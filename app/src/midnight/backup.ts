// A backup of this wallet account's keys for one board: the private state of
// each of the board's contracts, exported by midnight-js and encrypted under
// the passphrase, plus the board code and token address so a new browser knows
// what to join. Losing the private state loses the keys that read answers and
// claim refunds, and nobody can recover them, so this file is the only copy.
import type { PrivateStateExport, PrivateStateProvider, SigningKeyExport } from "@midnight-ntwrk/midnight-js-types";
import { PRIVATE_STATE_ID } from "@/midnight/contract";

export const BACKUP_KIND = "private-bounties/backup";

export interface BoardAddresses {
  verified: string;
  work: string | null;
  factor: string | null;
  signed: string | null;
}

export interface Backup {
  kind: typeof BACKUP_KIND;
  version: 1;
  network: string;
  createdAt: string;
  board: BoardAddresses;
  token: string | null;
  /** Each contract's private state, by address. */
  states: Record<string, PrivateStateExport>;
  /** The keys of contracts this account deployed (maintenance authority), if any. */
  signingKeys: SigningKeyExport | null;
}

const ADDRESS = /^[0-9a-f]{64}$/;

/** The board's contract addresses, in board-code order, leaving out the empty places. */
export function boardAddresses(board: BoardAddresses): string[] {
  return [board.verified, board.work, board.factor, board.signed].filter((a): a is string => a !== null);
}

/**
 * Exports every contract of the board this account has private state for,
 * encrypted with the store's passphrase. Give it a provider of its own:
 * midnight-js scopes a provider by the last address set on it.
 */
export async function makeBackup(provider: PrivateStateProvider, network: string, board: BoardAddresses, token: string | null): Promise<Backup> {
  const states: Record<string, PrivateStateExport> = {};
  for (const address of boardAddresses(board)) {
    provider.setContractAddress(address);
    if ((await provider.get(PRIVATE_STATE_ID)) === null) continue;
    states[address] = await provider.exportPrivateStates();
  }
  if (Object.keys(states).length === 0) throw new Error("There are no keys to back up yet. Join a board first.");
  let signingKeys: SigningKeyExport | null = null;
  try {
    signingKeys = await provider.exportSigningKeys();
  } catch {
    // None: this account hasn't deployed a contract.
  }
  return { kind: BACKUP_KIND, version: 1, network, createdAt: new Date().toISOString(), board, token, states, signingKeys };
}

export function backupFileName(b: Backup): string {
  return `private-bounties-${b.network}-${b.board.verified.slice(0, 8)}-${b.createdAt.slice(0, 10)}.json`;
}

/** Reads a backup file, checking its shape but not its contents (those need the passphrase). */
export function parseBackup(text: string): Backup {
  const bad = new Error("That isn't a Private Bounties backup file");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw bad;
  }
  const b = v as Partial<Backup> | null;
  if (!b || b.kind !== BACKUP_KIND || b.version !== 1 || typeof b.network !== "string" || !b.board || !b.states) throw bad;
  const { verified, work, factor, signed } = b.board;
  const opt = (a: unknown) => a === null || (typeof a === "string" && ADDRESS.test(a));
  if (typeof verified !== "string" || !ADDRESS.test(verified) || ![work, factor, signed].every(opt) || !opt(b.token ?? null)) throw bad;
  const known = new Set(boardAddresses(b.board as BoardAddresses));
  for (const [address, e] of Object.entries(b.states)) {
    if (!known.has(address) || e?.format !== "midnight-private-state-export" || typeof e.encryptedPayload !== "string" || typeof e.salt !== "string") throw bad;
  }
  if (b.signingKeys && b.signingKeys.format !== "midnight-signing-key-export") throw bad;
  return { ...(b as Backup), token: b.token ?? null, signingKeys: b.signingKeys ?? null };
}

/** The contracts in the backup this browser already holds keys for: restoring replaces those. */
export async function backupConflicts(provider: PrivateStateProvider, backup: Backup): Promise<string[]> {
  const out: string[] = [];
  for (const address of Object.keys(backup.states)) {
    provider.setContractAddress(address);
    if ((await provider.get(PRIVATE_STATE_ID)) !== null) out.push(address);
  }
  return out;
}

/**
 * Writes the backup's keys into this browser's store. `passphrase` is the one
 * the backup was made under. A wrong passphrase fails on the first contract,
 * before anything is written.
 */
export async function restoreBackup(provider: PrivateStateProvider, backup: Backup, passphrase: string): Promise<number> {
  let restored = 0;
  for (const [address, e] of Object.entries(backup.states)) {
    provider.setContractAddress(address);
    const r = await provider.importPrivateStates(e, { password: passphrase, conflictStrategy: "overwrite" });
    restored += r.imported + r.overwritten;
  }
  if (backup.signingKeys) await provider.importSigningKeys(backup.signingKeys, { password: passphrase, conflictStrategy: "skip" });
  return restored;
}

export function restoreError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "ExportDecryptionError") return "That passphrase doesn't open this backup. Use the one you had when you made it.";
  if (name === "InvalidExportFormatError") return "This backup was made by a version of the app this one can't read.";
  return err instanceof Error ? err.message : String(err);
}
