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

/**
 * Which surface the toggle drives:
 * - "filter"  (default): the Texts tab — ON CROPS the list to the audit period.
 *   Label "Remove texts outside audit range".
 * - "context" (BACKLOG-2295): the ConversationViewModal — ON additionally SHOWS
 *   the out-of-range messages with a gray exclusion treatment (they are visible
 *   context, not part of the export). Label "Show messages before and after
 *   audit range". Inverted default (OFF) is owned by the parent's `checked`.
 *
 * Both variants share the exact same pill "(i)" + label + switch markup so the
 * two surfaces can never visually drift; only the copy differs.
 */
export type AuditPeriodToggleVariant = "filter" | "context";

interface AuditPeriodToggleProps {
  /** Whether the toggle is ON. */
  checked: boolean;
  /** Called with the next value when the switch is toggled. */
  onChange: (checked: boolean) => void;
  /**
   * Formatted audit date range (e.g. "Jan 1, 2026 - Jan 31, 2026"). Empty
   * string when unknown — the explanation then omits the parenthetical range.
   */
  auditRangeLabel: string;
  /**
   * BACKLOG-2295: selects the copy set. Defaults to "filter" so every existing
   * caller (the Texts tab) is byte-for-byte unchanged.
   */
  variant?: AuditPeriodToggleVariant;
  /**
   * Extra classes for the outer pill (e.g. "flex-1" when it shares a row with
   * another control, as on the Texts tab).
   */
  className?: string;
}

/**
 * Copy per variant. Kept here (one source of truth) so the label and the "(i)"
 * explanation for both surfaces live together and stay consistent.
 */
function toggleCopy(
  variant: AuditPeriodToggleVariant,
  auditRangeLabel: string
): { labelFull: string; labelShort: string; explanation: string } {
  const range = auditRangeLabel ? ` (${auditRangeLabel})` : "";
  if (variant === "context") {
    return {
      labelFull: "Show messages before and after audit range",
      labelShort: "Before & after",
      explanation:
        `When ON, messages before and after the audit period${range} are also ` +
        `shown with a gray background — they are visible context, outside the ` +
        `audit range, and won't be included in the export. When OFF, only ` +
        `messages within the audit period are shown.`,
    };
  }
  return {
    labelFull: "Remove texts outside audit range",
    labelShort: "Audit range",
    explanation:
      `When ON, only texts within the audit period${range} are shown. ` +
      `When OFF, every linked text is shown.`,
  };
}

export function AuditPeriodToggle({
  checked,
  onChange,
  auditRangeLabel,
  variant = "filter",
  className = "",
}: AuditPeriodToggleProps): React.ReactElement {
  // BACKLOG-2278: click-to-open explanation for the audit-range filter (mirrors
  // the Emails tab's "(i)" info affordance). Local UI state only.
  const [showInfo, setShowInfo] = useState(false);

  const { labelFull, labelShort, explanation } = toggleCopy(
    variant,
    auditRangeLabel
  );

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
        <span className="hidden sm:inline">{labelFull}</span>
        <span className="sm:hidden">{labelShort}</span>
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
