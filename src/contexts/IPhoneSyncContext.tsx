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
 * @module contexts/IPhoneSyncContext
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
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
  /** Whether iPhone detection/sync is currently active. */
  enabled: boolean;
  /** Persist + live-apply the opt-in. Optimistic; reverts on persistence failure. */
  setIphoneSyncEnabled: (next: boolean) => Promise<void>;
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

  // Initialise from the platform default (no pref, no source) so macOS starts
  // OFF (no detection flash while prefs load) and Windows/Linux start ON.
  const [enabled, setEnabled] = useState<boolean>(() =>
    resolveIphoneSyncEnabled(undefined, platform, null),
  );

  // Resolve effective enablement from the user's stored preference + import source.
  useEffect(() => {
    if (!userId) {
      // Logged out / pre-onboarding: fall back to the platform default.
      setEnabled(resolveIphoneSyncEnabled(undefined, platform, null));
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const prefsRes = await settingsService.getPreferences(userId);
        const prefs = prefsRes.success ? prefsRes.data : undefined;

        const prefEnabled =
          typeof prefs?.integrations?.iphoneSyncEnabled === "boolean"
            ? prefs.integrations.iphoneSyncEnabled
            : undefined;

        // Only need the effective import source when there's no explicit opt-in.
        let source: ImportSource | null = null;
        if (typeof prefEnabled !== "boolean") {
          source = prefs?.messages?.source ?? null;
          if (!source) {
            // Mirror Settings.tsx / useImportSource default derivation.
            const phone = await settingsService.getPhoneType(userId);
            if (phone.success && phone.data === "android") {
              source = "android-companion";
            } else {
              source = platform === "macos" ? "macos-native" : "iphone-sync";
            }
          }
        }

        if (cancelled) return;
        setEnabled(resolveIphoneSyncEnabled(prefEnabled, platform, source));
      } catch (err) {
        if (!cancelled) {
          logger.warn(
            "[IPhoneSyncProvider] Failed to resolve iPhone sync enablement; keeping platform default",
            err,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, platform]);

  // Live-toggle: optimistic state update (starts/stops detection immediately via
  // the hook's `enabled` dependency) then persist. Revert on persistence failure.
  const setIphoneSyncEnabled = useCallback(
    async (next: boolean): Promise<void> => {
      setEnabled(next);
      if (!userId) return;
      const res = await settingsService.setIphoneSyncEnabled(userId, next);
      if (!res.success) {
        setEnabled(!next);
        logger.warn(
          "[IPhoneSyncProvider] Failed to persist iphoneSyncEnabled; reverting",
          res.error,
        );
      }
    },
    [userId],
  );

  const sync = useIPhoneSync(enabled);

  const enabledValue = useMemo<IPhoneSyncEnabledContextValue>(
    () => ({ enabled, setIphoneSyncEnabled }),
    [enabled, setIphoneSyncEnabled],
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
    return { enabled: false, setIphoneSyncEnabled: async () => {} };
  }
  return ctx;
}
