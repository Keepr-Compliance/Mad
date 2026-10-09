/**
 * AtRestMigrationBanner — BACKLOG-3816 S3.
 *
 * Shown while Keepr encrypts the files it saved before 2.40. It never blocks the
 * app: it is a thin strip above the content, and the user keeps working.
 *
 * Renders nothing when there is nothing to do (phase idle, or a run that found
 * every file already encrypted).
 */
import React, { useEffect, useState } from "react";

import {
  atRestMigrationService,
  type AtRestMigrationStatus,
} from "../../services/atRestMigrationService";

export const COPY = {
  title: "Securing your saved data",
  body: "Keepr is encrypting files it saved on this computer. You can keep working.",
  done: "Your saved files are now encrypted.",
  pausedDisk:
    "Paused — your computer is low on disk space. Free up some space and Keepr will continue automatically.",
  pausedInUse:
    "Some files were in use by another program. Keepr will finish securing them the next time it starts.",
} as const;

const DONE_VISIBLE_MS = 8000;

export function formatDetails(status: AtRestMigrationStatus): string {
  const base = `${status.done} of ${status.total} files`;
  if (status.minutesLeft === null) return base;
  const n = Math.max(1, status.minutesLeft);
  return `${base} · about ${n} ${n === 1 ? "minute" : "minutes"} left`;
}

export function AtRestMigrationBanner(): React.ReactElement | null {
  const [status, setStatus] = useState<AtRestMigrationStatus | null>(null);
  const [doneHidden, setDoneHidden] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = atRestMigrationService.subscribe((s) => {
      if (active) setStatus(s);
    });
    void atRestMigrationService.getStatus().then((s) => {
      // A push that arrived first is newer than this read.
      if (active && s) setStatus((current) => current ?? s);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const phase = status?.phase;
  useEffect(() => {
    if (phase !== "done") return;
    setDoneHidden(false);
    const timer = setTimeout(() => setDoneHidden(true), DONE_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!status || status.phase === "idle" || status.total === 0) return null;

  if (status.phase === "done") {
    if (doneHidden || status.encryptedThisLaunch === 0) return null;
    return (
      <div
        className="flex-shrink-0 bg-green-50 border-b border-green-200 px-4 py-2"
        role="status"
        data-testid="at-rest-migration-banner"
      >
        <p className="text-sm font-medium text-green-800 text-center">{COPY.done}</p>
      </div>
    );
  }

  const paused = status.phase === "paused";
  const pausedMessage =
    status.pauseReason === "disk-space" ? COPY.pausedDisk : status.pauseReason === "files-in-use" ? COPY.pausedInUse : null;

  return (
    <div
      className={`flex-shrink-0 border-b px-4 py-2 ${paused ? "bg-yellow-50 border-yellow-200" : "bg-blue-50 border-blue-200"}`}
      role="status"
      aria-live="polite"
      data-testid="at-rest-migration-banner"
    >
      <div className="max-w-4xl mx-auto">
        <p className={`text-sm font-medium ${paused ? "text-yellow-900" : "text-blue-900"}`}>
          {COPY.title} — {COPY.body}
        </p>
        <p className={`text-xs ${paused ? "text-yellow-800" : "text-blue-800"}`}>
          {paused && pausedMessage ? pausedMessage : formatDetails(status)}
        </p>
      </div>
    </div>
  );
}

export default AtRestMigrationBanner;
