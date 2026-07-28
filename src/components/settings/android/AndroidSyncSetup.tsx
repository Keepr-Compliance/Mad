/**
 * AndroidSyncSetup (BACKLOG-2289)
 *
 * A guided, onboarding-STYLED install -> pair -> sync wizard for the Android
 * companion, embedded in Settings (Messages section). It reuses the onboarding
 * chrome (OnboardingShell + ProgressIndicator) and the onboarding step *content*
 * (AndroidDownloadStep + AndroidComingSoonStep) via the `variant='settings'`
 * presentational flag, so setup in Settings looks and feels like a continuation
 * of first-run onboarding.
 *
 * This is a SELF-CONTAINED controller — it does NOT couple to the onboarding
 * state machine / queue. A local cursor (`install` -> `pair` -> `done`) drives a
 * synthetic `onAction` that translates the reused steps' StepActions into cursor
 * moves, and a minimal synthetic OnboardingContext forwards the real desktop
 * `userId` so the reused pairing step keeps its BACKLOG-2224 account-match
 * protection (it hashes `context.userId` into the QR + startServer call).
 *
 * Founder decision: this REPLACES the ad-hoc inline pair button in
 * ImportSourceSettings — a single guided pairing entry point.
 *
 * @module settings/android/AndroidSyncSetup
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlatform } from "../../../contexts/PlatformContext";
import logger from "../../../utils/logger";
import {
  OnboardingShell,
  ProgressIndicator,
  NavigationButtons,
} from "../../onboarding/shell";
import AndroidDownloadStep from "../../onboarding/steps/AndroidDownloadStep";
import AndroidComingSoonStep from "../../onboarding/steps/AndroidComingSoonStep";
import type { OnboardingStep } from "../../onboarding/types/components";
import type { OnboardingContext } from "../../onboarding/types/context";
import type { StepAction } from "../../onboarding/types/actions";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type Cursor = "install" | "pair" | "done";

const CURSOR_INDEX: Record<Cursor, number> = {
  install: 0,
  pair: 1,
  done: 2,
};

/**
 * BACKLOG-2323: How often the wizard polls pairing status while the QR is shown,
 * to detect a live pairing success and auto-advance off the QR. Mirrors the QR
 * step's own 3s cadence (AndroidComingSoonStep).
 */
const PAIR_POLL_INTERVAL_MS = 3000;

/**
 * BACKLOG-2323: After a live pair auto-advances the wizard to the success
 * confirmation, wait briefly so the user registers the "set up" state, then
 * (when launched as a modal) auto-dismiss. Mirrors the iPhone sync flow which
 * closes its modal on success.
 */
const AUTO_CLOSE_DELAY_MS = 2500;

/** Reused step *content* — the presentation is identical to onboarding. */
const InstallStepContent = AndroidDownloadStep.Content;
const PairStepContent = AndroidComingSoonStep.Content;

/**
 * Steps shown in the progress indicator. Only `meta.id` and `meta.progressLabel`
 * are read by ProgressIndicator, so we relabel the reused metas for the compact
 * wizard and add a synthetic terminal "Done" step.
 */
const PROGRESS_STEPS: OnboardingStep[] = [
  {
    ...AndroidDownloadStep,
    meta: { ...AndroidDownloadStep.meta, progressLabel: "Install" },
  },
  {
    ...AndroidComingSoonStep,
    meta: { ...AndroidComingSoonStep.meta, progressLabel: "Pair" },
  },
  { meta: { id: "complete", progressLabel: "Done" }, Content: () => null },
];

interface AndroidSyncSetupProps {
  /** The logged-in desktop user id (BACKLOG-2224 account-match). */
  userId: string;
  /**
   * BACKLOG-2323: Called shortly after a LIVE pairing success auto-advances the
   * wizard to the success confirmation. When launched as a modal
   * (AndroidSyncModal), this is wired to `onClose` so the modal auto-dismisses
   * once the QR has been consumed — mirroring the iPhone sync flow. Optional so
   * the embedded/non-modal usage simply stays on the success screen.
   */
  onComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Guided Android install -> pair -> sync wizard for Settings.
 */
export function AndroidSyncSetup({ userId, onComplete }: AndroidSyncSetupProps) {
  const { isWindows } = usePlatform();
  const [cursor, setCursor] = useState<Cursor>("install");

  // Whether the pair step was reached (a sync server may have been started) and
  // whether the wizard completed. These gate the unmount cleanup: we only stop
  // the server if the user engaged pairing but did NOT finish — we must never
  // halt an already-active/paired sync. Refs (not state) so the unmount cleanup
  // reads the latest values without re-subscribing.
  const reachedPairRef = useRef(false);
  const completedRef = useRef(false);

  // BACKLOG-2323: pending modal auto-close timer, cleared on unmount to avoid a
  // leak / firing after teardown (StrictMode-safe).
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goTo = useCallback((next: Cursor) => {
    if (next === "pair") reachedPairRef.current = true;
    if (next === "done") completedRef.current = true;
    setCursor(next);
  }, []);

  // BACKLOG-2323: A phone paired off the on-screen QR. Advance OFF the pair step
  // to the success confirmation (which unmounts the QR entirely) and, when
  // launched as a modal, auto-dismiss after a brief confirmation. `goTo("done")`
  // sets completedRef so the unmount cleanup leaves the now-active sync running.
  const handlePairSuccess = useCallback(() => {
    if (completedRef.current) return; // idempotent — already advanced
    goTo("done");
    if (onComplete) {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = setTimeout(() => {
        autoCloseTimerRef.current = null;
        onComplete();
      }, AUTO_CLOSE_DELAY_MS);
    }
  }, [goTo, onComplete]);

  // If a device is already paired, skip straight to the completed state so
  // returning users aren't walked back through "install the app".
  useEffect(() => {
    let cancelled = false;
    window.api.pairing
      .getStatus()
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.status?.isPaired && res.status.devices.length > 0) {
          completedRef.current = true;
          setCursor("done");
        }
      })
      .catch((err) => {
        logger.error("[AndroidSyncSetup] Failed to read pairing status:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Founder-chosen server lifecycle: on unmount, stop the sync server ONLY if
  // pairing was started but did not complete. If the user finished (or a device
  // was already paired), leave the active sync running.
  useEffect(() => {
    return () => {
      if (reachedPairRef.current && !completedRef.current) {
        window.api.localSync.stopServer().catch((err) => {
          logger.error("[AndroidSyncSetup] Failed to stop sync server:", err);
        });
      }
    };
  }, []);

  // BACKLOG-2323: While the QR/pair step is on screen, watch for a phone pairing
  // off it and auto-advance so a now-consumed QR is never left interactive. The
  // QR step (AndroidComingSoonStep) only flips its own local "Connected" chip; it
  // is the wizard that owns the cursor, so the wizard must react to advance.
  //
  // Detection: poll pairing status and compare the paired-device *set* against a
  // baseline captured on entering the pair step, advancing only when a NEW
  // deviceId appears (a genuine, fresh pair). This means a stale/unchanged paired
  // state — or an unrelated poll — never auto-advances, and "pair another device"
  // (which re-enters the pair step with the previous device still paired)
  // correctly waits for the next new device. Interval + pending async are torn
  // down on cursor change / unmount (StrictMode-safe).
  useEffect(() => {
    if (cursor !== "pair") return;

    let cancelled = false;
    let baseline: Set<string> | null = null;

    const tick = async () => {
      try {
        const res = await window.api.pairing.getStatus();
        if (cancelled) return;
        const ids = new Set(
          res.success && res.status
            ? res.status.devices.map((d) => d.deviceId)
            : []
        );
        if (baseline === null) {
          // First read after entering the pair step = the pre-pair baseline.
          baseline = ids;
          return;
        }
        for (const id of ids) {
          if (!baseline.has(id)) {
            handlePairSuccess();
            return;
          }
        }
      } catch (err) {
        logger.error("[AndroidSyncSetup] pairing watcher poll failed:", err);
      }
    };

    void tick(); // seed the baseline immediately on entering the pair step
    const interval = setInterval(tick, PAIR_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cursor, handlePairSuccess]);

  // BACKLOG-2323: clear any pending modal auto-close timer on unmount.
  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current);
    };
  }, []);

  // Minimal onboarding context — only `userId` is meaningfully consumed by the
  // reused pairing step (BACKLOG-2224). The rest are inert defaults.
  const wizardContext = useMemo<OnboardingContext>(
    () => ({
      platform: isWindows ? "windows" : "macos",
      phoneType: "android",
      emailConnected: undefined,
      connectedEmail: null,
      emailSkipped: false,
      driverSkipped: false,
      driverSetupComplete: false,
      permissionsGranted: undefined,
      termsAccepted: true,
      emailProvider: null,
      authProvider: "google",
      isNewUser: false,
      isDatabaseInitialized: true,
      userId,
      isUserVerifiedInLocalDb: true,
      isResumedFromFdaRelaunch: false,
    }),
    [userId, isWindows]
  );

  // Translate the reused steps' actions into cursor moves.
  const handleAction = useCallback(
    (action: StepAction) => {
      switch (action.type) {
        case "NAVIGATE_NEXT":
          // Emitted by AndroidDownloadStep ("I've Installed It" / "Skip").
          goTo("pair");
          break;
        case "CONTINUE_EMAIL_ONLY":
          // Emitted by AndroidComingSoonStep continue/skip button.
          goTo("done");
          break;
        case "GO_BACK_SELECT_IPHONE":
          // Hidden in the settings variant, but map defensively to "Back".
          goTo("install");
          break;
        default:
          break;
      }
    },
    [goTo]
  );

  const handleRestart = useCallback(() => {
    // BACKLOG-2323: cancel a pending modal auto-close so "Pair another device"
    // isn't yanked away mid-restart.
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }
    reachedPairRef.current = false;
    completedRef.current = false;
    setCursor("install");
  }, []);

  // Contextual navigation below the card.
  let navigationSlot: React.ReactNode = null;
  if (cursor === "pair") {
    navigationSlot = (
      <NavigationButtons
        showBack
        showNext={false}
        backLabel="Back"
        onBack={() => setCursor("install")}
      />
    );
  }

  return (
    <div
      className="rounded-lg border border-gray-200 overflow-hidden"
      data-testid="android-sync-setup"
    >
      <OnboardingShell
        containerClassName="bg-gray-50 pb-4"
        maxWidth="max-w-md"
        progressSlot={
          <ProgressIndicator steps={PROGRESS_STEPS} currentIndex={CURSOR_INDEX[cursor]} />
        }
        navigationSlot={navigationSlot}
      >
        {cursor === "install" && (
          <InstallStepContent
            context={wizardContext}
            onAction={handleAction}
            variant="settings"
          />
        )}

        {cursor === "pair" && (
          <PairStepContent
            context={wizardContext}
            onAction={handleAction}
            variant="settings"
          />
        )}

        {cursor === "done" && (
          <div className="text-center py-2" data-testid="android-sync-done">
            <div className="w-14 h-14 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-2">
              Android sync is set up
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              Open the Keepr Companion app on your Android phone and tap{" "}
              <strong>Sync Now</strong> whenever you want to import messages. Sync
              status and import filters are just below.
            </p>
            <button
              type="button"
              onClick={handleRestart}
              className="text-sm text-green-700 hover:text-green-900 underline"
            >
              Pair another device
            </button>
          </div>
        )}
      </OnboardingShell>
    </div>
  );
}

export default AndroidSyncSetup;
