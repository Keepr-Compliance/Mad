/**
 * ResponsiveModal Component
 *
 * Shared modal wrapper that provides:
 * - Mobile (< 640px): Full-screen modal with scrollable content
 * - Desktop (>= 640px): Centered overlay with rounded card, max-width constraint
 *
 * Replaces the repeated "fixed inset-0 bg-black bg-opacity-* flex items-center justify-center"
 * pattern used across all modal components.
 *
 * Usage: Pass the desktop panel classes (max-w-*, max-h-*, h-[*]) via panelClassName.
 * The component handles the mobile-to-desktop responsive switch automatically.
 *
 * @example
 * // Simple confirmation dialog
 * <ResponsiveModal onClose={handleClose} panelClassName="max-w-md p-6">
 *   <h3>Are you sure?</h3>
 *   <button onClick={handleClose}>Cancel</button>
 * </ResponsiveModal>
 *
 * @example
 * // Complex scrollable modal with custom z-index
 * <ResponsiveModal onClose={handleClose} zIndex="z-[70]" panelClassName="max-w-4xl max-h-[90vh]">
 *   <div className="flex-shrink-0 px-6 py-4">Header</div>
 *   <div className="flex-1 overflow-y-auto p-6">Scrollable content</div>
 * </ResponsiveModal>
 */
import React from "react";

/**
 * Panel size presets — single source of truth for modal sizing.
 * Change the value here and every modal using the preset updates.
 */
export const MODAL_PANEL = {
  /** Large workflow modals (audit, transaction details, edit contacts) */
  lg: "max-w-4xl sm:h-[85vh] sm:min-h-[85vh] sm:max-h-[90vh] sm:overflow-hidden",
} as const;

interface ResponsiveModalProps {
  /** Close handler — called on backdrop click (desktop only) */
  onClose?: () => void;
  /** Modal content */
  children: React.ReactNode;
  /** Z-index class, e.g. "z-50", "z-[70]", "z-[100]" */
  zIndex?: string;
  /**
   * Overlay classes — the backdrop div.
   * Defaults to "bg-black bg-opacity-70".
   * Pass the full backdrop classes if you need different opacity.
   */
  overlayClassName?: string;
  /**
   * Background color for the panel. Defaults to "bg-white".
   * Override for modals that need a different background (e.g. "bg-gray-50").
   */
  panelBg?: string;
  /**
   * Additional classes for the inner content panel.
   * Include desktop sizing here: max-w-*, max-h-*, h-[*], p-* etc.
   */
  panelClassName?: string;
  /** data-testid for the overlay */
  testId?: string;
}

export function ResponsiveModal({
  onClose,
  children,
  zIndex = "z-50",
  overlayClassName = "bg-black bg-opacity-70",
  panelBg = "bg-white",
  panelClassName = "",
  testId,
}: ResponsiveModalProps): React.ReactElement {
  return (
    <div
      className={`fixed inset-0 ${zIndex} ${overlayClassName} flex items-center justify-center sm:p-4`}
      onClick={(e) => {
        if (e.target === e.currentTarget && onClose) {
          onClose();
        }
      }}
      data-testid={testId}
    >
      {/*
        BACKLOG-1727 follow-up: re-apply the conditional pattern from commit
        532c9207. The unconditional defaults (`sm:overflow-y-auto sm:h-auto
        sm:max-h-[90vh]`) conflict with sizing presets like MODAL_PANEL.lg
        (`sm:h-[85vh] sm:overflow-hidden`); both classes end up on the element
        and Tailwind CSS source order — not className order — picks the winner.
        Result: the panel scrolls itself, the flex height chain to inner
        scrollable lists breaks, and deep modals (e.g. New Transaction step 2)
        lose scroll.

        Trade-off acknowledged: if a caller passes a panelClassName WITHOUT any
        overflow/height utilities, the panel won't scroll on desktop. The
        contract is now: presets are responsible for their own sizing. The
        prior SR-review change (31ae1d26) tried to enforce defaults always,
        but that re-broke BACKLOG-1612.
      */}
      <div
        className={`${panelBg} flex flex-col w-full min-w-[100vw] h-full overflow-hidden sm:min-w-0 sm:rounded-xl sm:shadow-2xl ${panelClassName ? panelClassName : 'sm:overflow-y-auto sm:h-auto sm:max-h-[90vh]'}`}
      >
        {children}
      </div>
    </div>
  );
}
