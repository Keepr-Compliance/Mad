/**
 * BACKLOG-4115 PR-3 (SR B3, B6): the Android (Google Messages) state the
 * title-bar sync pill reads, outside the Sync Android flow.
 *
 * Runs ONLY while `enabled` (source android-messages-web AND the pill is
 * visible): polls the extension state + bridge status every `pollMs`, reads
 * the current job once, and follows job updates. Everything goes through
 * rcsImportService (never window.api). Jobs are mapped by the same
 * orchestratorStepFor the dashboard indicator uses — a second subscription
 * rather than reading the orchestrator queue, because the queue drops a
 * finished entry and the pill needs the job's own last state.
 *
 * Disabled or unmounted: the interval is cleared and the subscription removed.
 */
import { useCallback, useEffect, useState } from "react";
import { rcsImportService } from "../services/rcsImportService";
import { orchestratorStepFor, type GoogleMessagesOrchestratorStep } from "./googleMessagesSyncStatus";
import { browserLinkView, useLinkCheckOver, type BrowserLinkView } from "../components/settings/android/browserLinkState";
import type { RcsExtensionState, RcsImportStatus, RcsJobInfo } from "../../electron/types/ipc/window-api-rcs-import";

/** 15 s: the pill is a glance, not the flow (the flow polls every 3 s while open). */
export const ANDROID_PILL_POLL_MS = 15_000;

export interface AndroidSyncState {
  ext: RcsExtensionState | null;
  status: RcsImportStatus | null;
  jobStep: GoogleMessagesOrchestratorStep | null;
  linkView: BrowserLinkView;
}

export function useAndroidSyncState(enabled: boolean, pollMs: number = ANDROID_PILL_POLL_MS): AndroidSyncState {
  const [ext, setExt] = useState<RcsExtensionState | null>(null);
  const [status, setStatus] = useState<RcsImportStatus | null>(null);
  const [job, setJob] = useState<RcsJobInfo | null>(null);
  const linkCheckOver = useLinkCheckOver();

  const refresh = useCallback(async () => {
    const [e, s] = await Promise.all([rcsImportService.getExtensionState(), rcsImportService.getStatus()]);
    if (e.success && e.data) setExt(e.data);
    if (s.success && s.data) setStatus(s.data);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    void rcsImportService.getJob().then((r) => {
      if (live && r.success && r.data && r.data.kind === "cache") setJob(r.data);
    });
    const unsubscribe = rcsImportService.onJobProgress((next) => {
      if (!live || next.kind !== "cache") return;
      setJob(next);
      // A Sync that ended changes lastCacheFinishedAt: read it now, not at the next tick.
      if (next.state !== "created" && next.state !== "running") void refresh();
    });
    return () => {
      live = false;
      clearInterval(t);
      unsubscribe();
    };
  }, [enabled, pollMs, refresh]);

  if (!enabled) return { ext: null, status: null, jobStep: null, linkView: "notLinked" };
  return { ext, status, jobStep: job ? orchestratorStepFor(job) : null, linkView: browserLinkView(ext, linkCheckOver) };
}
