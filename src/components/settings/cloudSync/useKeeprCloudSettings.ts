/**
 * State of Settings › Keepr Cloud — BACKLOG-4243 PR-1.
 *
 * Main decides everything (visibility, the switch, what is sent); this hook
 * asks through cloudSyncService and keeps the answer for the screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import cloudSyncService from "@/services/cloudSyncService";
import type { CloudSyncResult, CloudSyncView } from "../../../../electron/types/ipc/window-api-cloud-sync";

export interface KeeprCloudSettingsState {
  view: CloudSyncView | null;
  busy: boolean;
  /** A fixed message key, or null. */
  message: "turn_off_done" | "turn_off_offline" | "failed" | null;
}

export interface UseKeeprCloudSettings extends KeeprCloudSettingsState {
  refresh: () => Promise<void>;
  turnOn: (noticeVersion: number) => Promise<boolean>;
  confirmComputer: () => Promise<boolean>;
  turnOff: () => Promise<boolean>;
  forgetOtherProject: () => Promise<boolean>;
  retry: () => Promise<boolean>;
  openAiApps: () => Promise<boolean>;
}

export function useKeeprCloudSettings(): UseKeeprCloudSettings {
  const [state, setState] = useState<KeeprCloudSettingsState>({ view: null, busy: false, message: null });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const view = await cloudSyncService.getView();
    if (mounted.current) setState((s) => ({ ...s, view }));
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const act = useCallback(
    async (fn: () => Promise<CloudSyncResult>, onSuccess?: (r: CloudSyncResult) => KeeprCloudSettingsState["message"]) => {
      setState((s) => ({ ...s, busy: true, message: null }));
      const r = await fn();
      const message = r.success ? (onSuccess ? onSuccess(r) : null) : "failed";
      const view = await cloudSyncService.getView();
      if (mounted.current) setState({ view, busy: false, message });
      return r.success;
    },
    [],
  );

  return {
    ...state,
    refresh,
    turnOn: (v) => act(() => cloudSyncService.turnOn(v)),
    confirmComputer: () => act(() => cloudSyncService.confirmComputer()),
    turnOff: () => act(() => cloudSyncService.turnOff(), (r) => (r.pendingOnline ? "turn_off_offline" : "turn_off_done")),
    forgetOtherProject: () => act(() => cloudSyncService.forgetOtherProject()),
    retry: () => act(() => cloudSyncService.retry()),
    openAiApps: async () => (await cloudSyncService.openAiApps()).success,
  };
}
