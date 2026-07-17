/**
 * ExportUnlockPrompt — BACKLOG-2075 (Option A: gate export only).
 *
 * Shown when an export attempt on a LOCKED transaction returns PAYWALL_LOCKED.
 * Converts the raw error into a purchase moment:
 *   - grant credits held → "Unlock with 1 credit (you have N)" → unlockWithCredit()
 *     (credits spend BEFORE card; online only).
 *   - zero/unknown balance + a live quote → "Unlock this deal to export — $X.XX
 *     (your Nth paid deal this year)" → hands to BACKLOG-2015's purchase component.
 *   - offline / no quote → disabled "online required" (fail-closed: never a free export).
 *
 * On a successful unlock (grant or purchase), `onUnlocked` fires and the caller
 * re-runs the export (now UNLOCKED ⇒ the main gate returns the full record).
 *
 * Consumes the 2006a entitlement hook; makes NO gate decision itself. Rendered
 * inline inside the already-open ExportModal (not a modal-over-modal).
 */

import React, { useState } from "react";
import { useTransactionEntitlement } from "../../hooks/useTransactionEntitlement";
import { PurchaseUnlockHandoff } from "./PurchaseUnlockHandoff";
import logger from "../../utils/logger";

export interface ExportUnlockPromptProps {
  /** The locked transaction the user tried to export. */
  transactionId: string;
  /** Called after a confirmed unlock (grant or purchase). Caller re-runs the export. */
  onUnlocked: () => void;
  /** Called when the user dismisses the prompt without unlocking. */
  onCancel: () => void;
}

export function ExportUnlockPrompt({
  transactionId,
  onUnlocked,
  onCancel,
}: ExportUnlockPromptProps): React.ReactElement {
  const { quote, creditBalance, unlockWithCredit, isLoading } =
    useTransactionEntitlement(transactionId);

  // Whether to show the card-purchase handoff (zero-balance PAYG path).
  const [showPurchase, setShowPurchase] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const hasGrantCredits = (creditBalance ?? 0) > 0;
  // Fail-closed: no live quote (offline/error) ⇒ the paid path is unavailable.
  const canPurchase = quote !== null;

  const handleUseCredit = async (): Promise<void> => {
    setUnlocking(true);
    setUnlockError(null);
    try {
      const result = await unlockWithCredit();
      if (result.success && result.status === "unlocked") {
        onUnlocked();
        return;
      }
      setUnlockError(
        result.error === "offline"
          ? "Unlocking requires an internet connection."
          : "Could not unlock with a credit. Please try again.",
      );
    } catch (err) {
      logger.error("Credit unlock failed:", err);
      setUnlockError("Could not unlock with a credit. Please try again.");
    } finally {
      setUnlocking(false);
    }
  };

  // The card-purchase handoff owns its own confirm/cancel; BACKLOG-2015 fills it.
  if (showPurchase) {
    return (
      <div className="p-4" data-testid="export-unlock-prompt">
        <PurchaseUnlockHandoff
          localTransactionId={transactionId}
          quote={quote}
          onUnlocked={onUnlocked}
          onCancel={() => setShowPurchase(false)}
        />
      </div>
    );
  }

  const priceLabel =
    quote !== null
      ? `$${(quote.unitPriceCents / 100).toFixed(2)}${
          quote.currency.toUpperCase() === "USD" ? "" : ` ${quote.currency.toUpperCase()}`
        }`
      : null;

  return (
    <div className="p-4 sm:p-6" data-testid="export-unlock-prompt">
      <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 sm:p-5">
        <h3 className="text-base font-semibold text-gray-900">
          Unlock this deal to export
        </h3>
        <p className="mt-1 text-sm text-gray-600">
          Reading is always free. To export the full audit record for this
          transaction, unlock it below. Unlocks are permanent.
        </p>

        {unlockError && (
          <p className="mt-3 text-sm text-red-600" role="alert">
            {unlockError}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          {hasGrantCredits ? (
            // Grant-credit path: credits spend before card.
            <button
              type="button"
              onClick={handleUseCredit}
              disabled={unlocking || isLoading}
              data-testid="unlock-with-credit"
              className="w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {unlocking
                ? "Unlocking…"
                : `Unlock with 1 credit (you have ${creditBalance})`}
            </button>
          ) : canPurchase ? (
            // PAYG path: hand to the purchase component (BACKLOG-2015).
            <button
              type="button"
              onClick={() => setShowPurchase(true)}
              disabled={isLoading}
              data-testid="unlock-purchase"
              className="w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {`Unlock this deal to export — ${priceLabel} (your ${ordinal(
                quote!.nextUnitIndex,
              )} paid deal this year)`}
            </button>
          ) : (
            // Offline / no quote: fail-closed. Never a free export.
            <button
              type="button"
              disabled
              data-testid="unlock-offline"
              className="w-full cursor-not-allowed rounded-md bg-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-500"
            >
              Unlock requires an internet connection
            </button>
          )}

          <button
            type="button"
            onClick={onCancel}
            data-testid="unlock-cancel"
            className="w-full rounded-md border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** English ordinal for the "your Nth paid deal this year" label (1→1st, 2→2nd, …). */
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export default ExportUnlockPrompt;
