/**
 * AddressVerificationStep Component
 * Step 1 of the AuditTransactionModal - Address input and verification
 * Extracted from AuditTransactionModal as part of TASK-974 decomposition
 *
 * BACKLOG-1824: Added dropdown dismiss behavior:
 *   - Escape key closes the dropdown
 *   - Click / mousedown outside the input+dropdown wrapper closes it
 *   - Input blur (with 150 ms delay so a suggestion click can still fire) closes it
 *   - Empty / zero results never render the dropdown at all
 *   - Dismissal is tracked in local state; fresh suggestions from the parent
 *     reset dismissed so the dropdown re-appears on the next search
 *   - z-index raised to z-50 so the panel never traps focus over date fields
 */
import React, { useRef, useState, useEffect, useCallback } from "react";
import type { AddressData, AddressSuggestion } from "../../hooks/useAuditTransaction";
// BACKLOG-2805: the words on the two buttons. The values they emit are the
// stored enum and are spelled out below, unchanged.
import { TRANSACTION_TYPE_LABELS } from "../../constants/transactionTypes";
import { InfoTooltip } from "../common/InfoTooltip";
import LiveMoneyInput from "../common/LiveMoneyInput";

interface AddressVerificationStepProps {
  addressData: AddressData;
  onAddressChange: (value: string) => void;
  onTransactionTypeChange: (type: string) => void;
  onStartDateChange: (date: string) => void;
  onClosingDateChange: (date: string | undefined) => void;
  onEndDateChange: (date: string | undefined) => void;
  /** BACKLOG-3614: the optional Listing Price, as typed. */
  onListingPriceChange?: (text: string) => void;
  showAutocomplete: boolean;
  suggestions: AddressSuggestion[];
  onSelectSuggestion: (suggestion: AddressSuggestion) => void;
  startDateMode?: "manual";
  /**
   * BACKLOG-3613: render the End Date input. Only the Edit Transaction Details
   * screen passes true. Creating a deal asks for the start date only — the
   * end date stays empty (an ongoing deal) and is entered later, at Submit
   * for review or Export.
   */
  showEndDate?: boolean;
}

function AddressVerificationStep({
  addressData,
  onAddressChange,
  onTransactionTypeChange,
  onStartDateChange,
  // onClosingDateChange is still part of the props contract (callers pass it and
  // the Export modal still sets a closing date) but this step no longer renders
  // a Closing Date field, so it is deliberately not destructured here.
  onEndDateChange,
  onListingPriceChange,
  showAutocomplete,
  suggestions,
  onSelectSuggestion,
  showEndDate = false,
}: AddressVerificationStepProps): React.ReactElement {
  // Local flag that lets the user dismiss the dropdown without the parent hook
  // needing to know about it. Resets automatically when fresh suggestions arrive.
  const [dismissed, setDismissed] = useState(false);

  // Ref wrapping the whole input+dropdown area for click-outside detection.
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Timer handle for the blur-delay so a suggestion click can fire before dismiss.
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When the parent delivers a new batch of suggestions, show the dropdown again.
  useEffect(() => {
    if (showAutocomplete && suggestions.length > 0) {
      setDismissed(false);
    }
  }, [showAutocomplete, suggestions]);

  // Dismiss on mousedown anywhere outside the wrapper.
  useEffect(() => {
    const onGlobalMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDismissed(true);
      }
    };
    document.addEventListener("mousedown", onGlobalMouseDown);
    return () => document.removeEventListener("mousedown", onGlobalMouseDown);
  }, []);

  // Cleanup the blur timer on unmount to avoid state updates on an unmounted component.
  useEffect(() => {
    return () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        setDismissed(true);
      }
    },
    [],
  );

  // Defer dismiss by 150 ms so a mousedown on a suggestion button fires first.
  const handleBlur = useCallback(() => {
    blurTimerRef.current = setTimeout(() => {
      setDismissed(true);
    }, 150);
  }, []);

  // Called on the mousedown of a suggestion button — cancels the pending blur timer
  // so the subsequent click event is not swallowed by the dismiss logic.
  const handleSuggestionMouseDown = useCallback(() => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }, []);

  const handleSuggestionClick = useCallback(
    (suggestion: AddressSuggestion) => {
      setDismissed(true);
      onSelectSuggestion(suggestion);
    },
    [onSelectSuggestion],
  );

  // The dropdown is visible only when: parent says show it AND there are results
  // AND the user has not dismissed it.
  const isDropdownVisible = showAutocomplete && suggestions.length > 0 && !dismissed;

  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Property Address *
        </label>
        <div className="relative" ref={wrapperRef}>
          <input
            type="text"
            value={addressData.property_address}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              onAddressChange(e.target.value)
            }
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            placeholder="Enter property address..."
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-gray-900 bg-white min-h-[44px]"
            autoComplete="off"
            data-testid="create-audit-address-input"
          />
          {isDropdownVisible && (
            <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-y-auto">
              {suggestions.map(
                (suggestion: AddressSuggestion, index: number) => (
                  <button
                    key={suggestion.place_id || suggestion.placeId || index}
                    onMouseDown={handleSuggestionMouseDown}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className="w-full text-left px-4 py-2 hover:bg-indigo-50 transition-colors border-b border-gray-100 last:border-b-0"
                  >
                    <p className="font-medium text-gray-900">
                      {suggestion.main_text ||
                        suggestion.description ||
                        "Address"}
                    </p>
                    <p className="text-xs text-gray-500">
                      {suggestion.secondary_text || ""}
                    </p>
                  </button>
                ),
              )}
            </div>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Start typing to see verified addresses from Google Places
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-3">
          Transaction Type *
        </label>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => onTransactionTypeChange("purchase")}
            className={`px-4 py-3 rounded-lg font-medium transition-all ${
              addressData.transaction_type === "purchase"
                ? "bg-indigo-500 text-white shadow-md"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
            data-testid="create-audit-type-purchase"
          >
            {TRANSACTION_TYPE_LABELS.purchase}
          </button>
          <button
            onClick={() => onTransactionTypeChange("sale")}
            className={`px-4 py-3 rounded-lg font-medium transition-all ${
              addressData.transaction_type === "sale"
                ? "bg-indigo-500 text-white shadow-md"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
            data-testid="create-audit-type-sale"
          >
            {TRANSACTION_TYPE_LABELS.sale}
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="flex items-center text-sm font-medium text-gray-700">
            Transaction Dates
            {/* One (i) for the dates shown (founder, 2026-09-17, BACKLOG-3415).
                It replaced the tooltip on the start-date label and the helper
                lines that sat under the inputs, so this is the only place the
                dates are explained. Creating a deal shows the start date only,
                so the (i) explains the start date only (BACKLOG-3613). Editing
                a deal shows both dates and the (i) explains both; the End Date
                wording is the founder's own definition. */}
            {/* BACKLOG-3415: each date's name bold on its own line, its
                definition beneath, a blank line between entries. */}
            <InfoTooltip
              wide
              text={
                <span className="block space-y-3">
                  <span className="block">
                    <strong className="block font-semibold">Representation Start Date</strong>
                    when you started representing this client on this deal.
                  </span>
                  {showEndDate && (
                    <span className="block">
                      <strong className="block font-semibold">End Date</strong>
                      the last date you communicated with the client about this transaction, by text or email.
                    </span>
                  )}
                </span>
              }
            />
          </label>
        </div>

        {/* Creating a deal: Representation Start Date and Listing Price side
            by side from sm: up (founder, 2026-09-29, BACKLOG-3614). The end
            date stays empty — an ongoing deal — and is entered at Submit for
            review or Export (BACKLOG-3613).
            Editing a deal: start date, end date and Listing Price on one row
            from sm: up. Below sm: every field stacks, full width.
            The closing date is not asked for here — it is optional in the data
            model and is set later from the Export modal. */}
        <div
          className={`grid grid-cols-1 gap-4 ${showEndDate ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
          data-testid="create-audit-dates-row"
        >
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Representation Start Date *
            </label>
            <input
              type="date"
              value={addressData.started_at}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onStartDateChange(e.target.value)
              }
              className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-gray-900 min-h-[44px] ${
                !addressData.started_at
                  ? "border-red-300 bg-red-50"
                  : "border-gray-300 bg-white"
              }`}
              required
              data-testid="create-audit-start-date-input"
            />
          </div>
          {showEndDate && (
            <div>
              {/* Deliberately optional, and deliberately NOT marked required: an
                  empty end date is how an ongoing deal is represented. The audit
                  window then rolls forward to today (emailDateRange.ts) and the
                  transaction reads as "<start> - Ongoing" in the details tab. An
                  asterisk was tried here and reverted (founder, 2026-09-16) —
                  requiring it would make an open deal impossible to create or to
                  re-save, and would cap message capture at an invented date. */}
              <label className="block text-xs font-medium text-gray-600 mb-1">
                End Date
              </label>
              <input
                type="date"
                value={addressData.closed_at || ""}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  onEndDateChange(e.target.value || undefined)
                }
                min={addressData.started_at}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-gray-900 bg-white min-h-[44px]"
                data-testid="create-audit-end-date-input"
              />
            </div>
          )}
          {/* BACKLOG-3614: Listing Price, OPTIONAL (founder, 2026-09-29) — no
              asterisk, no `required`, no red-when-empty border; blank never
              blocks Continue or create. Commas are added as you type
              (LiveMoneyInput); the text is parsed by `parseMoney` on save, so
              the stored value is a plain number. Shown on create and on Edit
              Transaction Details. */}
          <div>
            <label
              htmlFor="create-audit-listing-price"
              className="block text-xs font-medium text-gray-600 mb-1"
            >
              Listing Price
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm text-gray-500 pointer-events-none">
                $
              </span>
              <LiveMoneyInput
                id="create-audit-listing-price"
                inputMode="decimal"
                value={addressData.listing_price_text ?? ""}
                onValueChange={(text) => onListingPriceChange?.(text)}
                className="w-full pl-7 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-gray-900 bg-white min-h-[44px]"
                data-testid="create-audit-listing-price-input"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-start gap-2">
          <svg
            className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-900">
              About Date Range
            </p>
            <p className="text-xs text-blue-700 mt-1">
              Messages will be linked to this transaction only if they fall
              within the specified date range. This prevents linking unrelated
              older messages.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AddressVerificationStep;
