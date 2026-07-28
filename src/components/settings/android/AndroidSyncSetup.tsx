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
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Guided Android install -> pair -> sync wizard for Settings.
 */
export function AndroidSyncSetup({ userId }: AndroidSyncSetupProps) {
  const { isWindows } = usePlatform();
  const [cursor, setCursor] = useState<Cursor>("install");

  // Whether the pair step was reached (a sync server may have been started) and
  // whether the wizard completed. These gate the unmount cleanup: we only stop
  // the server if the user engaged pairing but did NOT finish — we must never
  // halt an already-active/paired sync. Refs (not state) so the unmount cleanup
  // reads the latest values without re-subscribing.
  const reachedPairRef = useRef(false);
  const completedRef = useRef(false);

  const goTo = useCallback((next: Cursor) => {
    if (next === "pair") reachedPairRef.current = true;
    if (next === "done") completedRef.current = true;
    setCursor(next);
  }, []);

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
