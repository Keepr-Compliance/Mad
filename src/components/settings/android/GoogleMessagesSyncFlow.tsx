/**
 * Dashboard → Sync Android → Google Messages (BACKLOG-3659), as the
 * founder-approved storyboards (2026-10-04):
 *
 *   install  J01 (beta: "Add the Keepr extension", 3 lines, Open Chrome,
 *            Waiting for the extension…) or A02 (Chrome Web Store: Add to
 *            Chrome) — see extensionDistribution.ts
 *   connect  not linked: the link card (D01: Link your browser, 1 Open Google
 *            Messages, 2 Type the code from Chrome → Linked ✓, Sync now);
 *            linked: B02 (Sync Android, Linked with your browser ✓, Sync now)
 *   syncing  the live stage (the page box is where the user looks)
 *   done     A11 (✓ Your texts are synced, the one count line, Done)
 *   failed   Sync failed, the reason, Try again
 *
 * The step comes from googleMessagesStep(); the extension is detected by its
 * hello (polled every 3 s while this flow is open).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { rcsImportService } from "../../../services/rcsImportService";
import { settingsService } from "../../../services/settingsService";
import type { RcsExtensionState, RcsJobInfo } from "../../../../electron/types/ipc/window-api-rcs-import";
import { doneSummaryLines, googleMessagesStep } from "./googleMessagesSyncSteps";
import { LinkBrowserPanel } from "./LinkBrowserPanel";
import { syncFailureLine } from "./syncFailureLines";
import { EXTENSION_PUBLISHED, readBetaInstallPreference, wantsBetaInstall } from "./extensionDistribution";

const POLL_MS = 3000;

interface GoogleMessagesSyncFlowProps {
  onClose: () => void;
  /** "Use another texting app?": switch to the Keepr companion app flow. */
  onUseCompanion?: () => void;
  /** Kept for the modal's API (Settings › Messages); the storyboards show no link here. */
  onOpenSettings?: () => void;
  /** The signed-in user (the "Beta extension install" preference). */
  userId?: string;
  /** Test seam: the poll interval. */
  pollMs?: number;
  /** Test seam: the extension is in the Chrome Web Store (default EXTENSION_PUBLISHED). */
  published?: boolean;
  /** Opened at the link step (Settings' Link / Relink, keepr://link) — even when linked. */
  startAtLink?: boolean;
}

/** The storyboards' numbered circle: 28px, #EEF0FF / #312E81. */
function StepNumber({ n }: { n: number }) {
  return (
    <div className="w-7 h-7 flex-shrink-0 rounded-full bg-[#EEF0FF] text-[#312E81] text-[14px] font-bold flex items-center justify-center">{n}</div>
  );
}

const title = "text-[22px] leading-7 font-bold text-[#1F2433]";
const primary =
  "w-full min-h-[48px] px-5 border-0 rounded-[10px] bg-[#4F46E5] hover:bg-[#4338CA] text-white text-[15px] font-bold disabled:opacity-50 disabled:cursor-not-allowed";
const secondary =
  "w-full min-h-[44px] px-4 rounded-[10px] border border-[#CDD1DE] bg-white hover:bg-gray-50 text-[#1F2433] text-[15px] font-semibold";

/** Founder (D05): the green ✓ in the field shows this long before the linked screen. */
export const LINKED_FLASH_MS = 1000;

/**
 * Founder (B2): the note under Sync now — "Syncs your last 1.5 months of
 * texts." (12 → "your last year", 1 → "your last month", All time → "Syncs
 * all your texts.").
 */
export function syncWindowNote(months: number | null | undefined): string {
  if (months === null) return "Syncs all your texts.";
  if (typeof months !== "number") return "Syncs your recent texts.";
  if (months === 12) return "Syncs your last year of texts.";
  if (months === 1) return "Syncs your last month of texts.";
  return `Syncs your last ${months} months of texts.`;
}

function prefersReducedMotion(): boolean {
  try {
    return !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function GoogleMessagesSyncFlow({
  onClose,
  onUseCompanion,
  onOpenSettings,
  userId,
  pollMs = POLL_MS,
  published = EXTENSION_PUBLISHED,
  startAtLink = false,
}: GoogleMessagesSyncFlowProps) {
  const [state, setState] = useState<RcsExtensionState | null>(null);
  const [job, setJob] = useState<RcsJobInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  /**
   * Founder (D05): a code just linked — the field's green ✓ for
   * LINKED_FLASH_MS ("flash"), then the linked screen ("done"); at once under
   * reduced motion.
   */
  const [linkFlash, setLinkFlash] = useState<"none" | "flash" | "done">("none");
  const onJustLinked = useCallback(() => {
    if (prefersReducedMotion()) {
      setLinkFlash("done");
      return;
    }
    setLinkFlash("flash");
    setTimeout(() => setLinkFlash("done"), LINKED_FLASH_MS);
  }, []);
  const [betaPref, setBetaPref] = useState(false);
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

  // The account's "Beta extension install" preference.
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void settingsService
      .getPreferences(userId)
      .then((r) => {
        if (live && r?.success) setBetaPref(readBetaInstallPreference(r.data));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [userId]);

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

  const step = googleMessagesStep({ state, job, continued: false });
  /** BACKLOG-3666: the extension linked with THIS Keepr (a Sync is refused until then). */
  const keeprPaired = state?.extensionPaired === true;
  const doneLines = step === "done" && job ? doneSummaryLines(job) : null;
  const beta = wantsBetaInstall(betaPref, published);
  /** The link card: not linked, Relink, or a code's green ✓ still showing. */
  const showLinkCard = linkFlash === "flash" || ((!keeprPaired || startAtLink) && linkFlash !== "done");
  // Founder (B2): "Syncs your last N months of texts. Change" — never while
  // a Sync runs (the syncing step shows none).
  const windowNote = (
    <p className="text-[13px] text-[#4B5563]" data-testid="gm-window-note">
      {syncWindowNote(state?.lookbackMonths)}{" "}
      {onOpenSettings && (
        <button type="button" className="text-indigo-700 hover:text-indigo-900 font-medium" onClick={onOpenSettings} data-testid="gm-window-change">
          Change
        </button>
      )}
    </p>
  );
  const stepRef = useRef(step);
  stepRef.current = step;
  const preparedRef = useRef(false);

  // Beta: the extension goes to Downloads as soon as the install step shows —
  // once per flow. A failure is shown only while on the install step.
  useEffect(() => {
    if (step !== "install" || !beta || preparedRef.current) return;
    preparedRef.current = true;
    void rcsImportService.prepareExtension().then((r) => {
      if (!r.success && stepRef.current === "install") setError(r.error ?? "Keepr could not prepare the extension.");
    });
  }, [step, beta]);

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
      {step === "install" && beta && (
        <>
          {/* J01 (beta): nothing else — no paragraphs, no warning. */}
          <div className="text-[12px] font-semibold tracking-[0.05em] text-[#6B7280]" data-testid="gm-beta-label">
            BETA
          </div>
          <h2 className={`${title} -mt-2`}>Add the Keepr extension</h2>
          <div className="flex flex-col gap-3" data-testid="gm-install-steps">
            <div className="flex gap-3 items-center">
              <StepNumber n={1} />
              <div className="text-[15px]">Open Chrome, paste the address, press Enter</div>
            </div>
            <div className="flex gap-3 items-center">
              <StepNumber n={2} />
              <div className="text-[15px]">
                Turn on <b>Developer mode</b>
              </div>
            </div>
            <div className="flex gap-3 items-center">
              <StepNumber n={3} />
              <div className="text-[15px]">
                <b>Load unpacked</b> › Downloads › <b>Keepr Extension</b>
              </div>
            </div>
          </div>
          <button type="button" className={primary} onClick={() => void rcsImportService.openChromeForExtension()} data-testid="gm-open-chrome">
            Open Chrome (address copied)
          </button>
          <div className="flex items-center gap-2 text-[14px] text-[#6B7280]" role="status" data-testid="gm-detect">
            <span className="w-2 h-2 rounded-full bg-[#F5A524]" aria-hidden="true" />
            Waiting for the extension…
          </div>
        </>
      )}

      {step === "install" && !beta && (
        <>
          {/* A02: the Chrome Web Store. */}
          <h2 className={title}>Install the Keepr extension</h2>
          <p className="text-[14px] text-[#4B5563]">For Chrome. Takes a minute.</p>
          <button type="button" className={primary} onClick={() => void rcsImportService.openExtensionStore()} data-testid="gm-add-to-chrome">
            Add to Chrome
          </button>
          {onUseCompanion && (
            <button type="button" className="self-start text-[14px] text-[#4338CA] hover:text-[#3730A3]" onClick={onUseCompanion}>
              Use another texting app?
            </button>
          )}
        </>
      )}

      {step === "connect" && showLinkCard && (
        // D01: the link card IS this step (the modal gives it its frame).
        // Relink: the same card; the old link goes only when the new code succeeds.
        <LinkBrowserPanel bare onJustLinked={onJustLinked} />
      )}

      {step === "connect" && !showLinkCard && (
        // B02 / I02 / D05 after the flash: ONE linked screen. The modal keeps
        // its standard size; the row + Sync now sit centred in the body.
        <div className="flex flex-col gap-4 min-h-[360px]" data-testid="gm-linked-screen">
          <h2 className={title}>Sync Android</h2>
          <div className="flex-1 flex flex-col justify-center gap-4" data-testid="gm-linked-body">
            <div className="flex items-center gap-2 p-3 rounded-[10px] border border-[#E5E7EB] text-[14px] text-[#111827]" data-testid="gm-linked-row">
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="#4F46E5" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12l5 5 9-10" />
              </svg>
              <span>Linked with your browser</span>
            </div>
            <button type="button" className={primary} onClick={() => void startSync()} disabled={starting} data-testid="gm-sync-now">
              {starting ? "Starting…" : "Sync now"}
            </button>
          </div>
          {windowNote}
        </div>
      )}

      {step === "syncing" && (
        <>
          <h2 className={title}>{job?.readingOlder ? "Reading older texts…" : "Syncing your texts"}</h2>
          <p className="text-[14px] text-[#374151]" role="status" data-testid="gm-stage">
            {job?.stage || "Waiting for Google Messages to open in Chrome"}
          </p>
          <p className="text-[13px] text-[#4B5563]">Keep the Google Messages tab open until it is done.</p>
          <button type="button" className={secondary} onClick={() => void cancel()}>
            Stop sync
          </button>
        </>
      )}

      {step === "done" && job && (
        <>
          {/* A11 / B05. */}
          <div className="flex items-center gap-2.5">
            {doneLines && (
              <div className="w-8 h-8 rounded-full bg-[#15803D] text-white font-extrabold flex items-center justify-center" aria-hidden="true">
                ✓
              </div>
            )}
            <h2 className={title}>{doneLines ? "Your texts are synced" : "Saving your texts…"}</h2>
          </div>
          {/* What Keepr SAVED (not what the page sent). */}
          <div className="p-3 rounded-[10px] border border-[#E5E7EB] text-[14px] text-[#1F2937]" role="status" data-testid="gm-done-summary">
            {(doneLines ?? ["Keepr is saving what it copied. This takes a moment."]).join(" ")}
          </div>
          {doneLines && <p className="text-[13px] text-[#4B5563]">Added to your transactions by phone number.</p>}
          <button type="button" className={primary} onClick={onClose}>
            Done
          </button>
          {doneLines && windowNote}
        </>
      )}

      {step === "failed" && job && (
        <>
          <h2 className={title}>{job.state === "failed" ? "Sync failed" : "Sync stopped"}</h2>
          <p className="text-[14px] text-[#374151]">
            {job.state === "cancelled" ? "Nothing from this run was saved." : syncFailureLine(job.error?.code)}
          </p>
          <button
            type="button"
            className={primary}
            onClick={job.state === "failed" ? () => void retryFailed() : tryAgain}
            disabled={starting}
            data-testid="gm-try-again"
          >
            Try again
          </button>
          {windowNote}
        </>
      )}

      {error && (
        <p className="text-[14px] text-[#B42318]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
