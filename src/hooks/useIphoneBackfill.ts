/**
 * BACKLOG-3892 S6 — "Get older texts" state for one deal: whether it is offered, the
 * running backfill's progress, Cancel, and what to say when it ends.
 *
 * Offered ONLY when S5's availability says `available` (a kept backup that can fill this
 * deal's start gap). After a successful run `onSuccess` fires so the surface re-checks
 * coverage with the user's chosen text source (and reloads the texts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { iphoneBackfillService } from "../services/iphoneBackfillService";
import type {
  BackfillAvailability,
  BackfillPhase,
  BackfillReason,
  BackfillResult,
} from "../../electron/types/iphoneBackfill";

/**
 * Refusals that mean "the gap this run was offered for is no longer there / no longer
 * fillable" (the deal got locked, the gap closed, nothing older exists). Said with NO
 * sentence: the surface re-checks coverage and the button goes away.
 */
export const STALE_OFFER_REASONS: ReadonlySet<BackfillReason> = new Set<BackfillReason>([
  "locked",
  "no-gap",
  "nothing-older",
]);

export interface UseIphoneBackfillOptions {
  /** Ask availability only while the deal's iPhone start gap is shown. */
  enabled: boolean;
  /** Re-ask availability whenever this changes (e.g. the gap was re-read after a sync). */
  refreshKey?: string | number;
  /** A run stored texts / ended successfully: re-check coverage, reload texts. */
  onSuccess?: (result: BackfillResult) => void | Promise<void>;
  /** A run was refused as locked / no-gap / nothing-older: re-check coverage (never export). */
  onRefused?: (result: BackfillResult) => void | Promise<void>;
}

export interface UseIphoneBackfillState {
  availability: BackfillAvailability | null;
  running: boolean;
  progress: { phase: BackfillPhase; percent: number } | null;
  /** The last run's result (cleared when a new run starts). */
  result: BackfillResult | null;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
}

export function useIphoneBackfill(transactionId: string, options: UseIphoneBackfillOptions): UseIphoneBackfillState {
  const { enabled, refreshKey, onSuccess, onRefused } = options;
  const [availability, setAvailability] = useState<BackfillAvailability | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ phase: BackfillPhase; percent: number } | null>(null);
  const [result, setResult] = useState<BackfillResult | null>(null);
  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onRefusedRef = useRef(onRefused);
  onRefusedRef.current = onRefused;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    const a = await iphoneBackfillService.availability(transactionId);
    if (mountedRef.current && !runningRef.current) setAvailability(a);
  }, [transactionId]);

  useEffect(() => {
    if (!enabled) {
      setAvailability(null);
      return;
    }
    void check();
  }, [enabled, refreshKey, check]);

  // Progress for THIS deal's run only.
  useEffect(() => {
    if (!running) return;
    return iphoneBackfillService.onProgress((p) => {
      if (!mountedRef.current || p?.transactionId !== transactionId) return;
      setProgress({ phase: p.phase, percent: Math.max(0, Math.min(100, Math.round(p.percent))) });
    });
  }, [running, transactionId]);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setResult(null);
    setProgress(null);
    let r: BackfillResult;
    try {
      r = await iphoneBackfillService.getOlderTexts(transactionId);
    } finally {
      runningRef.current = false;
    }
    if (!mountedRef.current) return;
    setRunning(false);
    setProgress(null);
    setResult(r);
    if (r.success) {
      try {
        await onSuccessRef.current?.(r);
      } catch {
        // A failed re-check never hides the result line.
      }
    }
    if (!r.success && r.reason && STALE_OFFER_REASONS.has(r.reason)) {
      try {
        await onRefusedRef.current?.(r);
      } catch {
        // A failed re-check never throws into the click.
      }
    }
    // Offer it again only if it can still fill a gap.
    await check();
  }, [check, transactionId]);

  const cancel = useCallback(async () => {
    await iphoneBackfillService.cancel();
  }, []);

  return { availability, running, progress, result, start, cancel };
}
