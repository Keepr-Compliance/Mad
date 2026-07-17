/**
 * PurchaseUnlockHandoff — BACKLOG-2075 → BACKLOG-2015 integration seam (STUB).
 *
 * When a user with NO grant credits chooses to unlock a locked transaction for
 * export, the paid (card) path is owned by BACKLOG-2015 (PAYG Checkout, saved-card
 * one-click, SCA/3DS fallback, offline purchase states). BACKLOG-2075 only defines
 * the BOUNDARY: it renders this component and reacts to `onUnlocked` / `onCancel`.
 *
 * This is a deliberate placeholder. 2015 replaces the body with the real Checkout
 * handoff. Do NOT add purchase logic here — the single integration seam is the
 * `onUnlocked` callback (fired after 2015 confirms a paid unlock), which the caller
 * uses to re-derive entitlement and proceed with the export.
 */

import React from "react";
import type { UnlockQuote } from "../../services/entitlementService";

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

/**
 * STUB: renders a placeholder until BACKLOG-2015 fills in the Checkout flow.
 * `onUnlocked` is intentionally unused here (2015 wires it); `onCancel` lets the
 * user back out so the stub is still interactive/testable.
 */
export function PurchaseUnlockHandoff({
  localTransactionId,
  quote,
  onUnlocked: _onUnlocked,
  onCancel,
}: PurchaseUnlockHandoffProps): React.ReactElement {
  const priceLabel =
    quote !== null
      ? `$${(quote.unitPriceCents / 100).toFixed(2)} ${quote.currency.toUpperCase()}`
      : null;

  return (
    <div
      className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-center"
      data-testid="purchase-unlock-handoff"
      data-transaction-id={localTransactionId}
    >
      <p className="text-sm font-medium text-gray-900">
        Purchase flow coming soon
        {priceLabel ? ` — ${priceLabel}` : ""}
      </p>
      <p className="mt-1 text-xs text-gray-600">
        Card checkout is handled by the purchase module (BACKLOG-2015).
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        Cancel
      </button>
    </div>
  );
}

export default PurchaseUnlockHandoff;
