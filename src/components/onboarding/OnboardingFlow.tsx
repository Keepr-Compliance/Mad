/**
 * OnboardingFlow Component
 *
 * Main orchestrator component for onboarding.
 * Uses the queue-based architecture (useOnboardingQueue) as the single source
 * of truth for step ordering and progression.
 *
 * @module onboarding/OnboardingFlow
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOnboardingQueue, type OnboardingAppState } from "./queue/useOnboardingQueue";
import { OnboardingShell } from "./shell/OnboardingShell";
import { ProgressIndicator } from "./shell/ProgressIndicator";
import { NavigationButtons } from "./shell/NavigationButtons";
import { useOptionalMachineState } from "../../appCore/state/machine";
import type { AppStateContextValue } from "../../appCore/state/machine/types";
import {
  selectPhoneType,
  selectHasEmailConnectedNullable,
  selectHasPermissionsNullable,
  selectIsDatabaseInitialized,
} from "../../appCore/state/machine/selectors";
import { logAllFlags, logStateChange } from "../../appCore/state/machine/debug";
import type { AppStateMachine } from "../../appCore/state/types";
import type { StepAction } from "./types";
import logger from '../../utils/logger';
import * as Sentry from '@sentry/electron/renderer';
import { reportDriverStillMissingAtCompletion } from './sentryOnboarding';
import { usePlatform } from '../../contexts/PlatformContext';

/**
 * Props for the OnboardingFlow component.
 */
export interface OnboardingFlowProps {
  /** App state machine for handler access and state reading */
  app: AppStateMachine;
}

/**
 * Resolved resume bundle (BACKLOG-1842 resume-at-step fix round): whether
 * we're resuming right after the FDA-grant relaunch, plus the cloud-backed
 * data needed to skip already-completed steps without replaying them.
 * Cloud-backed (Supabase user_preferences), matching phoneType/contactSources,
 * which already live there and are already readable before local DB init —
 * see permissionHandlers.ts save/consume-onboarding-resume-marker handlers.
 */
interface ResumeBundle {
  isResuming: boolean;
  phoneType: "iphone" | "android" | null;
  contactSourceSelected: boolean;
}

/** `undefined` = the cloud check hasn't resolved yet. */
type ResumeBundleState = ResumeBundle | undefined;

const NOT_RESUMING: ResumeBundle = {
  isResuming: false,
  phoneType: null,
  contactSourceSelected: false,
};

/**
 * Main onboarding orchestrator component.
 *
 * Uses the queue-based step architecture for single-source-of-truth ordering.
 * Maps StepActions to existing app handlers and manages navigation.
 *
 * Split into a guard wrapper (OnboardingFlow) and an inner component
 * (OnboardingFlowInner) so that React hooks are never called after
 * conditional early returns — satisfying the Rules of Hooks.
 */
export function OnboardingFlow({ app }: OnboardingFlowProps) {
  // Access state machine state when feature flag is enabled
  const machineState = useOptionalMachineState();

  // userId is available once the state machine reaches "onboarding" (it
  // carries `user` from AUTH_LOADED). Needed before the resume check can run.
  // Defensive `?.` on `user` itself: some test mocks (and defensively, any
  // future state shape) may set status:"onboarding" without a full user
  // object populated yet — treat that the same as "not available".
  const userId =
    machineState?.state.status === "onboarding" ? (machineState.state.user?.id ?? null) : null;

  // BACKLOG-1842 (resume-at-step fix round): resolve the resume bundle ONCE,
  // before the queue-based flow ever builds its first queue. Three cloud
  // reads in parallel:
  //   1. consumeOnboardingResumeMarker — single-use "did we just relaunch for
  //      an FDA grant" flag (Supabase user_preferences.onboarding.resumeStep)
  //   2. getPhoneTypeCloud — phoneType, so phone-type isn't replayed
  //   3. preferences.get — contactSources.direct presence, so contact-source
  //      isn't replayed
  // All three are Supabase-direct reads (supabaseService.getPreferences),
  // independent of local DB init — same mechanism ContactSourceStep and
  // usePhoneTypeApi already use to write this data, so no new local store is
  // needed. Resolving here, before OnboardingFlowInner (and therefore
  // useOnboardingQueue) ever mounts, means the seeded manuallyCompletedIds
  // lazy-initializer sees the bundle on its very first render.
  const [resumeBundle, setResumeBundle] = useState<ResumeBundleState>(undefined);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      try {
        const markerResult = await window.api.system.consumeOnboardingResumeMarker({ userId });
        if (cancelled) return;

        if (markerResult.resumeStep !== "permissions") {
          setResumeBundle(NOT_RESUMING);
          return;
        }

        const [phoneTypeResult, preferencesResult] = await Promise.all([
          window.api.user.getPhoneTypeCloud(userId).catch(
            () => ({ success: false, phoneType: undefined }) as { success: boolean; phoneType?: "iphone" | "android" }
          ),
          window.api.preferences.get(userId).catch(
            () => ({ success: false, preferences: undefined }) as { success: boolean; preferences?: Record<string, unknown> }
          ),
        ]);
        if (cancelled) return;

        const phoneType: "iphone" | "android" | null = phoneTypeResult.phoneType ?? null;
        const preferences = preferencesResult.preferences as
          | { contactSources?: { direct?: unknown } }
          | undefined;
        const contactSourceSelected = Boolean(preferences?.contactSources?.direct);

        logger.info("[OnboardingFlow] Resuming onboarding from cloud marker", {
          phoneType,
          contactSourceSelected,
        });

        setResumeBundle({ isResuming: true, phoneType, contactSourceSelected });
      } catch (error) {
        if (cancelled) return;
        logger.debug("[OnboardingFlow] Resume bundle resolution failed (non-fatal):", error);
        setResumeBundle(NOT_RESUMING);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Runs once per userId becoming available — the marker is single-use, so
    // a second consume for the same userId would always return null anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // LOADING GATE: Don't render until state machine has finished loading, or
  // (once a userId exists) until the resume bundle has resolved. Both cloud
  // reads are direct Supabase calls (no local DB dependency), so this should
  // never be visibly slow.
  if (!machineState || machineState.state.status === "loading") {
    return null;
  }
  if (userId && resumeBundle === undefined) {
    return null;
  }

  // Early exit if state machine is already in "ready" state
  if (machineState.state.status === "ready") {
    return null;
  }

  return (
    <OnboardingFlowInner
      app={app}
      machineState={machineState}
      resumeBundle={resumeBundle ?? NOT_RESUMING}
    />
  );
}

interface OnboardingFlowInnerProps {
  app: AppStateMachine;
  machineState: AppStateContextValue;
  /** Resolved resume bundle — isResuming is false for a normal onboarding start. */
  resumeBundle: ResumeBundle;
}

function OnboardingFlowInner({ app, machineState, resumeBundle }: OnboardingFlowInnerProps) {
  // BACKLOG-1919: Renderer-safe platform detection. `usePlatform()` sources its
  // value from the main process via window.api (IPC), which works under
  // contextIsolation — unlike `process.platform`, which is undefined here
  // because the renderer runs with nodeIntegration:false/contextIsolation:true.
  const { isMacOS, isWindows } = usePlatform();

  // Track if we're waiting for DB init to complete after clicking Continue on secure-storage.
  // Event-driven: subscribes to onInitStage events instead of polling.
  const [waitingForDbInit, setWaitingForDbInit] = useState(false);

  // Tracks the actual DB init status confirmed by init stage events.
  const [dbInitConfirmed, setDbInitConfirmed] = useState(false);

  // Track if user has been verified in local DB (set by account-verification step).
  // BACKLOG-1842: seeded true when resuming from the cloud marker — the user
  // already passed account-verification before the FDA relaunch (it precedes
  // permissions in the flow), so re-verifying would just be a redundant
  // ~1.2s flash. Lazy initializer — resumeBundle is stable for this mount.
  const [isUserVerifiedInLocalDb, setIsUserVerifiedInLocalDb] = useState(
    () => resumeBundle.isResuming
  );

  // Track if user explicitly skipped email connection or driver setup
  const [emailSkipped, setEmailSkipped] = useState(false);
  const [driverSkipped, setDriverSkipped] = useState(false);

  // Ref guard to prevent duplicate init stage subscriptions (per LoadingOrchestrator pattern)
  const initStageSubscribedRef = useRef(false);

  // BACKLOG-1842 (resume-at-step fix round): seed the reducer's
  // selectedPhoneType from the resume bundle so phone-type's context-driven
  // isComplete (phoneType !== null) is satisfied on the very first queue
  // build — no replay of the phone-type step. Fires once per mount (the
  // bundle is resolved before OnboardingFlowInner ever mounts, so there is
  // exactly one opportunity to apply it).
  const resumeMarkerAppliedRef = useRef(false);
  useEffect(() => {
    if (resumeMarkerAppliedRef.current) return;
    resumeMarkerAppliedRef.current = true;
    if (resumeBundle.isResuming && resumeBundle.phoneType) {
      machineState.dispatch({
        type: "RESUME_MARKER_APPLIED",
        phoneType: resumeBundle.phoneType,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build app state, deriving from state machine when available
  const appState: OnboardingAppState = useMemo(() => {
    if (machineState) {
      const { state } = machineState;
      const selectorSaysDbInit = selectIsDatabaseInitialized(state);
      // Simplified: the state machine now receives init stage events and only sets
      // isDatabaseInitialized after 'db-ready' or 'complete'. For deferred-DB-init
      // (first-time macOS), we gate on dbInitConfirmed from event subscription.
      const isDatabaseInitialized = selectorSaysDbInit && (!waitingForDbInit || dbInitConfirmed);
      const emailConnected = selectHasEmailConnectedNullable(state);
      const hasPermissions = selectHasPermissionsNullable(state);

      // DEBUG: Comprehensive flag logging
      logAllFlags('OnboardingFlow.appState', {
        status: state.status,
        step: (state as any).step,
        hasEmailConnected: (state as any).hasEmailConnected,
        hasPermissions: (state as any).hasPermissions,
        hasCompletedEmailOnboarding: (state as any).hasCompletedEmailOnboarding,
        isDatabaseInitialized,
        phoneType: selectPhoneType(state),
        emailConnected,
        permissionsGranted: hasPermissions,
        isNewUser: app.isNewUserFlow,
      });

      logStateChange('OnboardingFlow', 'BUILDING_APP_STATE', {
        'state.status': state.status,
        'state.hasEmailConnected (raw)': (state as any).hasEmailConnected,
        'emailConnected (selector)': emailConnected,
        'hasPermissions': hasPermissions,
        'isDatabaseInitialized': isDatabaseInitialized,
        'emailStep shouldShow': emailConnected !== true,
        'permissionsStep shouldShow': hasPermissions !== true,
      });

      return {
        phoneType: selectPhoneType(state),
        emailConnected,
        connectedEmail: app.currentUser?.email ?? null,
        emailProvider: app.pendingOnboardingData?.emailProvider ?? null,
        hasPermissions,
        hasSecureStorage: app.hasSecureStorageSetup,
        driverSetupComplete: !app.needsDriverSetup,
        termsAccepted: !app.needsTermsAcceptance,
        authProvider: (app.pendingOAuthData?.provider ?? app.authProvider) as "google" | "microsoft" ?? "google",
        isNewUser: app.isNewUserFlow,
        isDatabaseInitialized,
        userId: app.currentUser?.id ?? null,
        isUserVerifiedInLocalDb,
        emailSkipped,
        driverSkipped,
        isResumedFromFdaRelaunch: resumeBundle.isResuming,
      };
    }

    // Legacy fallback - use app properties directly
    logger.debug('[OnboardingFlow] Using LEGACY path - machineState is null');
    return {
      phoneType: app.selectedPhoneType,
      emailConnected: app.hasEmailConnected,
      connectedEmail: app.currentUser?.email ?? null,
      emailProvider: app.pendingOnboardingData?.emailProvider ?? null,
      hasPermissions: app.hasPermissions,
      hasSecureStorage: app.hasSecureStorageSetup,
      driverSetupComplete: !app.needsDriverSetup,
      termsAccepted: !app.needsTermsAcceptance,
      authProvider: (app.pendingOAuthData?.provider ?? app.authProvider) as "google" | "microsoft" ?? "google",
      isNewUser: app.isNewUserFlow,
      isDatabaseInitialized: app.isDatabaseInitialized,
      userId: app.currentUser?.id ?? null,
      isUserVerifiedInLocalDb,
      emailSkipped,
      driverSkipped,
      isResumedFromFdaRelaunch: resumeBundle.isResuming,
    };
  }, [machineState, app, isUserVerifiedInLocalDb, emailSkipped, driverSkipped, waitingForDbInit, dbInitConfirmed, resumeBundle]);

  // Action handler that maps StepActions to existing app handlers
  const handleAction = useCallback(
    (action: StepAction) => {
      switch (action.type) {
        case "SELECT_PHONE":
          if (action.payload.phoneType === "iphone") {
            app.handleSelectIPhone();
          } else {
            app.handleSelectAndroid();
          }
          break;

        case "EMAIL_CONNECTED":
          app.handleEmailOnboardingComplete();
          break;

        case "EMAIL_SKIPPED":
          setEmailSkipped(true);
          app.handleEmailOnboardingSkip();
          break;

        case "PERMISSION_GRANTED":
          app.handlePermissionsGranted();
          break;

        case "SECURE_STORAGE_SETUP":
          if (!appState.isDatabaseInitialized) {
            setWaitingForDbInit(true);
          }
          app.handleKeychainExplanationContinue();
          break;

        case "DRIVER_SETUP_COMPLETE":
          app.handleAppleDriverSetupComplete();
          break;

        case "DRIVER_SKIPPED":
          setDriverSkipped(true);
          app.handleAppleDriverSetupSkip();
          break;

        case "TERMS_ACCEPTED":
          app.handleAcceptTerms();
          break;

        case "TERMS_DECLINED":
          app.handleDeclineTerms();
          break;

        case "GO_BACK_SELECT_IPHONE":
          app.handleAndroidGoBack();
          // Reset state machine's selectedPhoneType so the queue rebuilds
          // with phone-type as the active step
          if (machineState) {
            machineState.dispatch({ type: "PHONE_TYPE_RESET" });
          }
          break;

        case "CONTINUE_EMAIL_ONLY":
          // BACKLOG-1455: No-op here — the queue handles CONTINUE_EMAIL_ONLY
          // navigation via goToNext() in useOnboardingQueue.
          break;

        case "CONNECT_EMAIL_START":
          if (action.payload.provider === "google") {
            app.handleStartGoogleEmailConnect();
          } else {
            app.handleStartMicrosoftEmailConnect();
          }
          break;

        case "USER_VERIFIED_IN_LOCAL_DB":
          setIsUserVerifiedInLocalDb(true);
          break;

        case "NAVIGATE_NEXT":
        case "NAVIGATE_BACK":
        case "ONBOARDING_COMPLETE":
          // These are handled by the queue hook's internal navigation
          break;
      }
    },
    [app, appState.isDatabaseInitialized, machineState]
  );

  // Handle onboarding completion - dispatches ONBOARDING_QUEUE_DONE
  // The queue tracks step completion via isComplete predicates, so we only
  // need to dispatch the single ONBOARDING_QUEUE_DONE action to transition
  // the state machine from "onboarding" to "ready".
  const handleComplete = useCallback(() => {
    if (!machineState || machineState.state.status !== "onboarding") return;

    const { dispatch } = machineState;

    // BACKLOG-1919 (scope d): If an iPhone user finishes onboarding on Windows
    // with the Apple driver STILL not installed, the driver step failed (skipped
    // or UAC declined) and they'll hit the Connect-iPhone recovery path. Emit a
    // Sentry event so we can measure that onboarding-failure rate. Fire-and-forget
    // and fully non-blocking — a failed check must never hold up completion.
    // Uses the top-level `isWindows` from usePlatform() (renderer-safe) rather
    // than `process.platform`, which is undefined in this sandboxed renderer.
    if (isWindows && appState.phoneType === "iphone") {
      void (async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const drivers = (window.api as any)?.drivers as
            | { checkApple?: () => Promise<{ isInstalled: boolean }> }
            | undefined;
          if (!drivers?.checkApple) return;
          const status = await drivers.checkApple();
          if (status.isInstalled === false) {
            logger.warn(
              "[OnboardingFlow] Completing onboarding with Apple driver still missing (iPhone user)",
            );
            reportDriverStillMissingAtCompletion({ driverSkipped });
          }
        } catch (err) {
          logger.debug("[OnboardingFlow] Driver completion check failed (non-fatal):", err);
        }
      })();
    }

    // BACKLOG-1817: Fire the INITIAL import of local (macOS) contact sources at
    // onboarding completion. Outlook/Google ride the BACKLOG-1759 post-connect
    // trigger, but local sources have no "connect moment." The recurring
    // auto-refresh that would otherwise cover them (useAutoRefresh, gated by the
    // `sync.autoSyncOnLogin` preference, default treated as ON via `!== false`)
    // is *suppressed during onboarding* (its effect returns early while
    // isOnboarding is true) and only runs once the user reaches the dashboard —
    // so a macOS-only fresh install never gets a guaranteed first import. This
    // mirrors the working manual "Settings → Import" path, which calls the same
    // window.api.contacts.syncExternal. That handler self-gates on the per-source
    // `macosContacts` *enabled* preference (so a user who deselected macOS is a
    // no-op) and does NOT consult autoSyncOnLogin — exactly the initial-vs-
    // recurring separation this task requires.
    //
    // Fire-and-forget and fully non-blocking: an import error must never delay or
    // fail onboarding completion. Renderer-safe platform gate via usePlatform()
    // (isMacOS), never process.platform (undefined in the sandboxed renderer).
    if (isMacOS) {
      const userId = app.currentUser?.id ?? null;
      if (userId) {
        void (async () => {
          try {
            const result = await window.api.contacts.syncExternal(userId);
            if (result?.success) {
              logger.info(
                `[OnboardingFlow] BACKLOG-1817 initial local-source import complete: inserted=${result.inserted ?? 0}`,
              );
            } else {
              logger.warn(
                "[OnboardingFlow] BACKLOG-1817 initial local-source import did not complete",
                result?.error,
              );
            }
          } catch (err) {
            logger.warn(
              "[OnboardingFlow] BACKLOG-1817 initial local-source import failed (non-fatal):",
              err,
            );
          }
        })();
      }
    }

    logger.info("[OnboardingFlow] Queue complete — dispatching ONBOARDING_QUEUE_DONE");
    dispatch({ type: "ONBOARDING_QUEUE_DONE" });
  }, [machineState, appState.phoneType, driverSkipped, isWindows, isMacOS, app]);

  // BACKLOG-1842 (resume-at-step fix round): steps to seed as already
  // complete when resuming from the cloud marker. account-verification is
  // seeded via isUserVerifiedInLocalDb above (it's context-driven);
  // contact-source and data-sync have no context-derivable isComplete (both
  // are `() => false` by design — see ContactSourceStep/DataSyncStep meta),
  // so they can only be marked complete via manuallyCompletedIds. data-sync
  // re-running is cheap and idempotent (it just re-pulls phone_type from
  // cloud) but we still skip it on resume since reaching `permissions` (the
  // step immediately after data-sync) guarantees it already ran once this
  // onboarding session. Computed once via useMemo — resumeBundle is stable
  // for this mount (OnboardingFlow only mounts OnboardingFlowInner after the
  // bundle resolves).
  const initialManuallyCompletedIds = useMemo(() => {
    if (!resumeBundle.isResuming) return undefined;
    const ids: string[] = ["data-sync"];
    if (resumeBundle.contactSourceSelected) {
      ids.push("contact-source");
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Initialize the queue hook
  const queue = useOnboardingQueue({
    appState,
    onAction: handleAction,
    onComplete: handleComplete,
    initialManuallyCompletedIds,
  });

  const {
    visibleEntries,
    activeEntry,
    activeStep,
    currentIndex,
    isComplete,
    context,
    goToNext,
    goToPrevious,
    handleAction: queueHandleAction,
    handleSkip,
    isFirstStep,
    canSkip,
    isNextDisabled,
    isViewingPastStep,
  } = queue;

  // Event-driven DB init confirmation (BACKLOG-1383).
  // Subscribes to onInitStage events instead of polling system:is-database-initialized.
  // When 'complete' event arrives, confirms DB is ready and unblocks the queue.
  useEffect(() => {
    if (!waitingForDbInit) return;

    // Guard against duplicate subscriptions
    if (initStageSubscribedRef.current) return;

    // First, check current stage in case init already completed
    const checkCurrentStage = async () => {
      try {
        const currentStage = await window.api?.system?.getInitStage?.();
        if (currentStage && (currentStage.stage === 'complete' || currentStage.stage === 'db-ready')) {
          logStateChange('OnboardingFlow', 'DB_INIT_CONFIRMED by current init stage', { stage: currentStage.stage });
          Sentry.addBreadcrumb({
            category: 'onboarding.init',
            message: `DB init already complete on check: ${currentStage.stage}`,
            level: 'info',
          });
          setDbInitConfirmed(true);
          setWaitingForDbInit(false);
          return true; // Already complete, no need to subscribe
        }
      } catch {
        // getInitStage may not be available — fall through to subscription
      }
      return false;
    };

    let cancelled = false;

    checkCurrentStage().then((alreadyComplete) => {
      if (cancelled || alreadyComplete) return;

      // Subscribe to init stage events
      if (!window.api?.system?.onInitStage) {
        // Fallback: if onInitStage not available, use legacy polling once
        logger.warn('[OnboardingFlow] onInitStage not available, falling back to isDatabaseInitialized check');
        window.api?.system?.isDatabaseInitialized?.().then((ready) => {
          if (ready && !cancelled) {
            logStateChange('OnboardingFlow', 'DB_INIT_CONFIRMED by legacy check', {});
            setDbInitConfirmed(true);
            setWaitingForDbInit(false);
          }
        }).catch(() => { /* ignore */ });
        return;
      }

      initStageSubscribedRef.current = true;

      const unsubscribe = window.api.system.onInitStage((event) => {
        if (cancelled) return;

        Sentry.addBreadcrumb({
          category: 'onboarding.init',
          message: `Init stage received during onboarding: ${event.stage}`,
          level: 'info',
          data: { stage: event.stage, message: event.message },
        });

        if (event.stage === 'complete' || event.stage === 'db-ready') {
          logStateChange('OnboardingFlow', 'DB_INIT_CONFIRMED by init stage event', { stage: event.stage });
          setDbInitConfirmed(true);
          setWaitingForDbInit(false);
        }
      });

      // Store cleanup for the effect's return
      cleanupRef.current = () => {
        unsubscribe();
        initStageSubscribedRef.current = false;
      };
    });

    // Mutable ref to hold the event unsubscribe cleanup
    const cleanupRef = { current: () => {} };

    return () => {
      cancelled = true;
      cleanupRef.current();
      initStageSubscribedRef.current = false;
    };
  }, [waitingForDbInit]);

  // When queue reports complete but state machine is still in onboarding,
  // trigger completion
  const hasNavigatedRef = useRef(false);
  useEffect(() => {
    if (isComplete && !hasNavigatedRef.current && machineState) {
      hasNavigatedRef.current = true;
      handleComplete();
    }
  }, [isComplete, machineState, handleComplete]);

  // Return null when no steps or no active step - prevents flicker
  if (visibleEntries.length === 0 || !activeEntry || !activeStep) {
    return null;
  }

  // Get navigation config with defaults.
  // When viewing a past step via back navigation, always show Continue
  // so the user can navigate forward (even for auto-advance steps like
  // account-verification that normally hide Continue).
  const navigation = activeStep.meta.navigation ?? {};
  const showBack = navigation.showBack !== false && !isFirstStep;
  const showNext = isViewingPastStep || navigation.hideContinue !== true;

  return (
    <OnboardingShell
      progressSlot={
        <ProgressIndicator
          steps={visibleEntries.map(e => e.step)}
          currentIndex={currentIndex}
        />
      }
      navigationSlot={
        <NavigationButtons
          showBack={showBack}
          showNext={showNext}
          skipConfig={canSkip ? activeStep.meta.skip : undefined}
          nextLabel={navigation.continueLabel}
          backLabel={navigation.backLabel}
          nextDisabled={isNextDisabled}
          onBack={goToPrevious}
          onNext={goToNext}
          onSkip={handleSkip}
        />
      }
    >
      <activeStep.Content
        key={activeStep.meta.id}
        context={context}
        onAction={queueHandleAction}
        isLoading={activeStep.meta.id === 'secure-storage' && waitingForDbInit}
      />
    </OnboardingShell>
  );
}

export default OnboardingFlow;
