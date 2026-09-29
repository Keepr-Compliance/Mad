/**
 * FloatingActionBar
 *
 * BACKLOG-3614: a modal's action buttons floating over the bottom-right of the
 * scrolling content, at every window width. Generic: the caller passes an
 * ordered list of 1-4 actions; New/Edit Transaction passes Cancel / Back /
 * Continue, and Submit / Export can pass their own.
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
 *
 * @example
 * <ResponsiveModal onClose={onClose} panelClassName={`${MODAL_PANEL.lg} relative`}>
 *   <div className={`flex-1 min-h-0 overflow-y-auto px-6 pt-6 ${FLOATING_ACTION_BAR_CONTENT_PADDING}`}>
 *     ...content...
 *   </div>
 *   <FloatingActionBar
 *     actions={[
 *       { label: "Export PDF", onClick: exportPdf, variant: "secondary" },
 *       { label: "Next", onClick: next, variant: "primary", disabled: !valid, loading: saving, loadingLabel: "Saving..." },
 *     ]}
 *   />
 * </ResponsiveModal>
 */
import React, { useEffect } from "react";

/**
 * Bottom padding for the content area under the bar. The bar is ~40px tall
 * (py-2.5 + text-sm) and sits 16px (bottom-4) above the panel edge, so its top
 * is ~56px up; pb-20 (80px) leaves a clear gap below the last row.
 */
export const FLOATING_ACTION_BAR_CONTENT_PADDING = "pb-20";

export type FloatingActionVariant = "primary" | "secondary" | "ghost";

export interface FloatingAction {
  /** Stable React key; defaults to the index. */
  key?: string;
  /** Visible text. */
  label: React.ReactNode;
  onClick: () => void | Promise<void>;
  /** Defaults to "secondary". */
  variant?: FloatingActionVariant;
  disabled?: boolean;
  /** Rendered before the label. */
  icon?: React.ReactNode;
  /** Accessible name, when the visible label is not enough (e.g. icon-only). */
  ariaLabel?: string;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  /** Text shown next to the spinner while loading; defaults to `label`. */
  loadingLabel?: React.ReactNode;
  testId?: string;
}

/** Falsy entries are skipped, so `step > 1 && { ... }` works inline. */
export type FloatingActionEntry = FloatingAction | false | null | undefined;

export interface FloatingActionBarProps {
  /** Ordered left → right; 1-4 actions after falsy entries are dropped. */
  actions: FloatingActionEntry[];
  testId?: string;
}

export const MAX_FLOATING_ACTIONS = 4;

const BASE =
  "px-4 py-2.5 rounded-full text-sm transition-all disabled:cursor-not-allowed";

function variantClass(variant: FloatingActionVariant, inactive: boolean): string {
  switch (variant) {
    case "primary":
      return `sm:px-6 font-semibold shadow-lg ${
        inactive
          ? "bg-gray-300 text-gray-500"
          : "bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:from-indigo-600 hover:to-purple-700 hover:shadow-xl"
      }`;
    case "ghost":
      return "font-medium bg-white bg-opacity-90 text-gray-700 shadow-md hover:bg-gray-100 disabled:opacity-50";
    case "secondary":
    default:
      return "font-medium bg-white text-gray-700 border border-gray-200 shadow-lg hover:bg-gray-50 hover:shadow-xl disabled:opacity-50";
  }
}

export function FloatingActionBar({
  actions,
  testId = "floating-action-bar",
}: FloatingActionBarProps): React.ReactElement {
  const visible = actions.filter((a): a is FloatingAction => !!a);

  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" &&
      (visible.length < 1 || visible.length > MAX_FLOATING_ACTIONS)
    ) {
      console.warn(
        `FloatingActionBar: expected 1-${MAX_FLOATING_ACTIONS} actions, got ${visible.length}`,
      );
    }
  }, [visible.length]);

  return (
    <div
      className="absolute bottom-4 right-4 z-20 flex items-center gap-2"
      data-testid={testId}
    >
      {visible.map((action, index) => {
        const variant = action.variant ?? "secondary";
        const inactive = !!action.disabled || !!action.loading;
        return (
          <button
            key={action.key ?? index}
            type="button"
            onClick={() => {
              void action.onClick();
            }}
            disabled={inactive}
            aria-label={action.ariaLabel}
            aria-busy={action.loading ? true : undefined}
            className={`${BASE} ${variantClass(variant, inactive)}`}
            data-testid={action.testId}
            data-variant={variant}
          >
            {action.loading ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                {action.loadingLabel ?? action.label}
              </span>
            ) : action.icon ? (
              <span className="flex items-center gap-2">
                {action.icon}
                {action.label}
              </span>
            ) : (
              action.label
            )}
          </button>
        );
      })}
    </div>
  );
}

export default FloatingActionBar;
