/**
 * BACKLOG-3520 — the "Closing Financials" block of "Verify Transaction
 * Details": Sale Price, Commission Offered, Commission Actual, the computed
 * Commission Amount and, only when the two rates differ, an optional reason.
 *
 * Built to the signed-off mock (claude.ai artifact 8NQW5ucuXGXF78LEomHEso,
 * draft 5): field help lives in InfoTooltips beside the labels (no helper lines
 * under the inputs), labels carry no "(%)" — the input has a % suffix — and the
 * amount shows alone, an em dash while Actual is empty.
 *
 * An empty commission WARNS and never blocks: the warning is an inline notice
 * on this screen (below), not a dialog and not a click the agent must make.
 */
import React from "react";
import { InfoTooltip } from "../common/InfoTooltip";
import { COMMISSION_REASON_MAX_LENGTH, formatCommissionAmount } from "./commission";
import type { CommissionForm } from "./useCommissionForm";
import { formatCurrency } from "@/utils/formatUtils";

const INPUT_CLASS =
  "w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 text-gray-900 bg-white min-h-[44px]";

function Label({
  htmlFor,
  text,
  help,
}: {
  htmlFor: string;
  text: string;
  help?: string;
}): React.ReactElement {
  return (
    <div className="flex items-center mb-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700 whitespace-nowrap">
        {text}
      </label>
      {help && <InfoTooltip text={help} />}
    </div>
  );
}

/** What an empty commission means on each route. Nothing here gates Next. */
const NOT_ENTERED_WARNING = {
  submit: "Commission not entered. Your broker will see this submission without a commission figure.",
  export: "Commission not entered. This export will not include a commission figure.",
} as const;

export function CommissionFields({
  commission,
  route,
}: {
  commission: CommissionForm;
  route: keyof typeof NOT_ENTERED_WARNING;
}): React.ReactElement {
  const { inputs, parsed } = commission;
  const parsedOk = parsed.ok;
  const rateDiffers = parsed.ok && parsed.value.rateDiffers;
  const gross = parsed.ok ? parsed.value.gross : null;
  const saleHelp =
    commission.listingPrice !== null
      ? `From the transaction. Listing price ${formatCurrency(commission.listingPrice)}.`
      : "From the transaction.";
  const actualHelp = commission.actualFollowsOffered
    ? "Copied from offered. Change it if you were paid a different rate."
    : "Rate you were paid at close";

  return (
    <div data-testid="commission-fields">
      <h4 className="mt-4 pt-4 border-t border-gray-200 text-sm font-semibold text-gray-900">
        Closing Financials
      </h4>
      <div className="mt-3 space-y-3">
        {!parsed.ok && (
          <div
            className="p-3 bg-red-50 border border-red-200 rounded-lg"
            data-testid="commission-error"
            role="alert"
          >
            <p className="text-sm text-red-800">{parsed.error}</p>
          </div>
        )}

        <div>
          <Label htmlFor="commission-sale" text="Sale Price" help={saleHelp} />
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">$</span>
            <input
              id="commission-sale"
              data-testid="commission-sale"
              type="text"
              inputMode="decimal"
              value={inputs.saleText}
              onChange={(e) => commission.setSaleText(e.target.value)}
              className={`${INPUT_CLASS} pl-7`}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3" data-testid="commission-rates-row">
          <div>
            <Label
              htmlFor="commission-offered"
              text="Commission Offered"
              help="Rate in your listing or representation agreement"
            />
            <div className="relative">
              <input
                id="commission-offered"
                data-testid="commission-offered"
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={inputs.offeredText}
                onChange={(e) => commission.setOfferedText(e.target.value)}
                className={`${INPUT_CLASS} pr-7`}
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">%</span>
            </div>
          </div>
          <div>
            <Label htmlFor="commission-actual" text="Commission Actual" help={actualHelp} />
            <div className="relative">
              <input
                id="commission-actual"
                data-testid="commission-actual"
                type="number"
                step="0.1"
                min="0"
                max="100"
                value={inputs.actualText}
                onChange={(e) => commission.setActualText(e.target.value)}
                className={`${INPUT_CLASS} pr-7`}
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">%</span>
            </div>
          </div>
          <div>
            <div className="flex items-center mb-1">
              <span className="block text-sm font-medium text-gray-700 whitespace-nowrap">Commission Amount</span>
            </div>
            <div className="flex items-center min-h-[44px]">
              <span
                className="text-lg font-semibold text-gray-900 tabular-nums"
                data-testid="commission-amount"
              >
                {formatCommissionAmount(gross)}
              </span>
            </div>
          </div>
        </div>

        {parsedOk && !commission.complete && (
          <div
            className="p-3 bg-amber-50 border border-amber-200 rounded-lg"
            data-testid="commission-warning"
            role="status"
          >
            <p className="text-sm text-amber-800">{NOT_ENTERED_WARNING[route]}</p>
          </div>
        )}

        {rateDiffers && (
          <div>
            <Label htmlFor="commission-reason" text="Reason for the difference (optional)" />
            <input
              id="commission-reason"
              data-testid="commission-reason"
              type="text"
              maxLength={COMMISSION_REASON_MAX_LENGTH}
              value={inputs.reasonText}
              onChange={(e) => commission.setReasonText(e.target.value)}
              placeholder="e.g. Reduced to close the deal"
              className={INPUT_CLASS}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default CommissionFields;
