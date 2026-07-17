/**
 * ExportUnlockPrompt — BACKLOG-2075 (Option A: gate export only).
 *
 * Shown when an export attempt on a LOCKED transaction returns PAYWALL_LOCKED.
 * Converts the block into a DELIVERABLE-FORWARD purchase moment (Option B design):
 * a preview of the audit PDF you get, then a single clear unlock action — NOT an
 * error. Logic is unchanged from the original:
 *   - grant credits held → "Unlock with 1 credit" → unlockWithCredit()
 *     (credits spend BEFORE card; online only).
 *   - zero/unknown balance + a live quote → "Unlock this deal — $X.XX" → hands to
 *     BACKLOG-2015's purchase component (PurchaseUnlockHandoff stub).
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
  /** Human label for the deal (e.g. property address). Falls back to "this deal". */
  transactionLabel?: string | null;
  /** Called after a confirmed unlock (grant or purchase). Caller re-runs the export. */
  onUnlocked: () => void;
  /** Called when the user dismisses the prompt without unlocking. */
  onCancel: () => void;
}

export function ExportUnlockPrompt({
  transactionId,
  transactionLabel,
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

  const dealLabel =
    transactionLabel && transactionLabel.trim() !== "" ? transactionLabel.trim() : "this deal";

  const priceLabel =
    quote !== null
      ? `$${(quote.unitPriceCents / 100).toFixed(2)}${
          quote.currency.toUpperCase() === "USD" ? "" : ` ${quote.currency.toUpperCase()}`
        }`
      : null;

  const creditCount = creditBalance ?? 0;

  return (
    <div className="p-4 sm:p-6" data-testid="export-unlock-prompt">
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {/* 1. Deliverable preview — decorative CSS-only mock of the audit PDF. */}
        <AuditPreviewHeader />

        <div className="px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
          {/* 2. Headline */}
          <h3 className="text-lg font-semibold text-gray-900">
            Your full audit is ready to export
          </h3>

          {/* 3. Sub */}
          <p className="mt-1.5 text-sm leading-relaxed text-gray-600">
            Every email and text on{" "}
            <span className="font-medium text-gray-800">{dealLabel}</span>, in one
            hyperlinked PDF. Unlock once — it&apos;s yours to export forever.
          </p>

          {/* Genuine unlock-failure message (the ONLY place red is used). */}
          {unlockError && (
            <p className="mt-3 text-sm text-red-600" role="alert">
              {unlockError}
            </p>
          )}

          {/* 4. Primary action */}
          <div className="mt-5">
            {hasGrantCredits ? (
              <button
                type="button"
                onClick={handleUseCredit}
                disabled={unlocking || isLoading}
                data-testid="unlock-with-credit"
                className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-60"
              >
                {unlocking ? "Unlocking…" : "Unlock with 1 credit"}
              </button>
            ) : canPurchase ? (
              <button
                type="button"
                onClick={() => setShowPurchase(true)}
                disabled={isLoading}
                data-testid="unlock-purchase"
                className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:opacity-60"
              >
                {`Unlock this deal — ${priceLabel}`}
              </button>
            ) : (
              <button
                type="button"
                disabled
                data-testid="unlock-offline"
                className="w-full cursor-not-allowed rounded-lg bg-gray-200 px-4 py-3 text-sm font-semibold text-gray-500"
              >
                Unlocking requires an internet connection
              </button>
            )}
          </div>

          {/* 5. Footnote + quiet dismiss */}
          <div className="mt-3 flex items-center justify-between">
            <p className="text-xs text-gray-400">
              {hasGrantCredits
                ? `You have ${creditCount} credit${creditCount === 1 ? "" : "s"} · Reading is always free`
                : "Reading is always free"}
            </p>
            <button
              type="button"
              onClick={onCancel}
              data-testid="unlock-cancel"
              className="text-xs font-medium text-gray-500 hover:text-gray-700"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Decorative, CSS-only mock of the exported audit PDF. Signals "here's the audit
 * you get" — purely presentational: aria-hidden, no images, no real data.
 */
function AuditPreviewHeader(): React.ReactElement {
  return (
    <div
      aria-hidden="true"
      className="relative flex h-32 items-center justify-center overflow-hidden bg-gradient-to-br from-indigo-50 via-indigo-100 to-white"
    >
      {/* The audit document card (slightly rotated). */}
      <div className="relative w-40 -rotate-3 rounded-md border border-gray-200 bg-white p-3 shadow-md">
        {/* "PDF" badge tab. */}
        <div className="absolute -right-2 -top-2 rounded bg-indigo-600 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white shadow">
          PDF
        </div>
        {/* Index lines: one indigo "title" + a few grey lines. */}
        <div className="mb-2 h-1.5 w-2/3 rounded-full bg-indigo-400" />
        <div className="mb-1.5 h-1 w-full rounded-full bg-gray-200" />
        <div className="mb-1.5 h-1 w-5/6 rounded-full bg-gray-200" />
        <div className="mb-2.5 h-1 w-4/6 rounded-full bg-gray-200" />
        {/* Thread "bubbles": two left, one right-aligned. */}
        <div className="mb-1 h-2.5 w-3/5 rounded-md rounded-bl-none bg-gray-100" />
        <div className="mb-1 ml-auto h-2.5 w-2/5 rounded-md rounded-br-none bg-indigo-200" />
        <div className="h-2.5 w-1/2 rounded-md rounded-bl-none bg-gray-100" />
      </div>
    </div>
  );
}

export default ExportUnlockPrompt;
