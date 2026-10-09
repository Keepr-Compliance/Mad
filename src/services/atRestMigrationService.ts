/**
 * At-rest migration service — BACKLOG-3816 S3.
 *
 * The renderer's abstraction over `window.api.atRest`: read the background
 * encryption status and subscribe to its changes. Absent bridge (web build,
 * tests, an older preload) = nothing to show.
 */
import type { AtRestMigrationStatus } from "../../electron/types/ipc/window-api-at-rest";

export type { AtRestMigrationStatus };

function api() {
  return typeof window !== "undefined" ? window.api?.atRest : undefined;
}

/** One "cleanup" progress tick from `sync:progress` (BACKLOG-3816 S4-C emits these). */
export interface BackupSecuringProgress {
  message: string;
  percent: number;
}

/**
 * Narrow a raw `sync:progress` payload to a "cleanup" tick: the post-sync seal and the
 * launch migration of the kept iPhone backup. Anything else is null.
 */
export function toBackupSecuringProgress(raw: unknown): BackupSecuringProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as { phase?: unknown; message?: unknown; overallProgress?: unknown };
  if (p.phase !== "cleanup" || typeof p.message !== "string" || p.message.length === 0) return null;
  const n = typeof p.overallProgress === "number" && Number.isFinite(p.overallProgress) ? p.overallProgress : 0;
  return { message: p.message, percent: Math.max(0, Math.min(100, n)) };
}

export const atRestMigrationService = {
  /** null when the bridge is missing or the main process has not registered the channel yet. */
  async getStatus(): Promise<AtRestMigrationStatus | null> {
    const bridge = api();
    if (!bridge) return null;
    try {
      return await bridge.getMigrationStatus();
    } catch {
      return null;
    }
  },

  /** Returns an unsubscribe function (a no-op when the bridge is missing). */
  subscribe(callback: (status: AtRestMigrationStatus) => void): () => void {
    const bridge = api();
    if (!bridge) return () => undefined;
    return bridge.onMigrationStatus(callback);
  },

  /**
   * "cleanup" ticks on `sync:progress` (securing the kept iPhone backup). Returns an
   * unsubscribe function (a no-op when the bridge is missing).
   */
  subscribeBackupSecuring(callback: (progress: BackupSecuringProgress) => void): () => void {
    const sync = typeof window !== "undefined" ? window.api?.sync : undefined;
    if (typeof sync?.onProgress !== "function") return () => undefined;
    const unsubscribe = sync.onProgress((raw: unknown) => {
      const progress = toBackupSecuringProgress(raw);
      if (progress) callback(progress);
    });
    return typeof unsubscribe === "function" ? unsubscribe : () => undefined;
  },
};
