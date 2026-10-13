/**
 * BACKLOG-3892 S6 — the renderer side of "Get older texts": read a deal's older iPhone
 * texts from the backup kept on this computer (S5, electron/services/iphoneBackfillService.ts).
 *
 * The only place the renderer calls window.api.sync.backfill*. Every method resolves
 * (never throws); a bridge without the S5 methods reads as "not available".
 */
import type {
  BackfillAvailability,
  BackfillProgress,
  BackfillResult,
} from "../../electron/types/iphoneBackfill";

function bridge() {
  return typeof window !== "undefined" ? window.api?.sync : undefined;
}

const UNAVAILABLE: BackfillAvailability = { available: false, reason: "error" };

export const iphoneBackfillService = {
  /** Can this deal's older texts be read from the kept backup now? */
  async availability(transactionId: string): Promise<BackfillAvailability> {
    const api = bridge();
    if (!api?.backfillAvailability) return UNAVAILABLE;
    try {
      const r = await api.backfillAvailability(transactionId);
      return r && typeof r.available === "boolean" ? r : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  },

  /** Run the backfill for one deal. Resolves when it ends (stored, refused or cancelled). */
  async getOlderTexts(transactionId: string): Promise<BackfillResult> {
    const api = bridge();
    const failed: BackfillResult = { success: false, reason: "error", messagesStored: 0, coverageRecorded: false };
    if (!api?.backfillOlder) return failed;
    try {
      return (await api.backfillOlder(transactionId)) ?? failed;
    } catch {
      return failed;
    }
  },

  /**
   * Ask the running backfill to stop. Before the save commit point nothing is stored;
   * after it the texts are kept and this returns false. The run's own result decides.
   */
  async cancel(): Promise<boolean> {
    const api = bridge();
    if (!api?.cancelBackfill) return false;
    try {
      const r = await api.cancelBackfill();
      return r?.success === true;
    } catch {
      return false;
    }
  },

  /** Progress events for every backfill. Returns the unsubscribe function. */
  onProgress(callback: (progress: BackfillProgress) => void): () => void {
    const api = bridge();
    if (!api?.onBackfillProgress) return () => {};
    return api.onBackfillProgress(callback);
  },
};
