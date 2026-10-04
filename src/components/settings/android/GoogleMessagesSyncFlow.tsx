/**
 * Dashboard → Sync Android → Google Messages (BACKLOG-3659).
 *
 * Install the Keepr extension (Release 1: unpacked, from Downloads) →
 * connect Google Messages → Sync (Keepr opens Google Messages in Chrome and
 * runs the cache Sync) → back in Keepr with the result.
 *
 * The step comes from googleMessagesStep(); the extension is detected by its
 * hello (polled every 3 s while this flow is open).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { rcsImportService } from "../../../services/rcsImportService";
import type { RcsExtensionState, RcsJobInfo } from "../../../../electron/types/ipc/window-api-rcs-import";
import { doneSummaryLines, extensionInstalled, googleMessagesStep, syncCopyLine } from "./googleMessagesSyncSteps";
import { LinkBrowserPanel } from "./LinkBrowserPanel";

const POLL_MS = 3000;

interface GoogleMessagesSyncFlowProps {
  onClose: () => void;
  /** "Another messaging app": switch to the Keepr companion app flow. */
  onUseCompanion?: () => void;
  /** "Change" under the Sync button: open Settings → Messages at the months control. */
  onOpenSettings?: () => void;
  /** Test seam: the poll interval. */
  pollMs?: number;
}

function Numbered({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 items-start">
      <span className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-800 text-xs font-bold flex items-center justify-center flex-shrink-0">
        {n}
      </span>
      <span className="text-sm text-gray-800 leading-relaxed">{children}</span>
    </li>
  );
}

function Check({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2" data-testid={ok ? "check-ok" : "check-pending"}>
      {ok ? (
        <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12l5 5 9-10" />
        </svg>
      ) : (
        <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
        </svg>
      )}
      <span className={`text-sm ${ok ? "text-gray-900" : "text-gray-600"}`}>{children}</span>
    </div>
  );
}

const primary =
  "min-h-[44px] px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed";
const secondary =
  "min-h-[44px] px-4 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-900 text-sm font-semibold";

export function GoogleMessagesSyncFlow({ onClose, onUseCompanion, onOpenSettings, pollMs = POLL_MS }: GoogleMessagesSyncFlowProps) {
  const [state, setState] = useState<RcsExtensionState | null>(null);
  const [job, setJob] = useState<RcsJobInfo | null>(null);
  const [continued, setContinued] = useState(false);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const [chromeNote, setChromeNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await rcsImportService.getExtensionState();
    if (r.success && r.data) setState(r.data);
  }, []);

  // Detection: the extension's hello, polled while this flow is open.
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  // The cache job this flow started.
  useEffect(() => {
    return rcsImportService.onJobProgress((next) => {
      if (next && next.jobId === jobIdRef.current) setJob(next);
    });
  }, []);

  // BACKLOG-3658: reopened (from the dashboard indicator) while a cache Sync
  // runs or is being saved: show THAT Sync's live progress, not the start.
  useEffect(() => {
    let live = true;
    void rcsImportService.getJob().then((r) => {
      const current = r.success ? r.data : null;
      if (!live || !current || current.kind !== "cache" || jobIdRef.current) return;
      const active = current.state === "created" || current.state === "running";
      const saving = current.state === "finished" && current.saved === undefined;
      if (!active && !saving) return;
      jobIdRef.current = current.jobId;
      setJob(current);
    });
    return () => {
      live = false;
    };
  }, []);

  const step = googleMessagesStep({ state, job, continued });
  const installed = extensionInstalled(state);
  const paired = !!state?.pairedAt;
  /** BACKLOG-3666: the extension paired with THIS Keepr (a Sync is refused until then). */
  const keeprPaired = state?.extensionPaired === true;
  const doneLines = step === "done" && job ? doneSummaryLines(job) : null;
  const stepRef = useRef(step);
  stepRef.current = step;
  const preparedRef = useRef(false);

  // The extension goes to Downloads as soon as the install step shows — once
  // per flow (StrictMode runs effects twice in development). A failure is
  // shown only while the user is still on the install step.
  useEffect(() => {
    if (step !== "install" || preparedRef.current) return;
    preparedRef.current = true;
    void rcsImportService.prepareExtension().then((r) => {
      if (r.success) setFolderNote(`Downloads › ${r.data?.folder.split(/[\\/]/).pop() ?? "Keepr Extension"}`);
      else if (stepRef.current === "install") setError(r.error ?? "Keepr could not prepare the extension.");
    });
  }, [step]);

  const openChrome = useCallback(async () => {
    const r = await rcsImportService.openChromeForExtension();
    setChromeNote(
      r.opened
        ? "Chrome is opening. The address is copied: click Chrome's address bar, press Ctrl+V, then Enter."
        : "The address is copied. Open Chrome, click its address bar, press Ctrl+V, then Enter.",
    );
  }, []);

  const startSync = useCallback(async () => {
    setStarting(true);
    setError(null);
    const r = await rcsImportService.startCacheJob();
    setStarting(false);
    if (!r.success || !r.data) {
      setError(r.error ?? "Keepr could not start the Sync.");
      return;
    }
    jobIdRef.current = r.data.jobId;
    setJob(r.data);
  }, []);

  const cancel = useCallback(async () => {
    if (job) await rcsImportService.cancelJob(job.jobId);
  }, [job]);

  /** Founder: a FAILED Sync tries again at once (the chats it saved are skipped). */
  const retryFailed = useCallback(async () => {
    setStarting(true);
    setError(null);
    const r = await rcsImportService.retryCacheJob();
    setStarting(false);
    if (!r.success || !r.data) {
      setError(r.error ?? "Keepr could not start the Sync.");
      return;
    }
    jobIdRef.current = r.data.jobId;
    setJob(r.data);
  }, []);

  const tryAgain = useCallback(() => {
    jobIdRef.current = null;
    setJob(null);
    setError(null);
  }, []);

  return (
    <div className="flex flex-col gap-4" data-testid={`gm-step-${step}`}>
      {step === "install" && (
        <>
          <div className="text-xs font-semibold text-gray-500 tracking-wide">STEP 1 OF 2</div>
          <h2 className="text-lg font-bold text-gray-900">Add the Keepr extension to Chrome</h2>
          <p className="text-sm text-gray-600">
            We put the extension in your Downloads folder{folderNote ? ` (${folderNote})` : ""}. It takes about a minute.
          </p>
          <ol className="flex flex-col gap-2">
            <Numbered n={1}>
              Click <b>Open Chrome</b> below. We copy the Extensions address for you. In Chrome, click the address bar,
              press <b>Ctrl+V</b>, then <b>Enter</b>.
            </Numbered>
            <Numbered n={2}>Turn on <b>Developer mode</b> (the switch at the top right).</Numbered>
            <Numbered n={3}>Click <b>Load unpacked</b> and choose <b>Downloads › Keepr Extension</b>.</Numbered>
            <Numbered n={4}>Come back here. Keepr notices when it is installed.</Numbered>
          </ol>
          <div className="flex gap-2">
            <button type="button" className={`flex-1 ${primary}`} onClick={() => void openChrome()}>
              Open Chrome (address copied)
            </button>
            <button type="button" className={`flex-1 ${secondary}`} onClick={() => void rcsImportService.showExtensionFolder()}>
              Show folder in Downloads
            </button>
          </div>
          {chromeNote && <p className="text-sm text-gray-700" role="status">{chromeNote}</p>}
          <div className="p-3 rounded-lg bg-gray-50 border border-gray-200" role="status" data-testid="gm-detect">
            {installed ? <Check ok>Keepr extension installed</Check> : <Check ok={false}>Waiting for the extension…</Check>}
          </div>
          <p className="text-xs text-gray-600">
            Chrome may warn about Developer-mode extensions when it starts. That is expected until Keepr is in the Chrome
            Web Store. Keep the folder where it is.
          </p>
          <button type="button" className={primary} onClick={() => setContinued(true)}>
            Continue
          </button>
          {onUseCompanion && (
            <button type="button" className="text-sm text-indigo-700 hover:text-indigo-900 text-left" onClick={onUseCompanion}>
              Use another texting app? Use the Keepr companion app instead
            </button>
          )}
        </>
      )}

      {step === "connect" && (
        <>
          <div className="text-xs font-semibold text-gray-500 tracking-wide">STEP 2 OF 2</div>
          <h2 className="text-lg font-bold text-gray-900">Connect your phone and sync</h2>
          <div className="flex flex-col gap-2 p-3 rounded-xl border border-gray-200">
            <Check ok={installed}>Keepr extension installed</Check>
            <Check ok={paired}>Google Messages connected to your phone</Check>
            <Check ok={keeprPaired}>Extension linked with this Keepr</Check>
          </div>
          {/* Live (B2): always there once installed — a code from the browser
              gets its field even when Keepr already counts a link. */}
          {installed && <LinkBrowserPanel />}
          {/* Both checks ticked: the pairing instruction is no longer needed. */}
          {installed && paired ? (
            <p className="text-sm text-gray-800 leading-relaxed" data-testid="gm-sync-note">
              Keepr opens Google Messages and copies your texts. Keep that Chrome window visible until it is done.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              <Numbered n={1}>
                <span data-testid="gm-pair-instruction">
                  In Chrome, open Google Messages and sign in with your Google account or scan the QR code with your
                  phone. Leave <b>Remember this computer</b> on.
                </span>
              </Numbered>
              <Numbered n={2}>
                Click <b>Open Google Messages and sync</b>. Keep that Chrome window visible until it is done.
              </Numbered>
            </ol>
          )}
          <button type="button" className={primary} onClick={() => void startSync()} disabled={starting || !keeprPaired}>
            {starting ? "Starting…" : "Open Google Messages and sync"}
          </button>
          <p className="text-xs text-gray-600" data-testid="gm-copy-line">
            {syncCopyLine(state?.lookbackMonths)}{" "}
            {onOpenSettings ? (
              <button type="button" className="text-indigo-700 hover:text-indigo-900 underline" onClick={onOpenSettings}>
                Change
              </button>
            ) : (
              "Change"
            )}{" "}
            this in Settings → Messages.
          </p>
          {!installed && (
            <button type="button" className="text-sm text-indigo-700 hover:text-indigo-900 text-left" onClick={() => setContinued(false)}>
              Back to installing the extension
            </button>
          )}
        </>
      )}

      {step === "syncing" && (
        <>
          <h2 className="text-lg font-bold text-gray-900">{job?.readingOlder ? "Reading older texts…" : "Syncing your texts"}</h2>
          <p className="text-sm text-gray-700" role="status" data-testid="gm-stage">
            {job?.stage || "Waiting for Google Messages to open in Chrome"}
          </p>
          <p className="text-xs text-gray-600">Keep the Chrome window visible: the Sync pauses while it is hidden.</p>
          <button type="button" className={secondary} onClick={() => void cancel()}>
            Cancel
          </button>
        </>
      )}

      {step === "done" && job && (
        <>
          <h2 className="text-lg font-bold text-gray-900">
            {doneLines ? "Your texts are synced" : "Saving your texts…"}
          </h2>
          {/* What Keepr SAVED (not what the page sent). */}
          <div className="flex flex-col gap-1 p-3 rounded-lg border border-gray-200" role="status" data-testid="gm-done-summary">
            {(doneLines ?? ["Keepr is saving what it copied. This takes a moment."]).map((line) => (
              <p key={line} className="text-sm text-gray-800">
                {line}
              </p>
            ))}
          </div>
          <p className="text-xs text-gray-600">
            Keepr adds them to the right transactions by phone number. Next time, click <b>Sync Android</b> on the
            dashboard: Keepr opens Google Messages and only fetches what is new.
          </p>
          <button type="button" className={primary} onClick={onClose}>
            Done
          </button>
        </>
      )}

      {step === "failed" && job && (
        <>
          <h2 className="text-lg font-bold text-gray-900">{job.state === "failed" ? "Sync failed" : "The Sync did not finish"}</h2>
          <p className="text-sm text-gray-700">{job.error?.message || (job.state === "cancelled" ? "It was cancelled." : "Something went wrong.")}</p>
          <button
            type="button"
            className={primary}
            onClick={job.state === "failed" ? () => void retryFailed() : tryAgain}
            disabled={starting}
            data-testid="gm-try-again"
          >
            Try again
          </button>
        </>
      )}

      {error && (
        <p className="text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
