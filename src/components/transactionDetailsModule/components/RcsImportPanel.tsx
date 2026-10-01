/**
 * RCS Import panel — BACKLOG-3619 (proof of concept).
 *
 * The Messages tab's Import button. Clicking it opens the one import session
 * for this transaction; the Chrome extension's "Send to Keepr" then posts chats
 * into it. The panel shows "waiting / N chats received", refreshes the
 * transaction's messages on every chat, and closes the session on Done.
 *
 * The session lives in {@link useRcsImportSession}, called ONCE at the top of
 * the Messages tab — not in the panel. The tab renders the panel in two
 * different trees (empty state and header); the first chat that lands flips
 * the tab from one to the other, and a panel that owned the session would
 * unmount, close it, and answer the next Send with "click Import first".
 * The session closes when the Messages tab itself unmounts (leaving the tab or
 * closing the transaction) or the transaction changes.
 *
 * Rendered whether or not the transaction has contacts: importing does not
 * depend on them.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { isActiveJob, useActiveRcsSync } from "../hooks/useActiveRcsSync";

import {
  rcsImportService,
  type RcsImportStatus,
  type RcsJobInfo,
} from "../../../services/rcsImportService";

export interface RcsImportSessionView {
  sessionId: string;
  chats: number;
  messages: number;
  stored: number;
}

export interface RcsImportController {
  session: RcsImportSessionView | null;
  bridgeProblem: string | null;
  error: string | null;
  starting: boolean;
  start: () => Promise<void>;
  done: () => Promise<void>;
}

function bridgeProblemFor(status: RcsImportStatus): string | null {
  return status.bridge === "listening"
    ? null
    : `Import bridge unavailable${status.reason ? `: ${status.reason}` : ""}.`;
}

/**
 * The import session for one transaction. Call once per Messages tab.
 * `onImported` runs after each chat for THIS session lands.
 */
export function useRcsImportSession(
  transactionId: string | undefined,
  onImported?: () => void | Promise<void>,
): RcsImportController {
  const [session, setSession] = useState<RcsImportSessionView | null>(null);
  const [bridgeProblem, setBridgeProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  // Bumped by the effect cleanup (unmount or transaction change) so a
  // startSession still in flight can tell it has been superseded.
  const generationRef = useRef(0);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  useEffect(() => {
    const unsubscribe = rcsImportService.onChatReceived((event) => {
      if (event.sessionId !== sessionIdRef.current) return;
      setSession({
        sessionId: event.sessionId,
        chats: event.session.chatsReceived,
        messages: event.session.messagesReceived,
        stored: event.session.messagesStored,
      });
      void onImportedRef.current?.();
    });
    return () => {
      unsubscribe();
      generationRef.current += 1;
      const open = sessionIdRef.current;
      sessionIdRef.current = null;
      if (open) void rcsImportService.endSession(open);
    };
    // Re-run (closing any open session) only when the transaction changes.
  }, [transactionId]);

  const start = useCallback(async () => {
    if (!transactionId) return;
    setStarting(true);
    setError(null);
    const generation = generationRef.current;
    const result = await rcsImportService.startSession(transactionId);
    setStarting(false);
    if (generation !== generationRef.current) {
      // Unmounted or moved to another transaction while starting: close the
      // session just opened so nothing keeps receiving chats unseen.
      if (result.success && result.data?.session) {
        void rcsImportService.endSession(result.data.session.sessionId);
      }
      return;
    }
    if (!result.success || !result.data?.session) {
      setError(result.error ?? "Could not start the import.");
      return;
    }
    setBridgeProblem(bridgeProblemFor(result.data));
    sessionIdRef.current = result.data.session.sessionId;
    setSession({ sessionId: result.data.session.sessionId, chats: 0, messages: 0, stored: 0 });
  }, [transactionId]);

  const done = useCallback(async () => {
    const open = sessionIdRef.current;
    sessionIdRef.current = null;
    setSession(null);
    setBridgeProblem(null);
    if (open) await rcsImportService.endSession(open);
  }, []);

  return { session, bridgeProblem, error, starting, start, done };
}

// ---------------------------------------------------------------------------
// BACKLOG-3620: Sync job
// ---------------------------------------------------------------------------

export interface RcsSyncJobController {
  /** The current job for THIS transaction, if any. */
  job: RcsJobInfo | null;
  error: string | null;
  starting: boolean;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  dismiss: () => void;
}

/**
 * When the transaction's messages are refetched: on another imported chat or
 * image, and once when the job finishes. NOT on created → running
 * (BACKLOG-3642): nothing has been imported yet, and the early refetch made
 * links still in the database look like the Sync had re-added them.
 */
function refetchKey(job: RcsJobInfo): string {
  return `${job.progress.imported}:${job.progress.images}:${job.state === "finished" ? "finished" : "open"}`;
}

/**
 * The Sync job for one transaction. The job itself lives in the main process,
 * keyed by its own id — this hook only shows it. Leaving the tab does NOT cancel
 * it; coming back shows it again (`getJob`). `onImported` runs whenever the job
 * reports another imported chat or image.
 */
export function useRcsSyncJob(
  transactionId: string | undefined,
  onImported?: () => void | Promise<void>,
): RcsSyncJobController {
  const [job, setJob] = useState<RcsJobInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;
  const lastCountRef = useRef<string>("");

  useEffect(() => {
    let alive = true;
    lastCountRef.current = "";
    setJob(null);
    const accept = (next: RcsJobInfo | null): void => {
      if (!alive || !next || next.transactionId !== transactionId) return;
      setJob(next);
      const count = refetchKey(next);
      if (lastCountRef.current && count !== lastCountRef.current) void onImportedRef.current?.();
      lastCountRef.current = count;
    };
    const unsubscribe = rcsImportService.onJobProgress(accept);
    // BACKLOG-3657: Force re-import cleared the imported texts: refetch this
    // transaction's messages so the removed ones disappear at once.
    const unsubscribeCleared = rcsImportService.onDataCleared(() => {
      if (alive) void onImportedRef.current?.();
    });
    void rcsImportService.getJob().then((r) => {
      if (r.success) accept(r.data ?? null);
    });
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeCleared();
    };
  }, [transactionId]);

  const start = useCallback(async () => {
    if (!transactionId) return;
    setStarting(true);
    setError(null);
    const result = await rcsImportService.startJob(transactionId);
    setStarting(false);
    if (!result.success || !result.data) {
      setError(result.error ?? "Could not start the sync.");
      return;
    }
    lastCountRef.current = refetchKey(result.data);
    setJob(result.data);
  }, [transactionId]);

  const cancel = useCallback(async () => {
    if (!job) return;
    await rcsImportService.cancelJob(job.jobId);
  }, [job]);

  const dismiss = useCallback(() => setJob(null), []);

  return { job, error, starting, start, cancel, dismiss };
}

/** BACKLOG-3641: the same counts the page's Details show. Chats, not contacts. */
function countsLine(job: RcsJobInfo): string {
  const p = job.progress;
  return `Scanned ${p.listed} chats · checked ${p.checked} · matched ${p.matched} · imported ${p.messages} messages`;
}

/** Why a chat was left out (BACKLOG-3629), as the page's Details word it. */
const LEFT_OUT_TEXT: Record<string, string> = {
  not_opened: "could not be opened",
  no_numbers: "no phone number shown",
  messages_not_loaded: "messages did not load",
  history_not_settled: "messages kept changing",
  no_messages: "no messages found",
  error: "failed",
  images_failed: "images not imported",
  history_truncated: "only the newest messages imported",
};

function jobLine(job: RcsJobInfo): string {
  const p = job.progress;
  const imported = `${p.imported} chat${p.imported === 1 ? "" : "s"}, ${p.messages} messages, ${p.images} images`;
  switch (job.state) {
    case "created":
      return "Opening Messages for Web in Chrome…";
    case "running":
      return `${job.stage} — checked ${p.checked} of ${p.candidates} chats; imported ${imported}`;
    case "finished":
      // BACKLOG-3641: say why nothing came in, not a bare "imported 0 chats".
      if (p.checked > 0 && p.matched === 0) {
        return `Sync done: checked ${p.checked} chat${p.checked === 1 ? "" : "s"} — none matched a phone number on this transaction's contacts.`;
      }
      return `Sync done: imported ${imported}` + (p.skipped > 0 ? `; ${p.skipped} skipped` : "") + ".";
    case "cancelled":
      return "Sync cancelled.";
    case "failed":
      return job.error?.message ?? "The sync failed.";
    default:
      return job.stage;
  }
}

export function RcsSyncJobStatus({ sync }: { sync: RcsSyncJobController }): React.ReactElement | null {
  const { job } = sync;
  if (!job) return null;
  const active = job.state === "created" || job.state === "running";
  return (
    <div
      className={`inline-flex items-center gap-3 px-3 py-1.5 text-sm rounded-lg ${
        job.state === "failed" ? "bg-red-50" : "bg-indigo-50"
      }`}
      data-testid="rcs-sync-job"
      data-state={job.state}
    >
      <span className={job.state === "failed" ? "text-red-700" : "text-gray-700"} data-testid="rcs-sync-job-status">
        {jobLine(job)}
      </span>
      {job.contactsWithoutPhone.length > 0 && (
        <span className="text-gray-500" data-testid="rcs-sync-job-no-phone">
          No phone number: {job.contactsWithoutPhone.join(", ")}
        </span>
      )}
      {!active && job.progress.listed > 0 && (
        <span className="text-gray-500" data-testid="rcs-sync-job-counts">
          {countsLine(job)}
        </span>
      )}
      {!active && (job.progress.notChecked ?? 0) > 0 && (
        <span className="text-gray-500" data-testid="rcs-sync-job-not-checked">
          Not checked: {job.progress.notChecked} chats (name didn&apos;t match a contact on this transaction)
        </span>
      )}
      {!active && (job.progress.removedNotRelinked ?? 0) > 0 && (
        <span className="text-gray-500" data-testid="rcs-sync-job-removed">
          {job.progress.removedNotRelinked} messages you removed were not re-added
        </span>
      )}
      {!active && job.notReached && job.notReached.length > 0 && (
        <span className="text-gray-500" data-testid="rcs-sync-job-left-out">
          Not fully imported:{" "}
          {job.notReached.map((e) => `${e.name} (${LEFT_OUT_TEXT[e.reason] ?? e.reason})`).join(", ")}
          {(job.notReachedMore ?? 0) > 0 ? `, +${job.notReachedMore} more` : ""}
        </span>
      )}
      {active ? (
        <button
          onClick={() => void sync.cancel()}
          className="px-2 py-1 font-medium text-indigo-700 hover:bg-indigo-100 rounded"
          data-testid="rcs-sync-job-cancel"
        >
          Cancel
        </button>
      ) : (
        <button
          onClick={sync.dismiss}
          className="px-2 py-1 font-medium text-indigo-700 hover:bg-indigo-100 rounded"
          data-testid="rcs-sync-job-dismiss"
        >
          Close
        </button>
      )}
    </div>
  );
}

/**
 * BACKLOG-3661: a Sync button that knows about EVERY Sync. While any job runs
 * (this transaction's or another's — one at a time), it reads "Syncing…" and
 * is disabled; a job on another transaction is named ("Syncing: <name>") with
 * a Cancel. Built on useActiveRcsSync so the dashboard's Sync can share it.
 */
export function RcsSyncButton({ sync }: { sync: RcsSyncJobController }): React.ReactElement {
  const active = useActiveRcsSync();
  const busy = sync.starting || isActiveJob(sync.job) || !!active.activeJob;
  const elsewhere = active.activeJob && active.activeJob.jobId !== sync.job?.jobId ? active.activeJob : null;
  return (
    <>
      <button
        onClick={() => void sync.start()}
        disabled={busy}
        className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-800 hover:bg-indigo-50 rounded-lg transition-colors disabled:opacity-50"
        data-testid="rcs-sync-button"
        title="Find this transaction's chats in Messages for Web (Chrome) and import them"
      >
        {busy ? "Syncing…" : "Sync"}
      </button>
      {elsewhere && (
        <span className="inline-flex items-center gap-2 text-sm text-gray-600" data-testid="rcs-sync-active-elsewhere">
          {active.syncingLabel}
          <button
            onClick={() => void active.cancel()}
            className="px-2 py-1 font-medium text-indigo-700 hover:bg-indigo-100 rounded"
            data-testid="rcs-sync-active-cancel"
          >
            Cancel
          </button>
        </span>
      )}
    </>
  );
}

export function RcsImportPanel({
  controller,
  sync,
}: {
  controller: RcsImportController;
  sync?: RcsSyncJobController;
}): React.ReactElement {
  const { session, bridgeProblem, error, starting, start, done } = controller;
  if (!session) {
    return (
      <div className="inline-flex items-center gap-2">
        {sync && <RcsSyncButton sync={sync} />}
        <button
          onClick={() => void start()}
          disabled={starting}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-green-600 hover:text-green-800 hover:bg-green-50 rounded-lg transition-colors disabled:opacity-50"
          data-testid="rcs-import-button"
        >
          Import
        </button>
        {error && (
          <span className="text-sm text-red-600" data-testid="rcs-import-error">
            {error}
          </span>
        )}
        {sync?.error && (
          <span className="text-sm text-red-600" data-testid="rcs-sync-error">
            {sync.error}
          </span>
        )}
        {sync && <RcsSyncJobStatus sync={sync} />}
      </div>
    );
  }

  return (
    <div
      className="inline-flex items-center gap-3 px-3 py-1.5 text-sm bg-green-50 rounded-lg"
      data-testid="rcs-import-session"
    >
      {bridgeProblem ? (
        <span className="text-red-600" data-testid="rcs-import-bridge-unavailable">
          {bridgeProblem}
        </span>
      ) : (
        <span className="text-gray-700" data-testid="rcs-import-status">
          {session.chats === 0
            ? "Waiting for chats from Chrome…"
            : `${session.chats} chat${session.chats === 1 ? "" : "s"} received (${session.messages} messages, ${session.stored} new)`}
        </span>
      )}
      <button
        onClick={() => void done()}
        className="px-2 py-1 font-medium text-green-700 hover:text-green-900 hover:bg-green-100 rounded"
        data-testid="rcs-import-done"
      >
        Done
      </button>
    </div>
  );
}
