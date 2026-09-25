/**
 * StrictFeatureContext — BACKLOG-3476.
 *
 * Resolves the strict (fail-closed) plan state of `transaction_checklists`
 * ONCE for the signed-in session, above the transaction modal, so the
 * Checklist tab renders on the modal's first frame with the other tabs instead
 * of waiting one IPC round trip on every open.
 *
 * Main is still the authority (`feature-gate:strict-state`, and every gated
 * checklist write re-checks in main). This only remembers main's last answer.
 *
 * ## What it will and will not show
 *
 * - **Nothing before main answers.** The first read of a session is `pending`
 *   until main replies; pending shows no tab.
 * - **Keyed on the user id only.** The stored answer carries the user it was
 *   asked FOR (captured when the request is SENT). A different user, or no
 *   user, reads `pending` in the same render. An answer that lands after the
 *   user changed is dropped. The organization is NOT in the key: main answers
 *   for its own session and org, and the licence read can briefly report no
 *   organization for a signed-in user, which would otherwise hide the tab. An
 *   organization change is a background re-ask instead.
 * - **Never older than 5 minutes.** An answer older than main's own plan-cache
 *   TTL reads `pending` and is asked again.
 * - **Re-asked in the background** — the stored answer keeps showing while the
 *   question is in flight — on every transaction open, on window focus (only
 *   when nothing was asked in the last minute), and on an organization change.
 *   Signing in is a user change, so it asks at once.
 *
 * So the first frame of an open may paint an answer up to ~10 minutes stale
 * (this store's 5 minutes on top of main's own 5-minute plan cache) for one
 * IPC round trip, until the open's background re-ask lands. Steady state is
 * bounded by main's 5 minutes, as before. Any write in that window is still
 * refused by main.
 *
 * Only `TransactionDetails` reads this (`useSessionStrictFeatureState`). The
 * other strict consumers keep `useStrictFeatureState`, unchanged.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  StrictFeatureState,
  StrictFeatureStateOrPending,
} from "../../electron/types/featureGate";

/** The one key this store holds. */
export const SESSION_STRICT_FEATURE_KEY = "transaction_checklists" as const;
export type SessionStrictFeatureKey = typeof SESSION_STRICT_FEATURE_KEY;

/** Main's plan-cache TTL (`CACHE_TTL_MS`, featureGateService.ts). */
export const STRICT_ANSWER_TTL_MS = 5 * 60 * 1000;
/** The LicenseContext focus throttle. */
export const STRICT_FOCUS_THROTTLE_MS = 60 * 1000;

interface StoredAnswer {
  /** The user the question was sent for. */
  forUserId: string;
  state: StrictFeatureState;
  expired: boolean;
}

interface StrictFeatureContextValue {
  /** The answer for the current user, or `pending`. */
  state: StrictFeatureStateOrPending;
  /** Ask main again in the background; the stored answer keeps showing. */
  reask: () => void;
}

const StrictFeatureContext = createContext<StrictFeatureContextValue | null>(null);

export function StrictFeatureProvider({
  userId,
  organizationId,
  children,
}: {
  userId: string | null;
  organizationId: string | null;
  children: React.ReactNode;
}): React.ReactElement {
  const [answer, setAnswer] = useState<StoredAnswer | null>(null);
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const sentSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const lastAskAtRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const ask = useCallback(() => {
    // Stamped with the user it is asked FOR, at send time.
    const forUserId = userIdRef.current;
    if (!forUserId) return;
    lastAskAtRef.current = Date.now();
    const seq = ++sentSeqRef.current;
    const land = (state: StrictFeatureState) => {
      if (!mountedRef.current) return;
      // Dropped when the user changed while it was in flight, or when a newer
      // question has already been answered.
      if (userIdRef.current !== forUserId || seq < appliedSeqRef.current) return;
      appliedSeqRef.current = seq;
      setAnswer({ forUserId, state, expired: false });
    };
    // Awaited inside the try: a bridge without the method throws synchronously,
    // and the honest answer then is that the plan could not be read.
    void (async () => {
      try {
        land(await window.api.featureGate.strictState(SESSION_STRICT_FEATURE_KEY));
      } catch {
        land("unknown");
      }
    })();
  }, []);

  // A new user is asked at once; signing out asks nothing.
  useEffect(() => {
    if (userId) ask();
  }, [userId, ask]);

  // An organization change re-asks in the background (not a pending reset).
  const firstOrgRef = useRef(true);
  useEffect(() => {
    if (firstOrgRef.current) {
      firstOrgRef.current = false;
      return;
    }
    ask();
  }, [organizationId, ask]);

  // Window focus, only when nothing was asked in the last minute.
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastAskAtRef.current < STRICT_FOCUS_THROTTLE_MS) return;
      ask();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ask]);

  // Past the TTL the answer reads pending, and is asked again.
  useEffect(() => {
    if (!answer || answer.expired) return;
    const timer = setTimeout(() => {
      setAnswer((current) => (current === answer ? { ...current, expired: true } : current));
      ask();
    }, STRICT_ANSWER_TTL_MS + 1);
    return () => clearTimeout(timer);
  }, [answer, ask]);

  const state: StrictFeatureStateOrPending =
    answer && userId && answer.forUserId === userId && !answer.expired ? answer.state : "pending";

  const value = useMemo<StrictFeatureContextValue>(
    () => ({ state, reask: ask }),
    [state, ask],
  );

  return <StrictFeatureContext.Provider value={value}>{children}</StrictFeatureContext.Provider>;
}

/**
 * The session's answer for `transaction_checklists`, and a background re-ask
 * on every mount (so each transaction open corrects a changed plan one IPC
 * later without hiding the tab meanwhile).
 *
 * Outside a provider (a component rendered bare in a test) it behaves as
 * `useStrictFeatureState`: pending, then one invoke per mount.
 */
export function useSessionStrictFeatureState(
  featureKey: SessionStrictFeatureKey,
): StrictFeatureStateOrPending {
  const context = useContext(StrictFeatureContext);
  const hasProvider = context !== null;
  const reask = context?.reask;
  const [local, setLocal] = useState<StrictFeatureStateOrPending>("pending");

  useEffect(() => {
    if (hasProvider) {
      reask?.();
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.api.featureGate.strictState(featureKey);
        if (!cancelled) setLocal(result);
      } catch {
        if (!cancelled) setLocal("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
    // `reask` is stable for the provider's life, so this is one re-ask per mount.
  }, [hasProvider, reask, featureKey]);

  return context ? context.state : local;
}
