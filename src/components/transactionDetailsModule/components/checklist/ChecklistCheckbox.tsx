/**
 * ChecklistCheckbox — BACKLOG-3588.
 *
 * The one checkbox of the Checklist tab: a checklist item's tick and a
 * template row in the chooser render this same element, so the two cannot
 * drift. Its markup is the item row's as it was before the extraction, pinned
 * byte for byte by ChecklistCheckbox-3588.test.tsx.
 */
import React from "react";

interface ChecklistCheckboxProps {
  checked: boolean;
  /** Accessible name: what is being ticked. */
  label: string;
  disabled?: boolean;
  /** Faded (a write in flight, or a row that cannot be ticked). */
  dimmed?: boolean;
  onClick?: () => void;
  testId?: string;
}

export function ChecklistCheckbox({
  checked,
  label,
  disabled = false,
  dimmed = false,
  onClick,
  testId,
}: ChecklistCheckboxProps): React.ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`w-6 h-6 rounded-md border-2 inline-flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors disabled:cursor-not-allowed ${
        checked ? "bg-blue-500 border-blue-500" : "bg-white border-gray-300 hover:border-blue-300"
      } ${dimmed ? "opacity-60" : ""}`}
      data-testid={testId}
    >
      <svg
        className={`w-4 h-4 text-white ${checked ? "opacity-100" : "opacity-0"}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
      </svg>
    </button>
  );
}

export default ChecklistCheckbox;
