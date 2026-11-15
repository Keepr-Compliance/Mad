/**
 * The Learn score's signal lines (BACKLOG-4257, shadow measurement).
 *
 * Main measures per-email signals in their own call (learn:signals), so the
 * score dialog never waits for them. While `active`, this asks once and
 * returns the count-only lines for the Copy block: a short "measuring" line
 * until they arrive, a "not available" line if the call fails.
 */
import { useEffect, useState } from "react";
import learnModeService from "@/services/learnModeService";

export const LEARN_SIGNALS_PENDING_LINE = "Signals (measured only): measuring…";
export const LEARN_SIGNALS_UNAVAILABLE_LINE = "Signals (measured only): not available";

export function useLearnSignalLines(active: boolean): string | null {
  const [lines, setLines] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setLines(null);
      return;
    }
    let cancelled = false;
    setLines(LEARN_SIGNALS_PENDING_LINE);
    void learnModeService.signals().then((r) => {
      if (!cancelled) setLines(r.success ? r.copyLines : LEARN_SIGNALS_UNAVAILABLE_LINE);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return lines;
}
