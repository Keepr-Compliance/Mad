/**
 * Support access settings section (BACKLOG-2393)
 *
 * Four things live here, and each exists because of a specific way this
 * feature could otherwise mislead someone:
 *
 *  - The grant screen states what is actually in the file. Since BACKLOG-2428
 *    that is counts and outcomes, not contact names and phone numbers — the one
 *    scope that recorded a person's details is gone. What remains is the
 *    diagnostics block's `recent_errors`, whose messages are copied verbatim
 *    and can name someone if that is what the error was about. "Diagnostic
 *    data" would be true and misleading, which is worse than false; so would
 *    "no personal data", in the other direction.
 *  - The window is shown as a date, not a duration. In thirty days nobody
 *    remembers what "30 days" meant on the day they clicked it.
 *  - Every report is listed, queued and sent, with a delete that reaches the
 *    server. A delete that only cleared the local copy would be a lie told by a
 *    button.
 *  - A capture that failed is shown (BACKLOG-2430). It used to throw at a timer
 *    where nothing caught it, so the panel counted down over an empty list —
 *    which reads as a quiet machine rather than one recording nothing.
 *
 * Components never call window.api directly — everything goes through
 * src/services/supportAccessService.ts.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useNotification } from "@/hooks/useNotification";
import logger from "../../utils/logger";
import { safeErrorMessage } from "../../utils/formatUtils";
import {
  captureNow,
  deleteReport,
  formatBytes,
  formatExpiry,
  formatRemaining,
  getSnapshot,
  grantAccess,
  revokeAccess,
  sendReport,
  type SupportAccessDurationId,
  type SupportAccessSnapshot,
  type SupportLogScopeId,
  type SupportReportListItem,
} from "../../services/supportAccessService";

function StateBadge({ report }: { report: SupportReportListItem }) {
  const map: Record<string, { label: string; className: string }> = {
    queued: {
      label: "Ready to send",
      className: "bg-amber-100 text-amber-800 border-amber-200",
    },
    sent: {
      label: "Sent",
      className: "bg-green-100 text-green-800 border-green-200",
    },
    failed: {
      label: "Failed",
      className: "bg-red-100 text-red-800 border-red-200",
    },
  };
  const entry = map[report.state] ?? map.queued;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${entry.className}`}
    >
      {entry.label}
    </span>
  );
}

export function SupportAccessSettings(): React.ReactElement {
  const { notify } = useNotification();

  const [snapshot, setSnapshot] = useState<SupportAccessSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [showGrantPanel, setShowGrantPanel] = useState<boolean>(false);
  const [durationId, setDurationId] = useState<SupportAccessDurationId>("7d");
  const [scopes, setScopes] = useState<SupportLogScopeId[]>([]);
  // Deliberately starts false. The affirmative action is the whole point.
  const [understood, setUnderstood] = useState<boolean>(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getSnapshot();
      setSnapshot(next);
      setDurationId(next.defaultDurationId);
      setScopes((current) =>
        current.length > 0 ? current : [...next.defaultScopes],
      );
    } catch (error) {
      logger.error("Failed to load support access state:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the countdown honest while the panel is open. A minute is fine: the
  // shortest window offered is 24 hours.
  useEffect(() => {
    if (!snapshot?.state.active) return undefined;
    const timer = setInterval(() => {
      void load();
    }, 60_000);
    return () => clearInterval(timer);
  }, [snapshot?.state.active, load]);

  const reports = snapshot?.reports ?? [];
  const active = snapshot?.state.active === true;
  const everGranted = snapshot?.state.everGranted === true;
  const consent = snapshot?.state.consent ?? null;

  const toggleScope = useCallback((scope: SupportLogScopeId) => {
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((s) => s !== scope)
        : [...current, scope],
    );
  }, []);

  const handleGrant = useCallback(async () => {
    if (!snapshot) return;
    setBusy("grant");
    try {
      await grantAccess({
        durationId,
        scopes,
        // Send back the wording that was rendered, so the consent record names
        // what this person actually read rather than what the app assumed.
        disclosure: snapshot.disclosure,
      });
      setShowGrantPanel(false);
      setUnderstood(false);
      await load();
      notify.success("Support access is on");
    } catch (error) {
      notify.error(safeErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [snapshot, durationId, scopes, load, notify]);

  const handleRevoke = useCallback(async () => {
    setBusy("revoke");
    try {
      await revokeAccess();
      await load();
      notify.success("Support access is off");
    } catch (error) {
      notify.error(safeErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [load, notify]);

  const handleCapture = useCallback(async () => {
    setBusy("capture");
    try {
      await captureNow();
      await load();
      notify.success("Report captured and added to the list");
    } catch (error) {
      notify.error(safeErrorMessage(error));
    } finally {
      setBusy(null);
    }
  }, [load, notify]);

  const handleSend = useCallback(
    async (id: string) => {
      setBusy(`send:${id}`);
      try {
        await sendReport(id);
        await load();
        notify.success("Report sent to Keepr support");
      } catch (error) {
        notify.error(safeErrorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    [load, notify],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(`delete:${id}`);
      try {
        const outcome = await deleteReport(id);
        await load();
        if (outcome.deleted) {
          notify.success("Report deleted from this Mac and from Keepr");
        } else {
          // The row stays. Saying "deleted" here while a copy sits in Keepr
          // storage is the failure this whole path exists to prevent.
          notify.error(
            outcome.error
              ? `Not deleted — ${outcome.error}. The report is still stored; try again when you are back online.`
              : "Not deleted. The report is still stored; try again.",
          );
        }
      } catch (error) {
        notify.error(safeErrorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    [load, notify],
  );

  // BACKLOG-2430. A capture that fails on the schedule throws at a timer,
  // where nothing catches it, so the only symptom was an empty report list
  // under a healthy-looking countdown — which reads as "this Mac had nothing
  // to report" rather than "this Mac recorded nothing". Somebody could grant
  // access for seven days and send nothing at all without ever being told.
  const captureFailure = snapshot?.captureFailure ?? null;

  return (
    <div id="settings-support-access" className="mb-8">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">
        Keepr support access
      </h3>

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-3">
          {/* ---------------- Current window ---------------- */}
          {active && consent ? (
            <div className="p-4 rounded-lg border border-blue-200 bg-blue-50">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4 className="text-sm font-medium text-blue-900">
                    Support access is on until {formatExpiry(consent.expiresAt)}
                  </h4>
                  <p className="text-xs text-blue-800 mt-1">
                    It ends by itself in{" "}
                    {formatRemaining(snapshot?.state.msRemaining ?? 0)}. Until
                    then Keepr collects extra detail about{" "}
                    {consent.scopes.length === 1
                      ? "one area"
                      : `${consent.scopes.length} areas`}{" "}
                    of the app and sends it to support about once an hour.
                  </p>
                </div>
                <button
                  onClick={() => void handleRevoke()}
                  disabled={busy === "revoke"}
                  className="shrink-0 px-3 py-1.5 text-xs font-medium rounded border border-blue-300 bg-white text-blue-800 hover:bg-blue-100 disabled:opacity-50"
                >
                  {busy === "revoke" ? "Turning off…" : "Turn off now"}
                </button>
              </div>
              {captureFailure && (
                <div
                  role="alert"
                  data-testid="support-capture-failure"
                  className="mt-3 p-3 rounded border border-red-300 bg-red-50"
                >
                  <p className="text-xs font-medium text-red-900">
                    Keepr could not capture a diagnostic report, so support is
                    receiving nothing.
                  </p>
                  <p className="text-xs text-red-800 mt-1">
                    {captureFailure.message}
                  </p>
                  <p className="text-xs text-red-700 mt-1">
                    Last tried {formatExpiry(captureFailure.at)}. Support access
                    is still on, but until this is fixed nothing is being
                    recorded or sent.
                  </p>
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => void handleCapture()}
                  disabled={busy === "capture"}
                  className="px-3 py-1.5 text-xs font-medium rounded border border-blue-300 bg-white text-blue-800 hover:bg-blue-100 disabled:opacity-50"
                >
                  {busy === "capture" ? "Capturing…" : "Capture a report now"}
                </button>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-lg border border-gray-200 bg-gray-50">
              <h4 className="text-sm font-medium text-gray-900">
                Support access is off
              </h4>
              <p className="text-xs text-gray-600 mt-1">
                If Keepr support asks you to turn this on, it lets them see what
                the app is doing on this Mac for a period you choose. It ends by
                itself.
              </p>
              {!showGrantPanel && (
                <button
                  onClick={() => setShowGrantPanel(true)}
                  className="mt-3 px-3 py-1.5 text-xs font-medium rounded border border-gray-300 bg-white text-gray-800 hover:bg-gray-100"
                >
                  Turn on support access…
                </button>
              )}
            </div>
          )}

          {/* ---------------- Grant screen ---------------- */}
          {!active && showGrantPanel && snapshot && (
            <div className="p-4 rounded-lg border border-gray-300 bg-white space-y-4">
              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-2">
                  What gets sent
                </h4>
                <p className="text-xs text-gray-700 whitespace-pre-line leading-relaxed">
                  {snapshot.disclosure.text}
                </p>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-2">
                  How long
                </h4>
                <div className="flex flex-wrap gap-2">
                  {snapshot.durations.map((duration) => (
                    <label
                      key={duration.id}
                      className={`px-3 py-1.5 text-xs rounded border cursor-pointer ${
                        durationId === duration.id
                          ? "border-blue-500 bg-blue-50 text-blue-900 font-medium"
                          : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="support-access-duration"
                        className="sr-only"
                        checked={durationId === duration.id}
                        onChange={() => setDurationId(duration.id)}
                      />
                      {duration.label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-2">
                  What to look at
                </h4>
                <div className="space-y-2">
                  {snapshot.scopes.map((scope) => (
                    <label
                      key={scope.id}
                      className="flex items-start gap-2 text-xs text-gray-700"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={scopes.includes(scope.id)}
                        onChange={() => toggleScope(scope.id)}
                      />
                      <span>
                        <span className="font-medium text-gray-900">
                          {scope.label}
                        </span>
                        {/*
                          BACKLOG-2428: a "names an individual" badge used to
                          sit here, and an amber warning below the list when a
                          scope carrying it was ticked. Both are gone with the
                          only scope that ever set the flag. Every remaining
                          scope records counts and outcomes, so a badge that
                          could never appear would just be dead markup.
                        */}
                        <span className="block text-gray-600 mt-0.5">
                          {scope.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="pt-2 border-t border-gray-200">
                <label className="flex items-start gap-2 text-xs text-gray-800">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={understood}
                    onChange={(e) => setUnderstood(e.target.checked)}
                  />
                  <span>
                    {/*
                      BACKLOG-2428: this used to say contacts' names and phone
                      numbers would be sent. That was true only because of the
                      contact-trace scope, which has been removed — so leaving
                      it would be the app asking someone to confirm something
                      that no longer happens.

                      It names the residual route rather than stopping at "a
                      record of what the app did", which is true but abstract.
                      This is the one sentence a user is guaranteed to read,
                      because they have to tick it; going from
                      over-specific-and-false to vague-and-true would lose
                      informedness at the exact moment of affirmative action.

                      Note for whoever edits this next: this sentence is NOT
                      covered by the disclosure hash. The attested body above
                      and the line people actually read can drift apart with
                      nothing detecting it, so keep them saying the same thing.
                    */}
                    I understand that Keepr will send a record of what the app
                    did on this Mac — counts and outcomes, plus error messages
                    that can occasionally include a name — to Keepr support, and
                    that reports are deleted after {snapshot.retentionDays} days.
                  </span>
                </label>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => void handleGrant()}
                    disabled={
                      !understood || scopes.length === 0 || busy === "grant"
                    }
                    className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {busy === "grant"
                      ? "Turning on…"
                      : `Turn on for ${
                          snapshot.durations.find((d) => d.id === durationId)
                            ?.label ?? durationId
                        }`}
                  </button>
                  <button
                    onClick={() => {
                      setShowGrantPanel(false);
                      setUnderstood(false);
                    }}
                    className="px-3 py-1.5 text-xs font-medium rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                </div>
                {scopes.length === 0 && (
                  <p className="mt-2 text-xs text-gray-500">
                    Choose at least one area to look at.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ---------------- Reports ---------------- */}
          {everGranted && (
            <div className="p-4 rounded-lg border border-gray-200 bg-white">
              <h4 className="text-sm font-medium text-gray-900 mb-1">
                Diagnostic reports
              </h4>
              <p className="text-xs text-gray-600 mb-3">
                Everything captured on this Mac, waiting to go and already sent.
                Deleting a report removes it from Keepr&apos;s servers as well
                as from this Mac.
              </p>

              {reports.length === 0 ? (
                <p className="text-xs text-gray-500">
                  Nothing has been captured yet.
                </p>
              ) : (
                <ul className="divide-y divide-gray-200">
                  {reports.map((report) => (
                    <li
                      key={report.id}
                      className="py-3 flex items-start justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StateBadge report={report} />
                          <span className="text-xs text-gray-900 font-medium">
                            {report.state === "sent" && report.sentAt
                              ? `Sent ${formatExpiry(report.sentAt)}`
                              : `Captured ${formatExpiry(report.capturedAt)}`}
                          </span>
                        </div>
                        <p className="text-xs text-gray-600 mt-1">
                          {formatBytes(report.byteSize)} · {report.covers}
                        </p>
                        {report.state === "sent" &&
                          typeof report.serverDeleteInDays === "number" && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              Deleted from Keepr in {report.serverDeleteInDays}{" "}
                              {report.serverDeleteInDays === 1 ? "day" : "days"}
                            </p>
                          )}
                        {/*
                          A report that was never sent has a deadline too, and
                          it is a different one: this Mac drops it. Showing only
                          the server countdown left every unsent row looking as
                          though it would sit here forever — which, before the
                          local retention clock existed, it would have.
                        */}
                        {report.state !== "sent" &&
                          typeof report.localDeleteInDays === "number" && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              Deleted from this Mac in {report.localDeleteInDays}{" "}
                              {report.localDeleteInDays === 1 ? "day" : "days"}
                              {report.state === "failed" ? "" : ", sent or not"}
                            </p>
                          )}
                        {report.truncated && (
                          <p className="text-xs text-amber-700 mt-0.5">
                            Older log entries were left out to fit the size
                            limit ({formatBytes(report.truncatedBytes)} dropped).
                          </p>
                        )}
                        {report.lastError && (
                          <p className="text-xs text-red-600 mt-0.5">
                            {report.lastError}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 flex gap-2">
                        {report.state !== "sent" && active && (
                          <button
                            onClick={() => void handleSend(report.id)}
                            disabled={busy === `send:${report.id}`}
                            className="px-2 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            {busy === `send:${report.id}`
                              ? "Sending…"
                              : "Send now"}
                          </button>
                        )}
                        <button
                          onClick={() => void handleDelete(report.id)}
                          disabled={busy === `delete:${report.id}`}
                          className="px-2 py-1 text-xs rounded border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          {busy === `delete:${report.id}`
                            ? "Deleting…"
                            : "Delete"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SupportAccessSettings;
