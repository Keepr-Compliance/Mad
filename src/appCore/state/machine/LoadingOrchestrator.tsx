/**
 * Loading Orchestrator Component
 *
 * Coordinates the app initialization sequence by orchestrating
 * loading phases in order and dispatching actions to the state machine.
 *
 * Initialization sequence:
 * 1. Check storage - Verify encryption key store exists
 * 2. Initialize DB - Set up secure database
 * 3. Load auth - Check authentication state
 * 4. Load user data - Load user preferences
 *
 * @module appCore/state/machine/LoadingOrchestrator
 */

import React, { useEffect, useRef, useCallback } from "react";
import * as Sentry from "@sentry/electron/renderer";
import { useAppState } from "./useAppState";
import { LoadingScreen } from "./components/LoadingScreen";
import { ErrorScreen } from "./components/ErrorScreen";
import {
  detectPlatform,
  autoInitializesStorage,
} from "./utils/platformInit";
import { waitForApi } from "./utils/waitForApi";
import { useAuth } from "../../../contexts";
import type { PlatformInfo, User, UserData } from "./types";
import logger from "../../../utils/logger";

interface LoadingOrchestratorProps {
  children: React.ReactNode;
}

/**
 * Orchestrates the app initialization sequence.
 * Coordinates: storage check -> DB init -> auth -> user data
 *
 * Each phase runs in a useEffect that checks BOTH status AND phase
 * to prevent duplicate calls and race conditions.
 */
export function LoadingOrchestrator({
  children,
}: LoadingOrchestratorProps): React.ReactElement {
  const { state, dispatch, loadingPhase } = useAppState();
  const { login } = useAuth();

  // Track auth data across phases (needed for USER_DATA_LOADED context)
  const authDataRef = useRef<{
    user: User | null;
    platform: PlatformInfo;
  } | null>(null);

  // Detect platform once at startup (cached in ref to avoid re-detection)
  const platformRef = useRef(detectPlatform());

  // Helper to dispatch API_NOT_READY error (used by all phases)
  const dispatchApiNotReady = useCallback(
    (err: unknown) => {
      dispatch({
        type: "ERROR",
        error: {
          code: "API_NOT_READY",
          message: err instanceof Error ? err.message : String(err),
        },
        recoverable: true,
      });
    },
    [dispatch]
  );

  // Get full platform info including hasIPhone (determined during onboarding)
  const getPlatformInfo = (): PlatformInfo => ({
    ...platformRef.current,
    hasIPhone: false, // Determined during onboarding
  });

  // ============================================
  // PHASE 1: Check storage
  // ============================================
  useEffect(() => {
    /* console.log("[LoadingOrchestrator] Phase 1 effect triggered", {
      status: state.status,
      loadingPhase,
    }); */

    // Guard: only run in the correct phase
    if (state.status !== "loading" || loadingPhase !== "checking-storage") {
      // console.log("[LoadingOrchestrator] Phase 1 skipped - not in checking-storage phase");
      return;
    }

    // console.log("[LoadingOrchestrator] PHASE 1: Starting storage check...");
    let cancelled = false;

    const platform = platformRef.current;
    // console.log("[LoadingOrchestrator] Platform detected:", platform);

    const runPhase = async () => {
      try {
        await waitForApi();
      } catch (err) {
        if (!cancelled) dispatchApiNotReady(err);
        return;
      }

      if (cancelled) return;

      window.api.system
        .hasEncryptionKeyStore()
        .then((result) => {
          // console.log("[LoadingOrchestrator] PHASE 1: Storage check result:", result);
          if (cancelled) return;
          // console.log("[LoadingOrchestrator] PHASE 1: Dispatching STORAGE_CHECKED", { hasKeyStore: result.hasKeyStore });
          dispatch({
            type: "STORAGE_CHECKED",
            hasKeyStore: result.hasKeyStore,
            isMacOS: platform.isMacOS,
          });
        })
        .catch((error: Error) => {
          // console.error("[LoadingOrchestrator] PHASE 1: Storage check FAILED:", error);
          if (cancelled) return;
          dispatch({
            type: "ERROR",
            error: {
              code: "STORAGE_CHECK_FAILED",
              message: error.message || "Failed to check storage",
            },
            recoverable: true,
          });
        });
    };

    runPhase();

    return () => {
      cancelled = true;
    };
  }, [state.status, loadingPhase, dispatch, dispatchApiNotReady]);

  // ============================================
  // PHASE 1.5: Pre-DB auth validation (TASK-2086, SOC 2 CC6.1)
  // Validates auth token BEFORE database decryption to ensure
  // data is only accessible to currently authorized users.
  // ============================================
  useEffect(() => {
    // Guard: only run in the correct phase
    if (state.status !== "loading" || loadingPhase !== "validating-auth") {
      return;
    }

    let cancelled = false;

    const runPhase = async () => {
      try {
        await waitForApi();
      } catch (err) {
        if (!cancelled) dispatchApiNotReady(err);
        return;
      }

      if (cancelled) return;

      // TASK-2086: Pre-DB auth validation (SOC 2 CC6.1)
      type PreAuthResult = { valid: boolean; noSession?: boolean; reason?: string };
      const auth = window.api.auth as typeof window.api.auth & {
        preValidateSession?: () => Promise<PreAuthResult>;
      };

      if (!auth.preValidateSession) {
        // Graceful fallback if preload bridge doesn't expose this method yet
        dispatch({ type: "AUTH_PRE_VALIDATED", valid: true, noSession: true });
        return;
      }

      // console.log("[PRE-AUTH][renderer] Phase 1.5: Calling preValidateSession (DB is NOT decrypted yet)");
      auth.preValidateSession()
        .then((result: { valid: boolean; noSession?: boolean; reason?: string }) => {
          if (cancelled) return;
          // console.log("[PRE-AUTH][renderer] Result:", JSON.stringify(result));
          if (result.valid) {
            // console.log("[PRE-AUTH][renderer] ✅ Auth passed — now proceeding to DB decryption");
          } else {
            // console.log("[PRE-AUTH][renderer] ❌ Auth FAILED — DB will NOT be decrypted. Reason:", result.reason);
          }
          dispatch({
            type: "AUTH_PRE_VALIDATED",
            valid: result.valid,
            noSession: result.noSession,
            reason: result.reason,
          });
        })
        .catch((error: Error) => {
          if (cancelled) return;
          // console.log("[PRE-AUTH][renderer] IPC error, proceeding optimistically:", error.message);
          // On IPC error, proceed optimistically (don't block app)
          dispatch({
            type: "AUTH_PRE_VALIDATED",
            valid: true,
            noSession: true,
          });
        });
    };

    runPhase();

    return () => {
      cancelled = true;
    };
  }, [state.status, loadingPhase, dispatch, dispatchApiNotReady]);

  // ============================================
  // PHASE 2: Initialize database (platform-specific)
  // ============================================
  useEffect(() => {
    /* console.log("[LoadingOrchestrator] Phase 2 effect triggered", {
      status: state.status,
      loadingPhase,
    }); */

    // Guard: only run in the correct phase
    if (state.status !== "loading" || loadingPhase !== "initializing-db") {
      // console.log("[LoadingOrchestrator] Phase 2 skipped - not in initializing-db phase");
      return;
    }

    // console.log("[LoadingOrchestrator] PHASE 2: Starting database initialization...");

    // Guard: respect deferredDbInit flag - let onboarding SecureStorageStep handle DB init
    // This prevents the Keychain prompt from appearing before the login screen on fresh macOS installs
    const loadingState = state as import("./types").LoadingState;
    if (loadingState.deferredDbInit) {
      return;
    }
    const platform = platformRef.current;

    // Windows: Auto-initialize (DPAPI is silent, no user interaction needed)
    // macOS: Also auto-initialize for now, but may show Keychain prompt
    // Future: macOS may wait for user to click Continue before triggering init
    if (autoInitializesStorage(platform)) {
      // Windows path: Silent auto-initialization
      // console.log("[LoadingOrchestrator] PHASE 2: Windows auto-init path");
      let cancelled = false;

      const runPhase = async () => {
        try {
          await waitForApi();
        } catch (err) {
          if (!cancelled) dispatchApiNotReady(err);
          return;
        }

        if (cancelled) return;

        dispatch({ type: "DB_INIT_STARTED" });

        window.api.system
          .initializeSecureStorage()
          .then((result) => {
            // console.log("[LoadingOrchestrator] PHASE 2: DB init result (Windows):", result);
            if (cancelled) return;
            dispatch({
              type: "DB_INIT_COMPLETE",
              success: result.success,
              error: result.error,
            });
          })
          .catch((error: Error) => {
            // console.error("[LoadingOrchestrator] PHASE 2: DB init FAILED (Windows):", error);
            if (cancelled) return;
            dispatch({
              type: "DB_INIT_COMPLETE",
              success: false,
              error: error.message || "Database initialization failed",
            });
          });
      };

      runPhase();

      return () => {
        cancelled = true;
      };
    } else {
      // macOS path: Auto-initialize but may trigger Keychain prompt
      // Note: For new users, the UI may show a keychain explanation first,
      // but the actual initialization happens here. The Keychain prompt
      // is a system-level dialog that appears during initializeSecureStorage.
      // console.log("[LoadingOrchestrator] PHASE 2: macOS init path (may trigger Keychain)");
      let cancelled = false;

      const runPhase = async () => {
        try {
          await waitForApi();
        } catch (err) {
          if (!cancelled) dispatchApiNotReady(err);
          return;
        }

        if (cancelled) return;

        dispatch({ type: "DB_INIT_STARTED" });

        window.api.system
          .initializeSecureStorage()
          .then((result) => {
            // console.log("[LoadingOrchestrator] PHASE 2: DB init result (macOS):", result);
            if (cancelled) return;
            dispatch({
              type: "DB_INIT_COMPLETE",
              success: result.success,
              error: result.error,
            });
          })
          .catch((error: Error) => {
            // console.error("[LoadingOrchestrator] PHASE 2: DB init FAILED (macOS):", error);
            if (cancelled) return;
            dispatch({
              type: "DB_INIT_COMPLETE",
              success: false,
              error: error.message || "Database initialization failed",
            });
          });
      };

      runPhase();

      return () => {
        cancelled = true;
      };
    }
  }, [state.status, loadingPhase, dispatch, dispatchApiNotReady]);

  // ============================================
  // INIT STAGE SUBSCRIPTION (BACKLOG-1379)
  // Subscribes to main process init stage broadcasts during
  // the initializing-db phase and dispatches metadata actions.
  // Also logs Sentry breadcrumbs for every stage transition.
  // ============================================
  const initStageSubscribedRef = useRef(false);
  const initStageTimestampRef = useRef<number | null>(null);
  const previousStageRef = useRef<string | null>(null);

  useEffect(() => {
    // Subscribe when entering the initializing-db phase
    if (state.status !== "loading" || loadingPhase !== "initializing-db") {
      return;
    }

    // Guard against duplicate subscriptions
    if (initStageSubscribedRef.current) {
      return;
    }

    // Check if the API is available (onInitStage may not exist on older builds)
    if (!window.api?.system?.onInitStage) {
      return;
    }

    initStageSubscribedRef.current = true;
    initStageTimestampRef.current = Date.now();
    previousStageRef.current = null;

    const cleanup = window.api.system.onInitStage((event) => {
      const now = Date.now();
      const previousStage = previousStageRef.current;
      const timeInPreviousStage = initStageTimestampRef.current
        ? now - initStageTimestampRef.current
        : 0;

      // Update timing refs
      initStageTimestampRef.current = now;
      previousStageRef.current = event.stage;

      // Sentry breadcrumb for every stage transition
      Sentry.addBreadcrumb({
        category: "init",
        message: `Init stage: ${event.stage}`,
        level: "info",
        data: {
          stage: event.stage,
          previousStage,
          progress: event.progress,
          message: event.message,
          timeInPreviousStage,
        },
      });

      // Tag scope so any crash during init shows which stage it was in
      Sentry.setTag("init_stage", event.stage);

      // Sentry error event for error stages
      if (event.stage === "error" && event.error) {
        Sentry.captureMessage("Initialization error during init stage", {
          level: "error",
          tags: {
            component: "init",
            init_stage: "error",
          },
          extra: {
            error_message: event.error.message,
            retryable: event.error.retryable,
            previousStage,
            timeInPreviousStage,
          },
        });
      }

      // Dispatch metadata to state machine
      dispatch({
        type: "INIT_STAGE_RECEIVED",
        payload: {
          stage: event.stage,
          progress: event.progress,
          message: event.message,
          error: event.error,
        },
      });
    });

    return () => {
      cleanup();
      initStageSubscribedRef.current = false;
    };
  }, [state.status, loadingPhase, dispatch]);

  // ============================================
  // PHASE 3: Load auth state
  // ============================================
  useEffect(() => {
    /* console.log("[LoadingOrchestrator] Phase 3 effect triggered", {
      status: state.status,
      loadingPhase,
    }); */

    // Guard: only run in the correct phase
    if (state.status !== "loading" || loadingPhase !== "loading-auth") {
      // console.log("[LoadingOrchestrator] Phase 3 skipped - not in loading-auth phase");
      return;
    }

    // console.log("[LoadingOrchestrator] PHASE 3: Checking auth state...");
    let cancelled = false;

    const platform = getPlatformInfo();

    // BACKLOG-1842 (resume-at-step fix round) / BACKLOG-2149: bounded retry
    // when getCurrentUser() reports transient/retryable (the local DB isn't
    // ready yet — e.g. the first second or two after the FDA-grant relaunch).
    // Before this fix, a transient response fell straight into the "no
    // session" branch below and dispatched AUTH_LOADED with user: null,
    // which flips state.status to "unauthenticated" and flashes the Login
    // screen even though a session genuinely exists and is about to resolve.
    // Bounded (not indefinite) so a GENUINELY logged-out user still reaches
    // Login promptly — same timeout budget as the main-process whenDbReady
    // gate this is racing against.
    const MAX_TRANSIENT_RETRIES = 6;
    const TRANSIENT_RETRY_DELAY_MS = 1000;

    const runPhase = async (attempt = 0) => {
      try {
        await waitForApi();
      } catch (err) {
        if (!cancelled) dispatchApiNotReady(err);
        return;
      }

      if (cancelled) return;

      window.api.auth
        .getCurrentUser()
        .then((result) => {
          /* console.log("[LoadingOrchestrator] PHASE 3: Auth check result:", {
            success: result.success,
            hasUser: !!result.user,
            isNewUser: result.isNewUser,
          }); */
          if (cancelled) return;

          if (result.success && result.user) {
            // Type the user from the API response
            const apiUser = result.user as {
              id: string;
              email: string;
              display_name?: string;
              avatar_url?: string;
            };

            const user: User = {
              id: apiUser.id,
              email: apiUser.email,
              displayName: apiUser.display_name,
              avatarUrl: apiUser.avatar_url,
            };

            // Store for USER_DATA_LOADED phase
            authDataRef.current = { user, platform };

            // Sync to AuthContext so currentUser is available in UI
            const authContextUser = {
              id: apiUser.id,
              email: apiUser.email,
              display_name: apiUser.display_name,
              avatar_url: apiUser.avatar_url,
            };
            login(
              authContextUser,
              result.sessionToken ?? "",
              result.provider ?? "",
              result.subscription,
              result.isNewUser ?? false,
            );

            // console.log("[LoadingOrchestrator] PHASE 3: Dispatching AUTH_LOADED with user:", user.email);
            dispatch({
              type: "AUTH_LOADED",
              user,
              isNewUser: result.isNewUser ?? false,
              platform,
            });
          } else if (result.transient && result.retryable && attempt < MAX_TRANSIENT_RETRIES) {
            // DB still starting up on the main-process side (BACKLOG-2149's
            // whenDbReady gate) — retry rather than declaring "no session".
            // The loading screen stays up throughout (state.status remains
            // "loading" until AUTH_LOADED dispatches), so no Login flash.
            logger.debug(
              `[LoadingOrchestrator] PHASE 3: getCurrentUser transient (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES}), retrying`,
            );
            setTimeout(() => {
              if (!cancelled) runPhase(attempt + 1);
            }, TRANSIENT_RETRY_DELAY_MS);
          } else {
            // No session - user needs to login
            // console.log("[LoadingOrchestrator] PHASE 3: No session, dispatching AUTH_LOADED with null user");
            dispatch({
              type: "AUTH_LOADED",
              user: null,
              isNewUser: false,
              platform,
            });
          }
        })
        .catch((error: Error) => {
          if (cancelled) return;
          // No session is not necessarily an error - just means user needs to login
          // console.warn("[LoadingOrchestrator] PHASE 3: Auth check failed:", error);
          dispatch({
            type: "AUTH_LOADED",
            user: null,
            isNewUser: false,
            platform: getPlatformInfo(),
          });
        });
    };

    runPhase();

    return () => {
      cancelled = true;
    };
  }, [state.status, loadingPhase, dispatch, dispatchApiNotReady, getPlatformInfo, login]);

  // ============================================
  // PHASE 4: Load user data (if authenticated)
  // ============================================
  useEffect(() => {
    /* console.log("[LoadingOrchestrator] Phase 4 effect triggered", {
      status: state.status,
      loadingPhase,
    }); */

    // Guard: only run in the correct phase
    if (state.status !== "loading" || loadingPhase !== "loading-user-data") {
      // console.log("[LoadingOrchestrator] Phase 4 skipped - not in loading-user-data phase");
      return;
    }

    // console.log("[LoadingOrchestrator] PHASE 4: Loading user data...");
    // User/platform context can come from:
    // 1. authDataRef (app restart flow - set during AUTH_LOADED phase)
    // 2. state.user/state.platform (fresh login flow - set by LOGIN_SUCCESS action)
    const loadingState = state as import("./types").LoadingState;
    const authData = authDataRef.current;

    // Prefer state (LOGIN_SUCCESS flow), fall back to ref (app restart flow)
    const user = loadingState.user || authData?.user;
    const platform = loadingState.platform || authData?.platform;

    if (!user || !platform) {
      // This shouldn't happen - loading-user-data phase means we had a user
      dispatch({
        type: "ERROR",
        error: {
          code: "USER_DATA_FAILED",
          message: "Missing user context for loading user data",
        },
        recoverable: true,
      });
      return;
    }

    let cancelled = false;

    // Load actual user data from database APIs
    const loadUserData = async (): Promise<UserData> => {
      const userId = user.id;

      // Load all user data in parallel for faster loading
      const [phoneTypeResult, emailOnboardingResult, connectionsResult, permissionsResult] =
        await Promise.all([
          // Get phone type from database
          window.api.user.getPhoneType(userId).catch(() => ({
            success: false,
            phoneType: null as "iphone" | "android" | null,
          })),

          // Check if email onboarding is completed
          window.api.auth
            .checkEmailOnboarding(userId)
            .catch(() => ({
              success: false,
              completed: false,
            })),

          // Check if email is connected (any provider)
          window.api.system.checkAllConnections(userId).catch(() => ({
            success: false,
            google: { connected: false },
            microsoft: { connected: false },
          })),

          // Check permissions (macOS only)
          platform.isMacOS
            ? window.api.system.checkPermissions().catch(() => ({
                hasPermission: false,
                fullDiskAccess: false,
              }))
            : Promise.resolve({ hasPermission: true, fullDiskAccess: true }),
        ]);

      // Determine phone type
      const phoneType =
        phoneTypeResult.success && phoneTypeResult.phoneType
          ? phoneTypeResult.phoneType
          : null;

      // Determine if any email provider is connected
      const hasEmailConnected =
        connectionsResult.success &&
        (connectionsResult.google?.connected === true ||
          connectionsResult.microsoft?.connected === true);

      // Determine if email onboarding is completed
      // If email is connected, consider onboarding complete (for returning users
      // who connected email before the hasCompletedEmailOnboarding flag existed)
      const hasCompletedEmailOnboarding =
        (emailOnboardingResult.success && emailOnboardingResult.completed) ||
        hasEmailConnected;

      // Determine permissions status (macOS only)
      const hasPermissions = platform.isMacOS
        ? permissionsResult.hasPermission === true ||
          permissionsResult.fullDiskAccess === true
        : true; // Windows doesn't require permissions

      // Determine if driver setup is needed (Windows + iPhone only)
      let needsDriverSetup = false;
      if (platform.isWindows && phoneType === "iphone") {
        try {
          // Check if Apple drivers are installed
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const drivers = (window.api as any)?.drivers;
          if (drivers) {
            const driverStatus = await drivers.checkApple();
            // Only check isInstalled - service might not be running after fresh install
            needsDriverSetup = !driverStatus.isInstalled;
          } else {
            needsDriverSetup = true;
          }
        } catch {
          // Assume drivers needed if check fails
          needsDriverSetup = true;
        }
      }

      return {
        phoneType,
        hasCompletedEmailOnboarding,
        hasEmailConnected,
        needsDriverSetup,
        hasPermissions,
      };
    };

    const loadUserDataAndDispatch = () => {
      return loadUserData()
        .then((userData) => {
          if (cancelled) return;

          // Dispatch with required context (user and platform from state or ref)
          dispatch({
            type: "USER_DATA_LOADED",
            data: userData,
            // These are required by the reducer for state transition
            user,
            platform,
          } as {
            type: "USER_DATA_LOADED";
            data: UserData;
            user: User;
            platform: PlatformInfo;
          });
        })
        .catch((error: Error) => {
          if (cancelled) return;
          // console.error("[LoadingOrchestrator] Failed to load user data:", error);

          // Fallback to empty user data - will trigger onboarding
          const fallbackData: UserData = {
            phoneType: null,
            hasCompletedEmailOnboarding: false,
            hasEmailConnected: false,
            needsDriverSetup: platform.isWindows,
            hasPermissions: !platform.isMacOS,
          };

          dispatch({
            type: "USER_DATA_LOADED",
            data: fallbackData,
            user,
            platform,
          } as {
            type: "USER_DATA_LOADED";
            data: UserData;
            user: User;
            platform: PlatformInfo;
          });
        });
    };

    // BACKLOG-1842 (resume-at-step fix round): bounded wait for the local DB
    // to be queryable before reading phoneType/email/permissions from it.
    // Without this, a relaunch that reaches Phase 4 before DatabaseService
    // finishes initializing gets `.catch()` fallbacks (phoneType: null,
    // hasEmailConnected: false, ...) baked into completedSteps — the exact
    // "onboarding restarted from scratch" bug. Mirrors the main-process
    // whenDbReady gate (BACKLOG-2149) and AccountVerificationStep's identical
    // poll-then-safety-timeout pattern. Never blocks indefinitely — a stuck
    // init still falls through to the reads below, which have their own
    // `.catch()` fallbacks.
    //
    // BACKLOG-2171: a returning user on a fresh macOS profile routes here with
    // DB init intentionally DEFERRED to onboarding's secure-storage step
    // (deferredDbInit) — init hasn't been kicked off and won't be until the
    // user reaches that step, which is BEHIND this loading screen. Polling
    // for db-ready in that state burns the full MAX_WAIT_MS for nothing, which
    // was the launch-blocking "frozen Loading your data" regression. `idle`/
    // any non-in-progress stage now returns immediately; only a stage that
    // indicates init is genuinely underway keeps polling (preserves the
    // BACKLOG-2149 memory-pressure protection).
    const waitForDbReadyBounded = async (): Promise<void> => {
      const getInitStage = window.api?.system?.getInitStage;
      if (!getInitStage) return;
      const DB_READY_STAGES = new Set(["db-ready", "complete"]);
      const IN_PROGRESS_STAGES = new Set(["starting", "db-opening", "migrating", "creating-user"]);
      const POLL_INTERVAL_MS = 250;
      const MAX_WAIT_MS = 10_000;
      const PER_CALL_TIMEOUT_MS = 2_000;
      const deadline = Date.now() + MAX_WAIT_MS;

      // BACKLOG-2171: getInitStage() is an IPC round-trip; if it never
      // settles, a bare `await` inside the loop would block past `deadline`
      // and the "bounded" guarantee wouldn't hold. Race each poll against its
      // own timeout so a hung call is treated the same as an error (fall
      // through to the callers' existing fallbacks) instead of hanging.
      const pollOnce = (): Promise<{ stage: string } | "timeout" | "error"> =>
        Promise.race([
          getInitStage().then(
            (event) => event,
            () => "error" as const,
          ),
          new Promise<"timeout">((resolve) =>
            setTimeout(() => resolve("timeout"), PER_CALL_TIMEOUT_MS),
          ),
        ]);

      let sawInProgress = false;
      while (Date.now() < deadline) {
        const result = await pollOnce();
        if (result === "error") return; // getInitStage unavailable — reads have their own fallbacks
        if (result === "timeout") {
          // Per-call timeout, not the overall deadline — keep polling until
          // MAX_WAIT_MS, same as a slow-but-alive IPC call would.
          continue;
        }
        if (DB_READY_STAGES.has(result.stage) || result.stage === "error") return;
        if (IN_PROGRESS_STAGES.has(result.stage)) {
          sawInProgress = true;
        } else if (!sawInProgress) {
          // Still idle and never observed to be in progress — deferred init
          // (or init that hasn't started yet). Don't wait for a broadcast
          // that may never come this loading phase.
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    };

    const runPhase = async () => {
      try {
        await waitForApi();
      } catch (err) {
        if (!cancelled) dispatchApiNotReady(err);
        return;
      }

      if (cancelled) return;

      await waitForDbReadyBounded();
      if (cancelled) return;

      await loadUserDataAndDispatch();
    };

    runPhase();

    return () => {
      cancelled = true;
    };
    // Note: We read state.user and state.platform for LOGIN_SUCCESS flow,
    // but those are set atomically with loadingPhase, so state.status and loadingPhase
    // are sufficient dependencies.
  }, [state.status, loadingPhase, dispatch, dispatchApiNotReady]);

  // ============================================
  // RENDER BASED ON STATE
  // ============================================
  /* console.log("[LoadingOrchestrator] Render decision:", {
    status: state.status,
    loadingPhase,
  }); */

  // Loading states - show loading screen with platform-specific messages
  if (state.status === "loading" && loadingPhase) {
    // console.log("[LoadingOrchestrator] Rendering LoadingScreen for phase:", loadingPhase);
    const loadingState = state as import("./types").LoadingState;
    return (
      <LoadingScreen
        phase={loadingPhase}
        progress={state.progress}
        platform={platformRef.current}
        initStage={loadingState.initStage}
        migrationProgress={loadingState.migrationProgress}
        initMessage={loadingState.initMessage}
      />
    );
  }

  // Error state - show error screen with retry for recoverable errors
  // TASK-2278: Show ErrorScreen for ALL errors (both recoverable and non-recoverable).
  // Previously, only non-recoverable errors showed ErrorScreen, causing recoverable
  // errors (e.g., DB_INIT_FAILED) to fall through to children, which rendered
  // onboarding instead of an error screen.
  if (state.status === "error") {
    return (
      <ErrorScreen
        error={state.error}
        onRetry={state.recoverable ? () => dispatch({ type: "RETRY" }) : undefined}
      />
    );
  }

  // Non-error states - render children (unauthenticated, onboarding, ready)
  return <>{children}</>;
}
