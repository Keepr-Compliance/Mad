/**
 * usePlanSummary — BACKLOG-3863 (the hook slice 3's PlanBillingCard uses).
 *
 * - Reads the plan summary once on mount (Settings open).
 * - `openBillingPortal()` opens the portal Billing page. The renderer
 *   billingService arms the return-from-billing one-shot (for every caller, not
 *   only this hook) and this hook subscribes to the fresh summary it produces.
 *
 * - `subscribe()` (BACKLOG-4088) opens the Agent plan Checkout from the plan card
 *   during a free trial (the export paywall's IPC, paymentService.beginSubscription)
 *   and arms the same refresh-on-return.
 *
 * Display only: `summary` never gates anything. `unavailable` means show the
 * feature-gate fallback line (billing off, offline, 5xx, timeout, signed out).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import billingService, { type PlanSummary } from "../../../services/billingService";
import { paymentService, type SubscriptionRefusalCode } from "../../../services/paymentService";

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
  /** BACKLOG-4088: open the Agent plan Checkout; arms the refresh-on-return when it opened. */
  subscribe: () => Promise<void>;
  /** BACKLOG-4088: true while the Checkout is being opened. */
  subscribing: boolean;
  /** BACKLOG-4088: why the last Subscribe did not open Checkout ("offline" reads as try_again), else null. */
  subscribeRefusal: SubscriptionRefusalCode | null;
}

export function usePlanSummary(): UsePlanSummary {
  const [summary, setSummary] = useState<PlanSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [openFailedAddress, setOpenFailedAddress] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [subscribeRefusal, setSubscribeRefusal] = useState<SubscriptionRefusalCode | null>(null);
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

  useEffect(() => billingService.onReturnRefresh(apply), [apply]);

  const openBillingPortal = useCallback(async () => {
    const result = await billingService.openPortal();
    if (!mountedRef.current) return;
    if (result.success) {
      setOpenFailed(false);
      setOpenFailedAddress(null);
    } else {
      setOpenFailed(true);
      setOpenFailedAddress(typeof result.portalAddress === "string" ? result.portalAddress : null);
    }
  }, []);

  const subscribe = useCallback(async () => {
    setSubscribing(true);
    try {
      const result = await paymentService.beginSubscription();
      if (!mountedRef.current) return;
      if (result.started) {
        setSubscribeRefusal(null);
        billingService.armReturnRefresh();
      } else {
        setSubscribeRefusal(result.code === "offline" ? "try_again" : result.code);
      }
    } finally {
      if (mountedRef.current) setSubscribing(false);
    }
  }, []);

  return {
    summary,
    loading,
    unavailable,
    openBillingPortal,
    openFailed,
    openFailedAddress,
    subscribe,
    subscribing,
    subscribeRefusal,
  };
}
