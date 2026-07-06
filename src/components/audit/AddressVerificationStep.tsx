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

interface AddressVerificationStepProps {
  addressData: AddressData;
  onAddressChange: (value: string) => void;
  onTransactionTypeChange: (type: string) => void;
  onStartDateChange: (date: string) => void;
  onClosingDateChange: (date: string | undefined) => void;
  onEndDateChange: (date: string | undefined) => void;
  showAutocomplete: boolean;
  suggestions: AddressSuggestion[];
  onSelectSuggestion: (suggestion: AddressSuggestion) => void;
  startDateMode?: "manual";
}

function AddressVerificationStep({
  addressData,
  onAddressChange,
  onTransactionTypeChange,
  onStartDateChange,
  onClosingDateChange,
  onEndDateChange,
  showAutocomplete,
  suggestions,
  onSelectSuggestion,
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
          >
            Purchase
          </button>
          <button
            onClick={() => onTransactionTypeChange("sale")}
            className={`px-4 py-3 rounded-lg font-medium transition-all ${
              addressData.transaction_type === "sale"
                ? "bg-indigo-500 text-white shadow-md"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200"
            }`}
          >
            Sale
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="block text-sm font-medium text-gray-700">
            Transaction Dates
          </label>
        </div>

        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Representation Start Date *
            <span
              className="ml-1 text-gray-400 cursor-help"
              title="The date you officially started representing this client in this transaction"
            >
              (?)
            </span>
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
          />
          <p className="text-xs text-gray-500 mt-1">
            Required — The date you began representing this client
          </p>
        </div>

        {/* Closing date and end date */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Closing Date
            </label>
            <input
              type="date"
              value={addressData.closing_deadline || ""}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onClosingDateChange(e.target.value || undefined)
              }
              min={addressData.started_at}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-gray-900 bg-white min-h-[44px]"
            />
            <p className="text-xs text-gray-500 mt-1">
              Scheduled closing date
            </p>
          </div>
          <div>
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
            />
            <p className="text-xs text-gray-500 mt-1">
              When transaction ended
            </p>
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
