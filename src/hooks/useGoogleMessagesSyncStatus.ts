/**
 * BACKLOG-3658: feed a Google Messages cache Sync into the sync orchestrator
 * queue, so the dashboard's ONE indicator (SyncStatusIndicator) shows it —
 * progress, the paused state, the saved counts, a failure — whether or not
 * the Sync Android window is open. Mounted once (AppModals). A cancel removes
 * it silently, like iPhone Sync (BACKLOG-2330).
 */

import { useEffect, useRef } from "react";
import { rcsImportService } from "../services/rcsImportService";
import { syncOrchestrator } from "../services/SyncOrchestratorService";
import { GOOGLE_MESSAGES_SYNC_TYPE, orchestratorStepFor } from "./googleMessagesSyncStatus";
import type { RcsJobInfo } from "../../electron/types/ipc/window-api-rcs-import";

/** Applies one job update to the orchestrator; `ended` holds the job ids already completed. */
export function applyGoogleMessagesJob(job: RcsJobInfo, ended: Set<string>): void {
  const step = orchestratorStepFor(job);
  if (step.kind === "ignore" || ended.has(job.jobId)) return;
  const type = GOOGLE_MESSAGES_SYNC_TYPE;
  switch (step.kind) {
    case "progress":
      syncOrchestrator.registerExternalSync(type);
      syncOrchestrator.updateExternalSync(type, { progress: step.progress, phase: step.phase, indeterminate: step.indeterminate });
      return;
    case "saving":
      syncOrchestrator.registerExternalSync(type);
      syncOrchestrator.updateExternalSync(type, { phase: "saving in Keepr", indeterminate: true });
      return;
    case "complete":
      ended.add(job.jobId);
      syncOrchestrator.registerExternalSync(type); // a no-op while it is running
      syncOrchestrator.completeExternalSync(type, { status: "complete", summary: step.summary });
      return;
    case "error":
      ended.add(job.jobId);
      syncOrchestrator.registerExternalSync(type);
      syncOrchestrator.completeExternalSync(type, { status: "error", error: step.error });
      return;
    case "cancelled":
      ended.add(job.jobId);
      syncOrchestrator.removeExternalSync(type);
      return;
  }
}

export function useGoogleMessagesSyncStatus(): void {
  const ended = useRef(new Set<string>());
  useEffect(() => rcsImportService.onJobProgress((job) => applyGoogleMessagesJob(job, ended.current)), []);
}
