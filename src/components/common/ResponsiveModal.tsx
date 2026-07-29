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
import { isElectron } from "../../utils/platform";

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
  // BACKLOG-2292 (systemic popup sizing): does the caller dictate its own desktop
  // height? Matches h-/min-h-/max-h with an optional `sm:` prefix and optional `!`
  // important flag. When true, the caller owns its sizing chain (e.g. the
  // fixed-height MODAL_PANEL.lg presets and their inner flex-scroll, or
  // ConversationViewModal's sm:h-[600px]), so we must NOT layer our centered-card
  // height/overflow defaults on top: both would land on the element and Tailwind
  // SOURCE order — not className order — would pick the winner, re-breaking
  // BACKLOG-1727/1612. When false (width-only callers), we apply the defaults so
  // every simple popup renders as a centered card on desktop instead of the mobile
  // full-height sheet (the base h-full otherwise stayed live at sm+).
  const callerOwnsHeight = /(?:^|\s)!?(?:sm:)?(?:h-|min-h-|max-h-)/.test(panelClassName);
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
        BACKLOG-2292 (systemic): the desktop centered-card defaults
        (`sm:h-auto sm:max-h-[90vh] sm:overflow-y-auto`) are applied UNLESS the
        caller claims the height axis (see `callerOwnsHeight` above). This keeps
        the old contract intact for height-owning presets like MODAL_PANEL.lg
        (`sm:h-[85vh] sm:overflow-hidden`) — they receive NO extra height/overflow
        classes, so their fixed-height flex-scroll chain is byte-for-byte
        unchanged (avoids the BACKLOG-1727/1612 source-order trap where the
        unconditional defaults fought a preset and Tailwind picked the winner by
        CSS order, breaking inner scroll). Width-only callers — previously stuck
        full-height because ANY panelClassName suppressed the defaults — now
        correctly render as centered cards with a capped height and internal
        scroll.
      */}
      {/*
        BACKLOG-1790 / visual fix: below the sm breakpoint this panel is
        full-screen (fixed inset-0) and its first child (the gradient header)
        would sit under the global WindowDragStrip (top 36px / h-9) and the
        macOS traffic lights.

        We inject 36px of top-padding into the first child via the CSS
        arbitrary-variant `max-sm:[&>*:first-child]:pt-9` rather than using a
        separate spacer div. This means the header's own background fills the
        top band — no white bar. At sm+ the panel is a centered card (not
        full-screen) so the class has no effect there; the consumer's own
        sm:pt-* takes over as normal.

        Electron-only: browsers have no window chrome.
      */}
      <div
        className={`${panelBg} flex flex-col w-full min-w-[100vw] h-full overflow-hidden sm:min-w-0 sm:rounded-xl sm:shadow-2xl ${callerOwnsHeight ? '' : 'sm:h-auto sm:max-h-[90vh] sm:overflow-y-auto'} ${panelClassName}${isElectron() ? ' max-sm:[&>*:first-child]:pt-9' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}
