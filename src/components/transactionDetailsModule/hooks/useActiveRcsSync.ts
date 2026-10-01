/**
 * BACKLOG-3661 — only one Sync at a time.
 *
 * Every Sync button in Keepr (each transaction's Messages panel today; the
 * dashboard's "Sync Android" later) reads the SAME state: the one created or
 * running Sync job, from any transaction, kept current by the main process's
 * job broadcast. While it runs every Sync button shows "Syncing…" disabled,
 * and "Syncing: <what>" with a Cancel says what is running.
 */

import { useCallback, useEffect, useState } from "react";

import { rcsImportService, type RcsJobInfo } from "../../../services/rcsImportService";

export interface ActiveRcsSync {
  /** The created or running job, from any transaction; null when none runs. */
  activeJob: RcsJobInfo | null;
  /** "Syncing: <transaction name>" — what is running, for the label. */
  syncingLabel: string | null;
  cancel: () => Promise<void>;
}

export function isActiveJob(job: RcsJobInfo | null | undefined): job is RcsJobInfo {
  return !!job && (job.state === "created" || job.state === "running");
}

export function useActiveRcsSync(): ActiveRcsSync {
  const [activeJob, setActiveJob] = useState<RcsJobInfo | null>(null);

  useEffect(() => {
    let alive = true;
    let heardBroadcast = false;
    const accept = (next: RcsJobInfo | null): void => {
      if (!alive) return;
      // There is one job at a time: whatever the broadcast says is THE job.
      setActiveJob(isActiveJob(next) ? next : null);
    };
    const unsubscribe = rcsImportService.onJobProgress((next) => {
      heardBroadcast = true;
      accept(next);
    });
    // The first read only fills the gap before any broadcast: a late answer
    // must not overwrite a newer broadcast (e.g. a job that just finished).
    void rcsImportService.getJob().then((r) => {
      if (r.success && !heardBroadcast) accept(r.data ?? null);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const cancel = useCallback(async () => {
    if (activeJob) await rcsImportService.cancelJob(activeJob.jobId);
  }, [activeJob]);

  const syncingLabel = activeJob ? `Syncing: ${activeJob.label ?? "a transaction"}` : null;
  return { activeJob, syncingLabel, cancel };
}
