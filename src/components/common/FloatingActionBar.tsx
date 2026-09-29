/**
 * FloatingActionBar
 *
 * BACKLOG-3614: a modal's action buttons (Cancel / Back / primary) floating
 * over the bottom-right of the scrolling content, at every window width.
 *
 * Contract for the host modal:
 * - The panel must be `relative` (e.g. `panelClassName={`${MODAL_PANEL.lg} relative`}`).
 *   The bar is `absolute`, not `fixed`: at >= 640px the panel is a centred
 *   card, and `fixed` would pin the buttons to the viewport corner instead.
 * - The content scroll area must carry FLOATING_ACTION_BAR_CONTENT_PADDING so
 *   the bar never covers the last field or button in the content.
 *
 * Styling is the <640px floating pill the audit wizard already used
 * (rounded-full, shadow-lg, indigo→purple gradient primary, white secondary).
 */
import React from "react";

/**
 * Bottom padding for the content area under the bar. The bar is ~40px tall
 * (py-2.5 + text-sm) and sits 16px (bottom-4) above the panel edge, so its top
 * is ~56px up; pb-20 (80px) leaves a clear gap below the last row.
 */
export const FLOATING_ACTION_BAR_CONTENT_PADDING = "pb-20";

/** Secondary pill (Cancel, Back). */
export const FLOATING_SECONDARY_BUTTON_CLASS =
  "px-4 py-2.5 rounded-full font-medium text-sm bg-white text-gray-700 border border-gray-200 shadow-lg hover:bg-gray-50 hover:shadow-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed";

/** Primary pill (Continue / Create / Save). */
export function floatingPrimaryButtonClass(disabled: boolean): string {
  return `px-5 sm:px-6 py-2.5 rounded-full font-semibold text-sm shadow-lg transition-all ${
    disabled
      ? "bg-gray-300 text-gray-500 cursor-not-allowed"
      : "bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700 hover:shadow-xl"
  }`;
}

interface FloatingActionBarProps {
  children: React.ReactNode;
  testId?: string;
}

export function FloatingActionBar({
  children,
  testId = "floating-action-bar",
}: FloatingActionBarProps): React.ReactElement {
  return (
    <div
      className="absolute bottom-4 right-4 z-20 flex items-center gap-2"
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export default FloatingActionBar;
