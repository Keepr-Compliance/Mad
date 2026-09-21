/**
 * IPhoneSyncContext
 *
 * Provides a single shared instance of useIPhoneSync to prevent
 * dual-instance bugs when multiple components need sync state.
 *
 * Without this context, each component calling useIPhoneSync() gets
 * its own independent useState/useEffect instances, causing:
 * - Double device detection
 * - Double IPC listeners
 * - Race conditions on stopDetection cleanup
 *
 * BACKLOG-1706: The provider also owns the "iPhone sync enabled" state. It
 * resolves the effective enablement from the user's preference + platform +
 * import source (see resolveIphoneSyncEnabled) and passes it into the hook so
 * detection/polling only runs when opted in. The enablement + a setter are
 * exposed via a separate IPhoneSyncEnabledContext so the Settings toggle can
 * start/stop detection live without touching the hook's return contract.
 *
 * BACKLOG-3423: the import source is now a gate on the EFFECTIVE enablement, so
 * a macOS Messages (or Android) user gets no device detection and a toggle that
 * reads OFF even when their stored `iphoneSyncEnabled` is `true`. The stored
 * preference is never rewritten — switching back to iPhone restores it. The
 * provider therefore keeps the raw preference and the source as separate state
 * and derives `enabled` from both, and `applyImportSource` lets Settings re-gate
 * live when the source radio changes (before, enablement was resolved once per
 * `[userId, platform]` and a source change did nothing until the next restart).
 *
 * BACKLOG-3418: no detection until a user is signed in AND their preferences
 * have been read, on every platform. The source stays unknown (`null`) until
 * then, and the resolver now reads an unknown source as OFF everywhere — so the
 * login screen runs no device detection on Windows, where it used to. The
 * onboarding phone-type answer re-gates through `applyImportSource` (called by
 * OnboardingFlow), so an Android answer stops detection at once.
 *
 * @module contexts/IPhoneSyncContext
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useIPhoneSync } from "../hooks/useIPhoneSync";
import type { UseIPhoneSyncReturn } from "../types/iphone";
import { usePlatform } from "./PlatformContext";
import { settingsService, type ImportSource } from "../services/settingsService";
import { resolveIphoneSyncEnabled } from "../utils/iphoneSyncEnabled";
import logger from "../utils/logger";

const IPhoneSyncContext = createContext<UseIPhoneSyncReturn | null>(null);

/**
 * BACKLOG-1706: Enablement context — kept separate from the sync-state context
 * so consumers (the Settings toggle) can read/flip the opt-in without depending
 * on the full useIPhoneSync return shape.
 */
export interface IPhoneSyncEnabledContextValue {
  /**
   * Whether iPhone detection/sync is currently active — the EFFECTIVE value
   * (stored preference gated by the import source, BACKLOG-3423), which is what
   * the Settings toggle displays.
   */
  enabled: boolean;
  /** Persist + live-apply the opt-in. Optimistic; reverts on persistence failure. */
  setIphoneSyncEnabled: (next: boolean) => Promise<void>;
  /**
   * BACKLOG-3423: re-gate on a live import-source change. Settings calls this
   * after ImportSourceSettings has persisted `messages.source`, so detection
   * starts/stops with the radio instead of at the next app start. It changes NO
   * stored value — in particular it never writes `integrations`.
   *
   * BACKLOG-3418: OnboardingFlow also calls it with the source the phone-type
   * answer stands for, so an Android answer stops detection immediately.
   */
  applyImportSource: (source: ImportSource) => void;
}

const IPhoneSyncEnabledContext =
  createContext<IPhoneSyncEnabledContextValue | null>(null);

interface IPhoneSyncProviderProps {
  /** Current user's ID, or null when logged out / pre-onboarding. */
  userId?: string | null;
  children: React.ReactNode;
}

export function IPhoneSyncProvider({ userId = null, children }: IPhoneSyncProviderProps) {
  const { platform } = usePlatform();

  // BACKLOG-3423: the raw stored preference and the effective import source are
  // held separately, and `enabled` is derived from both. Both start "unknown"
  // (undefined / null), which resolves to OFF on every platform (BACKLOG-3418):
  // no detection while signed out, and none while a signed-in user's
  // preferences are still loading.
  const [prefEnabled, setPrefEnabled] = useState<boolean | undefined>(undefined);
  const [importSource, setImportSource] = useState<ImportSource | null>(null);

  // BACKLOG-3418: counts live source changes (applyImportSource). A preference
  // read that was already in flight when the source changed live must not
  // overwrite the newer value: an onboarding "Android" answer given while the
  // read is pending would otherwise be replaced by the read's pre-answer
  // default (`iphone-sync` on Windows) and detection would start again.
  const liveSourceChangesRef = useRef(0);

  // Mirror of `prefEnabled` so the optimistic-write path can restore the exact
  // previous value on failure (which may be `undefined` — "never set" — and is
  // NOT the same as `!next`).
  const prefEnabledRef = useRef<boolean | undefined>(undefined);
  const applyPrefEnabled = useCallback((next: boolean | undefined) => {
    prefEnabledRef.current = next;
    setPrefEnabled(next);
  }, []);

  const enabled = useMemo(
    () => resolveIphoneSyncEnabled(prefEnabled, platform, importSource),
    [prefEnabled, platform, importSource],
  );

  // Read the user's stored preference + import source.
  useEffect(() => {
    if (!userId) {
      // Logged out / pre-onboarding: the source is unknown, which is OFF on
      // every platform (BACKLOG-3418).
      applyPrefEnabled(undefined);
      setImportSource(null);
      return;
    }

    let cancelled = false;
    const liveSourceChangesAtStart = liveSourceChangesRef.current;

    (async () => {
      try {
        const prefsRes = await settingsService.getPreferences(userId);
        const prefs = prefsRes.success ? prefsRes.data : undefined;

        const storedPref =
          typeof prefs?.integrations?.iphoneSyncEnabled === "boolean"
            ? prefs.integrations.iphoneSyncEnabled
            : undefined;

        // BACKLOG-3423: the source is needed whether or not there is an explicit
        // opt-in — it now gates the opt-in rather than only standing in for it.
        let source: ImportSource | null = prefs?.messages?.source ?? null;
        if (!source) {
          // Mirror Settings.tsx / useImportSource default derivation.
          const phone = await settingsService.getPhoneType(userId);
          if (phone.success && phone.data === "android") {
            source = "android-companion";
          } else {
            source = platform === "macos" ? "macos-native" : "iphone-sync";
          }
        }

        if (cancelled) return;
        applyPrefEnabled(storedPref);
        // A live source change since this read began is newer than the read.
        if (liveSourceChangesRef.current === liveSourceChangesAtStart) {
          setImportSource(source);
        }
      } catch (err) {
        if (!cancelled) {
          logger.warn(
            "[IPhoneSyncProvider] Failed to resolve iPhone sync enablement; source stays unknown (detection off)",
            err,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, platform, applyPrefEnabled]);

  // Live-toggle: optimistic state update (starts/stops detection immediately via
  // the hook's `enabled` dependency) then persist. Revert on persistence failure.
  const setIphoneSyncEnabled = useCallback(
    async (next: boolean): Promise<void> => {
      const previous = prefEnabledRef.current;
      applyPrefEnabled(next);
      if (!userId) return;
      const res = await settingsService.setIphoneSyncEnabled(userId, next);
      if (!res.success) {
        applyPrefEnabled(previous);
        logger.warn(
          "[IPhoneSyncProvider] Failed to persist iphoneSyncEnabled; reverting",
          res.error,
        );
      }
    },
    [userId, applyPrefEnabled],
  );

  // BACKLOG-3423: Settings calls this when the source radio changes, AFTER
  // ImportSourceSettings has persisted it. Re-gating is all this does: no
  // preference is written here, so a user who had the toggle ON as an iPhone
  // user keeps that stored choice while their source is elsewhere.
  const applyImportSource = useCallback((source: ImportSource) => {
    liveSourceChangesRef.current += 1;
    setImportSource(source);
  }, []);

  const sync = useIPhoneSync(enabled);

  const enabledValue = useMemo<IPhoneSyncEnabledContextValue>(
    () => ({ enabled, setIphoneSyncEnabled, applyImportSource }),
    [enabled, setIphoneSyncEnabled, applyImportSource],
  );

  return (
    <IPhoneSyncEnabledContext.Provider value={enabledValue}>
      <IPhoneSyncContext.Provider value={sync}>
        {children}
      </IPhoneSyncContext.Provider>
    </IPhoneSyncEnabledContext.Provider>
  );
}

/**
 * Consumer hook for IPhoneSync context.
 * Must be used within an IPhoneSyncProvider.
 */
export function useIPhoneSyncContext(): UseIPhoneSyncReturn {
  const ctx = useContext(IPhoneSyncContext);
  if (!ctx) {
    throw new Error("useIPhoneSyncContext must be used within IPhoneSyncProvider");
  }
  return ctx;
}

/**
 * BACKLOG-1706: Consumer hook for the iPhone-sync enablement + setter.
 * Returns a tolerant no-op default when used outside the provider so the
 * Settings toggle never crashes in isolation (persisting is a no-op there).
 */
export function useIPhoneSyncEnabled(): IPhoneSyncEnabledContextValue {
  const ctx = useContext(IPhoneSyncEnabledContext);
  if (!ctx) {
    return {
      enabled: false,
      setIphoneSyncEnabled: async () => {},
      applyImportSource: () => {},
    };
  }
  return ctx;
}
