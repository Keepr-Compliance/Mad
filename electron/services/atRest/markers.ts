/**
 * At-rest state markers (BACKLOG-3816 S0).
 *
 * Two kinds, both small JSON files written atomically (temp → fsync → rename):
 *
 *   - Per-backup marker: `userData/Backups/.keepr-at-rest/<udid>.json`. It lives
 *     OUTSIDE the `<udid>` directory, so deleting or re-creating a backup never
 *     deletes the record of what state it was in. States: plaintext | migrating |
 *     encrypted | syncing | apple-encrypted (the phone's owner encrypts its backups;
 *     Apple already encrypts every file, so Keepr never seals it — S4-C, SR ruling
 *     on #2884. Not ciphertext evidence: no Keepr key is involved).
 *   - Per-scope state: `userData/at-rest-state.json`, one entry per migration scope
 *     (attachments, email-attachments, logs, ...). States: pending | migrating | done.
 *
 * "encrypted" / "done" are only to be written after a full header scan finds zero
 * plaintext files (the migration runner, S3/S4, owns that scan). A marker records a
 * result; it never stands in for checking.
 *
 * Markers carry no customer content: a state word, timestamps and counts.
 */
import fs from "fs";
import path from "path";

import { hostAppPaths } from "../../capabilities/appPathsProvider";
import { writeFileAtomic } from "./fileCrypto";

export type BackupAtRestState = "plaintext" | "migrating" | "encrypted" | "syncing" | "apple-encrypted";
export type ScopeAtRestState = "pending" | "migrating" | "done";

export interface BackupMarker {
  udid: string;
  state: BackupAtRestState;
  updatedAt: string;
}

export interface ScopeEntry {
  state: ScopeAtRestState;
  updatedAt: string;
  /** Free-form counters a migration job wants to keep across restarts. */
  progress?: Record<string, number>;
}

export interface AtRestStateFile {
  version: 1;
  scopes: Record<string, ScopeEntry>;
}

export const MARKER_DIR_NAME = ".keepr-at-rest";
export const STATE_FILE_NAME = "at-rest-state.json";

const BACKUP_STATES: ReadonlySet<string> = new Set(["plaintext", "migrating", "encrypted", "syncing", "apple-encrypted"]);
const SCOPE_STATES: ReadonlySet<string> = new Set(["pending", "migrating", "done"]);

/** A udid is a device identifier: hex and dashes only. Anything else could escape the marker dir. */
const UDID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function assertUdid(udid: string): void {
  if (!UDID_PATTERN.test(udid)) {
    throw new Error("invalid device id for an at-rest marker");
  }
}

export interface MarkerStoreDeps {
  userData: () => string;
  now?: () => Date;
}

export interface MarkerStore {
  backupMarkerPath(udid: string): string;
  stateFilePath(): string;
  /** null = no marker yet. A marker that exists but cannot be parsed throws — never read it as "plaintext". */
  readBackupMarker(udid: string): Promise<BackupMarker | null>;
  writeBackupMarker(udid: string, state: BackupAtRestState): Promise<BackupMarker>;
  readState(): Promise<AtRestStateFile>;
  getScope(scope: string): Promise<ScopeEntry | null>;
  setScope(scope: string, state: ScopeAtRestState, progress?: Record<string, number>): Promise<void>;
}

export function createMarkerStore(deps: MarkerStoreDeps): MarkerStore {
  const now = deps.now ?? (() => new Date());
  const backupMarkerPath = (udid: string) => {
    assertUdid(udid);
    return path.join(deps.userData(), "Backups", MARKER_DIR_NAME, `${udid}.json`);
  };
  const stateFilePath = () => path.join(deps.userData(), STATE_FILE_NAME);

  async function readJson(file: string): Promise<unknown | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
    return JSON.parse(raw) as unknown;
  }

  // Serialise read-modify-write of the shared state file within this process.
  let stateChain: Promise<unknown> = Promise.resolve();

  const store: MarkerStore = {
    backupMarkerPath,
    stateFilePath,

    async readBackupMarker(udid) {
      const parsed = (await readJson(backupMarkerPath(udid))) as BackupMarker | null;
      if (parsed === null) return null;
      if (!parsed || parsed.udid !== udid || !BACKUP_STATES.has(parsed.state)) {
        throw new Error("at-rest backup marker is malformed");
      }
      return parsed;
    },

    async writeBackupMarker(udid, state) {
      if (!BACKUP_STATES.has(state)) throw new Error(`unknown backup state ${state}`);
      const marker: BackupMarker = { udid, state, updatedAt: now().toISOString() };
      await writeFileAtomic(backupMarkerPath(udid), JSON.stringify(marker, null, 2));
      return marker;
    },

    async readState() {
      const parsed = (await readJson(stateFilePath())) as AtRestStateFile | null;
      if (parsed === null) return { version: 1, scopes: {} };
      if (!parsed || parsed.version !== 1 || typeof parsed.scopes !== "object" || parsed.scopes === null) {
        throw new Error("at-rest state file is malformed");
      }
      return parsed;
    },

    async getScope(scope) {
      return (await store.readState()).scopes[scope] ?? null;
    },

    setScope(scope, state, progress) {
      if (!SCOPE_STATES.has(state)) return Promise.reject(new Error(`unknown scope state ${state}`));
      const next = stateChain.then(async () => {
        const current = await store.readState();
        current.scopes[scope] = {
          state,
          updatedAt: now().toISOString(),
          ...(progress ? { progress } : {}),
        };
        await writeFileAtomic(stateFilePath(), JSON.stringify(current, null, 2));
      });
      stateChain = next.catch(() => undefined);
      return next;
    },
  };
  return store;
}

let markerStore: MarkerStore | null = null;

export function getMarkerStore(): MarkerStore {
  if (!markerStore) markerStore = createMarkerStore({ userData: () => hostAppPaths.userData() });
  return markerStore;
}
