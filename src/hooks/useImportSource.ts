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
import { effectiveImportSource } from "../services/importSourcePolicy";

export function useImportSource(
  userId: string | undefined,
  showSettings: boolean
): ImportSource {
  const { isMacOS } = usePlatform();
  const [importSource, setImportSource] = useState<ImportSource>(
    isMacOS ? "macos-native" : "iphone-sync"
  );

  useEffect(() => {
    if (!userId) return;
    settingsService.getPreferences(userId).then((result) => {
      if (result.success && result.data?.messages?.source) {
        // BACKLOG-3749: a value this build does not know → the platform default.
        setImportSource(effectiveImportSource(result.data.messages.source, isMacOS));
      }
    }).catch(() => {
      // Silently ignore — keep platform default
    });
  }, [userId, showSettings, isMacOS]);

  return importSource;
}
