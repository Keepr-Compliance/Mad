/**
 * BACKLOG-3892 (S3): the ONE "how far back to import texts" value, shared by
 * every text source — macOS Messages, iPhone and Google Messages, on Mac and
 * Windows.
 *
 * All three sources already read the same stored key —
 * `preferences.messageImport.filters.lookbackMonths`, through
 * `importPlanInputs.loadStoredImportFilters` in the main process — so one
 * value on screen is the truth; two panels each holding their own copy of it
 * was not (a change in one left the other describing the old window).
 *
 * `TextsLookbackProvider` (mounted by Settings around the Messages section)
 * owns the value. `useTextsLookback` reads it from the provider, or — when a
 * panel is rendered on its own, with no provider above it — loads and saves
 * the same key itself, so a standalone panel still describes the stored window.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { settingsService } from "../../services";
import { parseLookbackOption } from "./LookbackMonthsSelect";
import { readMessageImportPreferences, resolveStoredLookbackMonths } from "./messageImportPreferences";

/** Settings → Messages → "How far back to import texts" (the scroll target of Google Messages' "Change"). */
export const TEXTS_LOOKBACK_TARGET = "settings-texts-lookback";

export interface TextsLookback {
  /** The stored window in months; null = All time. */
  months: number | null;
  /** The stored value has been read (or the read failed and the default stands). */
  settled: boolean;
  /** The last save failed and was reverted. Cleared by the next change. */
  saveFailed: boolean;
  /** Counts saves that LANDED; a consumer re-reads anything the store derives from the value when it changes. */
  saveCount: number;
  /**
   * Save an option value ("1.5", "3", … or "all"). Resolves true once the
   * save LANDED; on a failed save the value reverts and it resolves false.
   */
  change: (value: string) => Promise<boolean>;
}

const TextsLookbackContext = createContext<TextsLookback | null>(null);

/** The state itself. `active=false` → no read is made (a provider above owns the value). */
function useTextsLookbackState(userId: string, active: boolean): TextsLookback {
  const [months, setMonths] = useState<number | null>(resolveStoredLookbackMonths(undefined));
  const [settled, setSettled] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveCount, setSaveCount] = useState(0);
  const monthsRef = useRef(months);
  monthsRef.current = months;

  useEffect(() => {
    if (!active || !userId) return;
    let live = true;
    void (async () => {
      try {
        const r = await settingsService.getPreferences(userId);
        if (live && r?.success) {
          // An ABSENT key is "no preference" (the default), only an explicit null is All time.
          setMonths(resolveStoredLookbackMonths(readMessageImportPreferences(r.data)?.filters));
        }
      } catch {
        // The default stands.
      } finally {
        if (live) setSettled(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [userId, active]);

  const change = useCallback(
    async (value: string): Promise<boolean> => {
      const next = parseLookbackOption(value);
      const previous = monthsRef.current;
      setMonths(next);
      setSaveFailed(false);
      let saved = false;
      try {
        const r = await settingsService.updatePreferences(userId, {
          messageImport: { filters: { lookbackMonths: next } },
        });
        // settingsService returns {success:false} rather than throwing; both are failures.
        saved = r?.success !== false;
      } catch {
        saved = false;
      }
      if (saved) {
        setSaveCount((n) => n + 1);
      } else {
        setMonths(previous);
        setSaveFailed(true);
      }
      return saved;
    },
    [userId],
  );

  return useMemo(
    () => ({ months, settled, saveFailed, saveCount, change }),
    [months, settled, saveFailed, saveCount, change],
  );
}

export function TextsLookbackProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const value = useTextsLookbackState(userId, true);
  return <TextsLookbackContext.Provider value={value}>{children}</TextsLookbackContext.Provider>;
}

/** The shared value: the provider's when one is mounted, otherwise this component's own read of the same key. */
export function useTextsLookback(userId: string): TextsLookback {
  const shared = useContext(TextsLookbackContext);
  const own = useTextsLookbackState(userId, shared === null);
  return shared ?? own;
}
