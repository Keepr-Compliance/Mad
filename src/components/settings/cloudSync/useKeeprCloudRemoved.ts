/**
 * Settings › Keepr Cloud › Removed — BACKLOG-4263 PR-6 (plan §7, §14).
 *
 * Two lists, both decided in main:
 * - `here`: deals this user deleted on this computer in the last 30 days (local archive; works offline);
 * - `online`: deals removed online with no archive here (online only): restorable "Online only" rows, and
 *   deals still here but marked Rejected.
 * Every action calls the existing main method; the lists are read again after it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import cloudSyncService from "@/services/cloudSyncService";
import type { CloudSyncRemovedDeal } from "../../../../electron/types/ipc/window-api-cloud-sync";
import type { CloudSyncRemovedOnlineDeal } from "../../../../electron/types/ipc/window-api-cloud-todos";
import { KEEPR_CLOUD_COPY as C } from "./keeprCloudCopy";

export interface KeeprCloudRemovedState {
  here: CloudSyncRemovedDeal[];
  online: CloudSyncRemovedOnlineDeal[];
  /** The online list could not be read (offline or a failed read). */
  onlineUnavailable: boolean;
  busyId: string | null;
  /** One line after an action, by row id. */
  message: { id: string; text: string } | null;
}

export interface UseKeeprCloudRemoved extends KeeprCloudRemovedState {
  refresh: () => Promise<void>;
  restore: (transactionId: string) => Promise<void>;
  deleteForGood: (transactionId: string) => Promise<void>;
  restoreOnline: (cloudId: string) => Promise<void>;
}

/** The line shown after a restore on this computer. */
export function restoreMessage(r: { success: boolean; error?: string; skippedLinks?: number; otherDealAtAddress?: boolean }): string {
  if (!r.success) return C.restoreRefused[r.error ?? ""] ?? C.actionFailed;
  if (r.skippedLinks && r.skippedLinks > 0) return C.restoredSkipped(r.skippedLinks);
  if (r.otherDealAtAddress) return C.restoredOtherDeal;
  return C.restored;
}

/** `enabled`: Keepr Cloud is on for this user here; `online`: the online list is read too. */
export function useKeeprCloudRemoved(enabled: boolean, online: boolean): UseKeeprCloudRemoved {
  const [state, setState] = useState<KeeprCloudRemovedState>({ here: [], online: [], onlineUnavailable: false, busyId: null, message: null });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled) {
      if (mounted.current) setState((s) => ({ ...s, here: [], online: [], onlineUnavailable: false }));
      return;
    }
    const here = await cloudSyncService.listRemovedDeals();
    const listed = online ? await cloudSyncService.listRemovedOnline() : null;
    if (!mounted.current) return;
    setState((s) => ({
      ...s,
      here,
      online: listed?.success ? listed.deals : [],
      onlineUnavailable: !listed || !listed.success,
    }));
  }, [enabled, online]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const run = useCallback(
    async (id: string, fn: () => Promise<string>) => {
      setState((s) => ({ ...s, busyId: id, message: null }));
      const text = await fn();
      await refresh();
      if (mounted.current) setState((s) => ({ ...s, busyId: null, message: { id, text } }));
    },
    [refresh],
  );

  return {
    ...state,
    refresh,
    restore: (transactionId) => run(transactionId, async () => restoreMessage(await cloudSyncService.restoreDeal(transactionId))),
    deleteForGood: (transactionId) =>
      run(transactionId, async () => {
        const r = await cloudSyncService.deleteDealForGood(transactionId);
        if (!r.success) return C.restoreRefused[r.error ?? ""] ?? C.actionFailed;
        return r.status === "pending" ? C.deletingOffline : r.status === "restored_elsewhere" ? C.restoredElsewhere : C.deletedForGood;
      }),
    restoreOnline: (cloudId) =>
      run(cloudId, async () => {
        const r = await cloudSyncService.restoreOnlineDeal(cloudId);
        return r.success ? C.restored : (C.restoreRefused[r.error ?? ""] ?? C.actionFailed);
      }),
  };
}
