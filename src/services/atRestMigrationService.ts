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
};
