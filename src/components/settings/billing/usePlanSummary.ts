/**
 * usePlanSummary — BACKLOG-3863 (the hook slice 3's PlanBillingCard uses).
 *
 * - Reads the plan summary once on mount (Settings open).
 * - `openBillingPortal()` opens the portal Billing page and ARMS a one-shot
 *   flag. The next time this window gains focus (the user coming back from the
 *   browser) it calls `billing:refresh` once, which drops main's entitlement
 *   memo and feature cache and answers a fresh summary. Later focus events do
 *   nothing until the button is used again. No polling.
 *
 * Display only: `summary` never gates anything. `unavailable` means show the
 * feature-gate fallback line (billing off, offline, 5xx, timeout, signed out).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import billingService, { type PlanSummary } from "../../../services/billingService";

export interface UsePlanSummary {
  /** The portal's summary, or null when unavailable or not loaded yet. */
  summary: PlanSummary | null;
  /** True until the first answer arrives. */
  loading: boolean;
  /** True when the portal gave no summary (fall back to the feature gate). */
  unavailable: boolean;
  /** Open the portal Billing page; arms the refresh-on-return. */
  openBillingPortal: () => Promise<void>;
  /** The allowed portal address when the browser could not be opened, else null. */
  openFailedAddress: string | null;
  /** True when the portal page could not be opened at all. */
  openFailed: boolean;
}

export function usePlanSummary(): UsePlanSummary {
  const [summary, setSummary] = useState<PlanSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [openFailedAddress, setOpenFailedAddress] = useState<string | null>(null);
  const armedRef = useRef(false);
  const mountedRef = useRef(true);

  const apply = useCallback(
    (result: Awaited<ReturnType<typeof billingService.getPlanSummary>>) => {
      if (!mountedRef.current) return;
      if (result.unavailable) {
        setSummary(null);
        setUnavailable(true);
      } else {
        setSummary(result.summary);
        setUnavailable(false);
      }
      setLoading(false);
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void billingService.getPlanSummary().then(apply);
    return () => {
      mountedRef.current = false;
    };
  }, [apply]);

  useEffect(() => {
    const onFocus = (): void => {
      if (!armedRef.current) return;
      armedRef.current = false; // one-shot
      void billingService.refresh().then(apply);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [apply]);

  const openBillingPortal = useCallback(async () => {
    const result = await billingService.openPortal();
    if (!mountedRef.current) return;
    if (result.success) {
      armedRef.current = true;
      setOpenFailed(false);
      setOpenFailedAddress(null);
    } else {
      setOpenFailed(true);
      setOpenFailedAddress(typeof result.portalAddress === "string" ? result.portalAddress : null);
    }
  }, []);

  return { summary, loading, unavailable, openBillingPortal, openFailed, openFailedAddress };
}
