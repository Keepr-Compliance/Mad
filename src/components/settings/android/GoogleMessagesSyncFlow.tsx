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
import { extensionInstalled, googleMessagesStep } from "./googleMessagesSyncSteps";
import {
  RCS_CONSENT_AGREE,
  RCS_CONSENT_COPY_VERSION,
  RCS_CONSENT_PARAGRAPHS,
  RCS_CONSENT_TITLE,
} from "./rcsConsentCopy";

const POLL_MS = 3000;

interface GoogleMessagesSyncFlowProps {
  onClose: () => void;
  /** "Another messaging app": switch to the Keepr companion app flow. */
  onUseCompanion?: () => void;
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

export function GoogleMessagesSyncFlow({ onClose, onUseCompanion, pollMs = POLL_MS }: GoogleMessagesSyncFlowProps) {
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

  const step = googleMessagesStep({ state, job, continued });
  const installed = extensionInstalled(state);

  // The extension goes to Downloads as soon as the install step shows.
  useEffect(() => {
    if (step !== "install" || folderNote) return;
    void rcsImportService.prepareExtension().then((r) => {
      setFolderNote(r.success ? `Downloads › ${r.data?.folder.split(/[\\/]/).pop() ?? "Keepr Extension"}` : null);
      if (!r.success) setError(r.error ?? "Keepr could not prepare the extension.");
    });
  }, [step, folderNote]);

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

  const agree = useCallback(async () => {
    setError(null);
    const r = await rcsImportService.setCacheConsent(RCS_CONSENT_COPY_VERSION);
    if (!r.success) {
      setError(r.error ?? "Keepr could not save your answer.");
      return;
    }
    await refresh();
  }, [refresh]);

  const cancel = useCallback(async () => {
    if (job) await rcsImportService.cancelJob(job.jobId);
  }, [job]);

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

      {step === "consent" && (
        <>
          <h2 className="text-lg font-bold text-gray-900">{RCS_CONSENT_TITLE}</h2>
          <div className="flex flex-col gap-2" data-testid="gm-consent-text">
            {RCS_CONSENT_PARAGRAPHS.map((p) => (
              <p key={p} className="text-sm text-gray-800 leading-relaxed">
                {p}
              </p>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" className={`flex-1 ${secondary}`} onClick={onClose}>
              Not now
            </button>
            <button type="button" className={`flex-1 ${primary}`} onClick={() => void agree()}>
              {RCS_CONSENT_AGREE}
            </button>
          </div>
        </>
      )}

      {step === "connect" && (
        <>
          <div className="text-xs font-semibold text-gray-500 tracking-wide">STEP 2 OF 2</div>
          <h2 className="text-lg font-bold text-gray-900">Connect your phone and sync</h2>
          <div className="flex flex-col gap-2 p-3 rounded-xl border border-gray-200">
            <Check ok={installed}>Keepr extension installed</Check>
            <Check ok={!!state?.pairedAt}>Google Messages connected to your phone</Check>
          </div>
          <ol className="flex flex-col gap-2">
            <Numbered n={1}>
              In Chrome, open Google Messages and scan the QR code with your phone (Messages › your profile › Device
              pairing). Leave <b>Remember this computer</b> on.
            </Numbered>
            <Numbered n={2}>
              Click <b>Sync now</b>. Keepr opens Google Messages and copies your texts. Keep that Chrome window visible
              until it is done.
            </Numbered>
          </ol>
          <button type="button" className={primary} onClick={() => void startSync()} disabled={starting}>
            {starting ? "Starting…" : "Sync now"}
          </button>
          {!installed && (
            <button type="button" className="text-sm text-indigo-700 hover:text-indigo-900 text-left" onClick={() => setContinued(false)}>
              Back to installing the extension
            </button>
          )}
        </>
      )}

      {step === "syncing" && (
        <>
          <h2 className="text-lg font-bold text-gray-900">Syncing your texts</h2>
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
          <h2 className="text-lg font-bold text-gray-900">Your texts are synced</h2>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-3 rounded-lg border border-gray-200">
              <div className="text-xl font-bold" data-testid="gm-chats">{job.progress.imported}</div>
              <div className="text-xs text-gray-600">chats</div>
            </div>
            <div className="p-3 rounded-lg border border-gray-200">
              <div className="text-xl font-bold" data-testid="gm-messages">{job.progress.messages}</div>
              <div className="text-xs text-gray-600">messages</div>
            </div>
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
          <h2 className="text-lg font-bold text-gray-900">The Sync did not finish</h2>
          <p className="text-sm text-gray-700">{job.error?.message || (job.state === "cancelled" ? "It was cancelled." : "Something went wrong.")}</p>
          <button type="button" className={primary} onClick={tryAgain}>
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
