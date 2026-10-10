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

/**
 * `sealing` (BACKLOG-3816): a seal is running (or was cut off) on a chain that a sync or a
 * crash left part plain — after a sync, and the launch/idle recovery of a `syncing` chain.
 * Protects the chain like `syncing`; the next launch finishes it.
 */
export type BackupAtRestState = "plaintext" | "migrating" | "encrypted" | "syncing" | "sealing" | "apple-encrypted";
export type ScopeAtRestState = "pending" | "migrating" | "done";

export interface BackupMarker {
  udid: string;
  state: BackupAtRestState;
  updatedAt: string;
  /**
   * Set after a C-DELTA sync left damage: the next sync of this phone unseals everything
   * (C-FULL). Survives a restart; cleared by a clean full sync. `reasonCode` says why.
   */
  nextStrategy?: "full";
  reasonCode?: string;
  /**
   * Consecutive C-DELTA syncs whose backup tool failed (G3, founder decision 2026-10-09):
   * the second one in a row forces C-FULL. Reset by a sync whose tool succeeded.
   */
  toolFailures?: number;
  /**
   * The app version that last PROVED this chain fully sealed — a full verification walk
   * that found zero plaintext, or a clean delta seal on top of such a proof (founder
   * decision 2026-10-10, BACKLOG-3816). Written only together with `encrypted` and
   * dropped by every other state write, so a sync, a crash, a seal failure or an
   * update (a different version) makes the next sync walk the whole chain again.
   */
  verifiedBy?: string;
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

/**
 * Scope keys in at-rest-state.json: the single source of truth for the migration
 * writer (migration.ts) and every reader (the attachment readers, S2).
 */
export const SCOPE_MESSAGE_ATTACHMENTS = "message-attachments";
export const SCOPE_EMAIL_ATTACHMENTS = "email-attachments";

const BACKUP_STATES: ReadonlySet<string> = new Set(["plaintext", "migrating", "encrypted", "syncing", "sealing", "apple-encrypted"]);
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
  /**
   * Writes the state; keeps `nextStrategy`/`reasonCode`/`toolFailures` already recorded for
   * the phone. `verifiedBy` is never kept: it is written only when passed (with `encrypted`).
   */
  writeBackupMarker(udid: string, state: BackupAtRestState, opts?: { verifiedBy?: string }): Promise<BackupMarker>;
  /** Records (reasonCode) or clears (null) "the next sync is C-FULL" on an existing marker. No marker = no-op. */
  setNextStrategy(udid: string, reasonCode: string | null): Promise<void>;
  /** Sets the consecutive tool-failure count (0 removes it) on an existing marker. No marker = no-op. */
  setToolFailures(udid: string, count: number): Promise<void>;
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

    async writeBackupMarker(udid, state, opts) {
      if (!BACKUP_STATES.has(state)) throw new Error(`unknown backup state ${state}`);
      let kept: Pick<BackupMarker, "nextStrategy" | "reasonCode" | "toolFailures"> = {};
      try {
        const existing = await store.readBackupMarker(udid);
        if (existing?.nextStrategy === "full") {
          kept = { nextStrategy: "full", ...(existing.reasonCode ? { reasonCode: existing.reasonCode } : {}) };
        }
        if (typeof existing?.toolFailures === "number" && existing.toolFailures > 0) {
          kept = { ...kept, toolFailures: existing.toolFailures };
        }
      } catch {
        // an unreadable marker is being replaced; there is nothing to keep
      }
      const verified = state === "encrypted" && opts?.verifiedBy ? { verifiedBy: opts.verifiedBy } : {};
      const marker: BackupMarker = { udid, state, updatedAt: now().toISOString(), ...kept, ...verified };
      await writeFileAtomic(backupMarkerPath(udid), JSON.stringify(marker, null, 2));
      return marker;
    },

    async setNextStrategy(udid, reasonCode) {
      const existing = await store.readBackupMarker(udid);
      if (!existing) return;
      const { nextStrategy: _n, reasonCode: _r, ...rest } = existing;
      void _n;
      void _r;
      const marker: BackupMarker = {
        ...rest,
        updatedAt: now().toISOString(),
        ...(reasonCode ? { nextStrategy: "full" as const, reasonCode } : {}),
      };
      await writeFileAtomic(backupMarkerPath(udid), JSON.stringify(marker, null, 2));
    },

    async setToolFailures(udid, count) {
      const existing = await store.readBackupMarker(udid);
      if (!existing) return;
      const { toolFailures: _t, ...rest } = existing;
      void _t;
      const marker: BackupMarker = { ...rest, updatedAt: now().toISOString(), ...(count > 0 ? { toolFailures: count } : {}) };
      await writeFileAtomic(backupMarkerPath(udid), JSON.stringify(marker, null, 2));
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
