/**
 * PurchaseUnlockHandoff — BACKLOG-2075 seam → BACKLOG-2015 card-purchase flow.
 *
 * The zero-balance card path for unlocking a locked transaction's EXPORT. Reached
 * from ExportUnlockPrompt when the user has no grant credits but a live PAYG
 * quote. Two flows (server-quoted price; the MAIN process owns all money/JWT):
 *
 *   Flow A (first purchase / fallback): open Stripe Checkout in the system
 *     browser; on the keepr://payment-callback return, confirm via the
 *     authoritative entitlement gate re-read → onUnlocked (caller re-runs export).
 *   Flow B (repeat, saved card): one-click confirm (informed consent — no silent
 *     charge) → off-session charge. SCA/3DS opens a hosted page (returns via the
 *     same deep link); a 3DS with no hosted URL falls back to Flow A. Hard decline
 *     → clear retry / other-card. No saved card → Flow A.
 *
 * FAIL-CLOSED: no state reveals content; onUnlocked fires ONLY after main
 * confirms a real paid unlock (transaction_unlocks gate re-read). A portal 200
 * alone never unlocks. Offline → disabled (purchases require online).
 *
 * StrictMode-safe: the deep-link subscription effect uses a per-run cancelled
 * flag and depends on stable values (no didMount guard). Props/exports are
 * byte-stable with the 2075 stub so the ExportUnlockPrompt caller is unchanged.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { UnlockQuote } from "../../services/entitlementService";
import { paymentService } from "../../services/paymentService";
import logger from "../../utils/logger";

export interface PurchaseUnlockHandoffProps {
  /** The local transaction id being unlocked (== transaction_unlocks.local_transaction_id). */
  localTransactionId: string;
  /** Live PAYG quote for the paid unlock. Null when unavailable (offline/error). */
  quote: UnlockQuote | null;
  /** Called by BACKLOG-2015 after a paid unlock is confirmed. Caller re-runs the export. */
  onUnlocked: () => void;
  /** Called when the user backs out of the purchase. */
  onCancel: () => void;
}

/** UI phases. None reveals content; only a confirmed unlock calls onUnlocked. */
type Phase =
  | "idle" // show quote + primary CTA (consent copy for saved-card)
  | "starting" // creating Checkout / charging
  | "awaiting-browser" // Checkout / SCA opened externally; waiting for the deep-link return
  | "confirming" // browser returned; polling the authoritative gate
  | "declined" // hard decline — retry / other card
  | "error"; // unexpected failure — retry

function formatPrice(quote: UnlockQuote): string {
  const usd = quote.currency.toUpperCase() === "USD";
  return `$${(quote.unitPriceCents / 100).toFixed(2)}${usd ? "" : ` ${quote.currency.toUpperCase()}`}`;
}

export function PurchaseUnlockHandoff({
  localTransactionId,
  quote,
  onUnlocked,
  onCancel,
}: PurchaseUnlockHandoffProps): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // null = not yet checked; drives "one-click" (Flow B) vs "Checkout" (Flow A) copy.
  const [hasSavedCard, setHasSavedCard] = useState<boolean | null>(null);

  // Fail-closed: no live quote (offline/error) ⇒ purchases unavailable.
  const canPurchase = quote !== null;

  // Guards against a stale async resolve calling setState after the component
  // moved on / unmounted (StrictMode double-invoke safe: value-based, no didMount).
  const activeRef = useRef(true);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // Saved-card eligibility — re-checked per mount/purchase intent, never cached
  // across a session (a card may be saved mid-session by a first purchase).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { hasSavedCard: saved } = await paymentService.hasSavedCard();
      if (!cancelled) setHasSavedCard(saved);
    })();
    return () => {
      cancelled = true;
    };
  }, [localTransactionId]);

  /** Confirm after a browser return (Checkout or SCA). Fail-closed via main. */
  const confirmUnlock = useCallback(
    async (sessionId: string | null): Promise<void> => {
      setPhase("confirming");
      setErrorMessage(null);
      const result = await paymentService.confirm(localTransactionId, sessionId);
      if (!activeRef.current) return;
      if (result.unlocked) {
        onUnlocked();
        return;
      }
      setPhase("error");
      setErrorMessage(
        result.reason === "offline"
          ? "You appear to be offline. Reconnect and try again."
          : "We couldn't confirm your payment yet. If you were charged, it will unlock shortly — try again in a moment.",
      );
    },
    [localTransactionId, onUnlocked],
  );

  // Subscribe to the payment deep-link callback (browser returned from Checkout
  // / SCA). StrictMode-safe: per-run cancelled flag; cleanup removes the listener.
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = paymentService.onDeepLinkCallback((data) => {
      if (cancelled) return;
      void confirmUnlock(data.sessionId);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [confirmUnlock]);

  /** Flow A — first purchase / fallback: open Checkout in the system browser. */
  const startCheckout = useCallback(async (): Promise<void> => {
    setPhase("starting");
    setErrorMessage(null);
    const result = await paymentService.beginCheckout(localTransactionId);
    if (!activeRef.current) return;
    if (result.started) {
      setPhase("awaiting-browser");
      return;
    }
    setPhase("error");
    setErrorMessage(
      result.error === "offline"
        ? "You appear to be offline. Reconnect and try again."
        : result.error === "unauthenticated"
          ? "Please sign in again to continue."
          : "We couldn't start the checkout. Please try again.",
    );
  }, [localTransactionId]);

  /** Flow B — saved card one-click: off-session charge, with SCA / decline handling. */
  const chargeSavedCard = useCallback(async (): Promise<void> => {
    setPhase("starting");
    setErrorMessage(null);
    const result = await paymentService.chargeSavedCard(localTransactionId);
    if (!activeRef.current) return;

    switch (result.outcome) {
      case "succeeded":
        // Webhook fulfills; confirm via the authoritative gate re-read.
        void confirmUnlock(null);
        return;
      case "requires_action":
        if (result.redirectUrl) {
          // SCA hosted page opened externally; returns via the deep link.
          setPhase("awaiting-browser");
        } else {
          // 3DS with no hosted URL ⇒ fall back to full Checkout (handles 3DS).
          logger.info("[Payment] SCA required with no hosted URL — falling back to Checkout");
          void startCheckout();
        }
        return;
      case "no_saved_card":
        // Optimization was stale — run the first-purchase Checkout.
        void startCheckout();
        return;
      case "declined":
        setPhase("declined");
        setErrorMessage("Your card was declined. Try another card to continue.");
        return;
      case "offline":
        setPhase("error");
        setErrorMessage("You appear to be offline. Reconnect and try again.");
        return;
      default:
        setPhase("error");
        setErrorMessage("Something went wrong. Please try again.");
    }
  }, [localTransactionId, confirmUnlock, startCheckout]);

  /** Primary CTA: Flow B when a saved card is known, else Flow A. */
  const handlePrimary = useCallback((): void => {
    if (hasSavedCard) {
      void chargeSavedCard();
    } else {
      void startCheckout();
    }
  }, [hasSavedCard, chargeSavedCard, startCheckout]);

  const priceLabel = quote !== null ? formatPrice(quote) : null;
  const busy = phase === "starting" || phase === "confirming" || phase === "awaiting-browser";

  // Offline / no-quote: fail-closed disabled state.
  if (!canPurchase) {
    return (
      <div
        className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-center"
        data-testid="purchase-unlock-handoff"
        data-transaction-id={localTransactionId}
        data-phase={phase}
      >
        <p className="text-sm font-medium text-gray-900">
          Unlocking requires an internet connection
        </p>
        <button
          type="button"
          onClick={onCancel}
          data-testid="purchase-cancel"
          className="mt-3 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Not now
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-indigo-200 bg-indigo-50 p-4"
      data-testid="purchase-unlock-handoff"
      data-transaction-id={localTransactionId}
      data-phase={phase}
    >
      <p className="text-sm font-semibold text-gray-900">
        Unlock this deal — {priceLabel}
      </p>
      {quote !== null && (
        <p className="mt-1 text-xs text-gray-600">
          Your {ordinal(quote.nextUnitIndex)} paid deal this year.
        </p>
      )}

      {/* Consent / mandate copy for the saved-card off-session charge (founder
          hard requirement: informed consent, per-unlock, no silent charging). */}
      {hasSavedCard && (
        <p className="mt-2 text-xs text-gray-500" data-testid="saved-card-consent">
          You&apos;ll be charged {priceLabel} to your saved card to unlock this deal. One tap
          per unlock — we never charge automatically.
        </p>
      )}

      {/* Awaiting the browser return (Checkout / SCA). */}
      {phase === "awaiting-browser" && (
        <p className="mt-3 text-xs text-indigo-700" data-testid="purchase-awaiting-browser">
          Complete your payment in the browser window that just opened, then return here.
        </p>
      )}

      {/* Confirming after return. */}
      {phase === "confirming" && (
        <p className="mt-3 text-xs text-indigo-700" data-testid="purchase-confirming">
          Payment received — confirming your unlock…
        </p>
      )}

      {/* Error / decline messaging (the only place red is used). */}
      {errorMessage && (
        <p className="mt-3 text-sm text-red-600" role="alert" data-testid="purchase-error">
          {errorMessage}
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handlePrimary}
          disabled={busy || hasSavedCard === null}
          data-testid="purchase-confirm"
          className="flex-1 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-60"
        >
          {primaryLabel(phase, hasSavedCard, priceLabel)}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={phase === "confirming"}
          data-testid="purchase-cancel"
          className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Primary button label per phase. */
function primaryLabel(
  phase: Phase,
  hasSavedCard: boolean | null,
  priceLabel: string | null,
): string {
  if (phase === "starting") return "Starting…";
  if (phase === "confirming") return "Confirming…";
  if (phase === "awaiting-browser") return "Waiting for browser…";
  if (phase === "declined") return "Try another card";
  if (phase === "error") return "Try again";
  if (hasSavedCard) return `Confirm — ${priceLabel ?? "unlock"}`;
  return `Continue to checkout — ${priceLabel ?? "unlock"}`;
}

/** Small ordinal helper for "your Nth paid deal this year". */
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export default PurchaseUnlockHandoff;
