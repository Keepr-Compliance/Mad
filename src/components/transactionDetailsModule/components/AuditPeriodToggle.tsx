/**
 * AuditPeriodToggle Component
 *
 * Shared "audit period" filter control: a pill with an "(i)" info button, a
 * plain-language label, and a switch on the right. Clicking the "(i)" opens a
 * small popover carrying the exact audit date range.
 *
 * BACKLOG-2278 shipped this pattern on the Texts tab (TransactionMessagesTab).
 * BACKLOG-2291 extracts it here so the ConversationViewModal renders the EXACT
 * same control — one source of truth for the markup and the explanation copy so
 * the two surfaces can never visually drift apart.
 *
 * Presentation only: the parent owns the `checked` state and the filtering
 * logic; this component only owns the local "is the info popover open" state.
 */
import React, { useState } from "react";

interface AuditPeriodToggleProps {
  /** Whether "audit period only" filtering is ON. */
  checked: boolean;
  /** Called with the next value when the switch is toggled. */
  onChange: (checked: boolean) => void;
  /**
   * Formatted audit date range (e.g. "Jan 1, 2026 - Jan 31, 2026"). Empty
   * string when unknown — the explanation then omits the parenthetical range.
   */
  auditRangeLabel: string;
  /**
   * Extra classes for the outer pill (e.g. "flex-1" when it shares a row with
   * another control, as on the Texts tab).
   */
  className?: string;
}

export function AuditPeriodToggle({
  checked,
  onChange,
  auditRangeLabel,
  className = "",
}: AuditPeriodToggleProps): React.ReactElement {
  // BACKLOG-2278: click-to-open explanation for the audit-range filter (mirrors
  // the Emails tab's "(i)" info affordance). Local UI state only.
  const [showInfo, setShowInfo] = useState(false);

  const explanation =
    `When ON, only texts within the audit period` +
    (auditRangeLabel ? ` (${auditRangeLabel})` : "") +
    ` are shown. When OFF, every linked text is shown.`;

  return (
    <div
      className={`flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2.5 ${className}`.trim()}
      data-testid="audit-period-filter"
    >
      <span
        className="relative text-sm text-gray-700 flex items-center gap-1.5"
        data-testid="audit-period-info"
      >
        <button
          type="button"
          onClick={() => setShowInfo(!showInfo)}
          className="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold flex items-center justify-center hover:bg-blue-200 transition-colors"
          title={explanation}
          aria-label="About the audit range filter"
          data-testid="audit-period-info-button"
        >
          i
        </button>
        <span className="hidden sm:inline">Remove texts outside audit range</span>
        <span className="sm:hidden">Audit range</span>
        {showInfo && (
          <span
            role="tooltip"
            className="absolute left-0 top-full mt-2 z-10 w-64 rounded-lg bg-gray-900 text-white text-xs font-normal leading-relaxed px-3 py-2 shadow-lg"
            data-testid="audit-period-info-popover"
          >
            {explanation}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
          checked ? "bg-blue-600" : "bg-gray-300"
        }`}
        data-testid="audit-period-filter-checkbox"
      >
        <span
          className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export default AuditPeriodToggle;
