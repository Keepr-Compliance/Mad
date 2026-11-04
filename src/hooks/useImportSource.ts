/**
 * useImportSource Hook
 *
 * Reads the user's import source preference via settingsService.
 * Re-reads when settings modal closes (showSettings transitions to false)
 * so the Dashboard card visibility updates immediately after toggling import source.
 *
 * Extracted from AppRouter.tsx (BACKLOG-1653) to keep entry files under line budget.
 */

import { useState, useEffect, useRef } from "react";
import { usePlatform } from "../contexts/PlatformContext";
import { useIPhoneSyncEnabled } from "../contexts/IPhoneSyncContext";
import { settingsService, type ImportSource } from "../services/settingsService";
import { loadChosenImportSource } from "../services/importSourcePolicy";

/**
 * BACKLOG-3418: returns `null` when the user has chosen no source
 * (Windows/Linux) — the Dashboard then shows no import button, matching iPhone
 * detection, which is also off for that user. The value comes from the one
 * shared derivation (`chosenImportSource`) that the detection gate and Settings
 * use. Before the preferences are read it is the platform's starting value:
 * `macos-native` on macOS (unchanged), `null` elsewhere.
 *
 * BACKLOG-4135 (founder rule from BACKLOG-2890 / 2893): a failed preferences
 * read is NOT "nothing stored". It changes nothing: the hook keeps the last
 * value it read for this user (the platform starting value when it has read
 * none). A served local copy (BACKLOG-2824) is a normal successful read. When
 * the IPhoneSyncProvider's BACKLOG-2893 hold clears (a successful Retry), every
 * instance of this hook re-reads once, so the title-bar pill follows.
 */
export function useImportSource(
  userId: string | undefined,
  showSettings: boolean
): ImportSource | null {
  const { isMacOS } = usePlatform();
  const { readFailed } = useIPhoneSyncEnabled();
  // The last value read, keyed by the user it was read for, so a failed read
  // for another user never shows this user's source.
  const [known, setKnown] = useState<{ userId: string; source: ImportSource | null } | null>(null);

  // Counts the 2893 hold clearing (readFailed true -> false). Only that edge
  // triggers a re-read; the hold starting does not.
  const [holdCleared, setHoldCleared] = useState(0);
  const prevReadFailed = useRef(readFailed);
  useEffect(() => {
    if (prevReadFailed.current && !readFailed) setHoldCleared((n) => n + 1);
    prevReadFailed.current = readFailed;
  }, [readFailed]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    settingsService.getPreferences(userId).then(async (result) => {
      // Failed read: keep the last known value.
      if (!result.success) return;
      const chosen = await loadChosenImportSource(
        result.data as Parameters<typeof loadChosenImportSource>[0],
        isMacOS,
        () => settingsService.getPhoneType(userId),
      );
      if (!cancelled) setKnown({ userId, source: chosen });
    }).catch(() => {
      // Silently ignore — keep the current value
    });
    return () => {
      cancelled = true;
    };
  }, [userId, showSettings, isMacOS, holdCleared]);

  if (known && known.userId === userId) return known.source;
  return isMacOS ? "macos-native" : null;
}
