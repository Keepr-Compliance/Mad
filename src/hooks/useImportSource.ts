/**
 * useImportSource Hook
 *
 * Reads the user's import source preference via settingsService.
 * Re-reads when settings modal closes (showSettings transitions to false)
 * so the Dashboard card visibility updates immediately after toggling import source.
 *
 * Extracted from AppRouter.tsx (BACKLOG-1653) to keep entry files under line budget.
 */

import { useState, useEffect } from "react";
import { usePlatform } from "../contexts/PlatformContext";
import { settingsService, type ImportSource } from "../services/settingsService";
import { loadChosenImportSource } from "../services/importSourcePolicy";

/**
 * BACKLOG-3418: returns `null` when the user has chosen no source
 * (Windows/Linux) — the Dashboard then shows no import button, matching iPhone
 * detection, which is also off for that user. The value comes from the one
 * shared derivation (`chosenImportSource`) that the detection gate and Settings
 * use. Before the preferences are read it is the platform's starting value:
 * `macos-native` on macOS (unchanged), `null` elsewhere.
 */
export function useImportSource(
  userId: string | undefined,
  showSettings: boolean
): ImportSource | null {
  const { isMacOS } = usePlatform();
  const [importSource, setImportSource] = useState<ImportSource | null>(
    isMacOS ? "macos-native" : null
  );

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    settingsService.getPreferences(userId).then(async (result) => {
      const chosen = await loadChosenImportSource(
        result.success ? (result.data as Parameters<typeof loadChosenImportSource>[0]) : undefined,
        isMacOS,
        () => settingsService.getPhoneType(userId),
      );
      if (!cancelled) setImportSource(chosen);
    }).catch(() => {
      // Silently ignore — keep the current value
    });
    return () => {
      cancelled = true;
    };
  }, [userId, showSettings, isMacOS]);

  return importSource;
}
