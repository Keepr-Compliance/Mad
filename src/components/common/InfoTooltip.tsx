/**
 * InfoTooltip — (i) icon that shows a portal-rendered bubble on hover and on
 * keyboard focus (BACKLOG-3415). Only one tooltip is open at a time. Escape and
 * page scroll dismiss it — except the scroll that keyboard focus itself causes,
 * which repositions the bubble instead (see FOCUS_SCROLL_SETTLE_MS). There is no
 * timed auto-dismiss.
 *
 * ## Which element takes keyboard focus
 *
 * 12 of the 16 call sites render this INSIDE a `<button>` (the ExportModal and
 * GeneralSettings format/content/attachment pills), and one renders it inside a
 * `div role="button" tabIndex={0}` card (ContactTombstonePill in
 * TransactionDetailsTab). HTML forbids a descendant with `tabindex` inside a
 * `<button>`, and a nested tab stop inside a clickable card would double every
 * tab stop and let Enter on the icon reach the card's own key handler.
 *
 * So the trigger checks, once at mount, whether it sits inside an interactive
 * ancestor ("host"):
 *   - no host  → the icon span itself is the tab stop (`tabIndex={0}`), shows on
 *                focus, hides on blur, and carries `aria-describedby`.
 *   - host     → the icon is NOT focusable. Keyboard focus on the host shows the
 *                bubble and the host carries `aria-describedby` while it shows.
 *                Gated on `:focus-visible`, so a mouse click on "One PDF" (which
 *                focuses that button) does not leave a bubble stuck open.
 *
 * Clicking the icon does nothing: `stopPropagation` keeps the host's onClick
 * from firing (ContactTombstonePill relies on this — the (i) must not open the
 * contact preview), and `preventDefault` keeps a surrounding `<label>` from
 * toggling its control and a submit button from submitting its form.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";

let activeTooltipClose: (() => void) | null = null;

const INTERACTIVE_HOST =
  'button, a[href], summary, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]';

/** Default bubble is w-52 (208px); `wide` is w-72 (288px). 12px viewport margin. */
const BUBBLE_WIDTH = { normal: 208, wide: 288 } as const;

/**
 * BACKLOG-3415: how long after a focus-triggered open a `scroll` still counts as
 * the browser's own scroll-into-view rather than the user's — a SLIDING window,
 * refreshed by every scroll it swallows.
 *
 * Tabbing to a control that is out of view makes the browser scroll it into
 * view, which fires `scroll`, which closed the bubble. Measured in Electron
 * 38.8.6 / Chromium 140, the real component driven by `sendInputEvent` with CDP
 * focus emulation: a tab that does NOT scroll leaves the bubble open; EVERY tab
 * that scrolls leaves it shut, `focusin` and `scroll` 0.5 ms apart. So every
 * tooltip on an out-of-view control was unreachable by keyboard — it opened and
 * shut in the same frame.
 *
 * Why a sliding window and not a fixed one: `Settings.tsx:181` puts
 * `scroll-smooth` on the pane holding five of these call sites, and a smooth
 * scroll-into-view fires ~77 `scroll` events spanning ~640 ms (measured twice),
 * with a largest gap between consecutive events of 17 ms. A fixed short window
 * would expire mid-animation and close the bubble anyway. 150 ms is ~9x that
 * largest gap, so the train never breaks it, and a genuine scroll starting
 * 150 ms after the animation settles still closes the bubble.
 *
 * Pointer opens get no window at all — hovering and then scrolling still closes
 * it, unchanged.
 */
const FOCUS_SCROLL_SETTLE_MS = 150;

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * `text` is a ReactNode, not a string (BACKLOG-3415). 15 of the 16 call sites
 * pass a plain string and are unaffected; the Transaction Dates tooltip passes
 * JSX so each date's name can be bold on its own line. Nothing else consumes
 * this value — there is no `title` attribute and no string-only assumption. The
 * bubble is the `aria-describedby` target, so its rendered content is what a
 * screen reader announces; keep any JSX in reading order.
 */
export function InfoTooltip({ text, wide = false }: { text: React.ReactNode; wide?: boolean }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // undefined = not measured yet; null = no interactive ancestor.
  const [host, setHost] = useState<HTMLElement | null | undefined>(undefined);
  const iconRef = useRef<HTMLSpanElement>(null);
  const hideSelf = useRef(() => setShow(false)).current;
  const tooltipId = useId();
  /** Deadline until which a `scroll` is treated as focus's own. 0 = none. */
  const focusScrollUntil = useRef(0);

  /** Put the bubble above the icon, clamped to the viewport's right edge. */
  const place = useCallback(() => {
    const rect = iconRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = wide ? BUBBLE_WIDTH.wide : BUBBLE_WIDTH.normal;
    setPos({
      top: rect.top - 8,
      left: Math.min(rect.left, window.innerWidth - width - 12),
    });
  }, [wide]);

  const open = useCallback(() => {
    if (activeTooltipClose && activeTooltipClose !== hideSelf) activeTooltipClose();
    // A pointer open never gets the focus-scroll window.
    focusScrollUntil.current = 0;
    place();
    setShow(true);
    activeTooltipClose = hideSelf;
  }, [hideSelf, place]);

  /**
   * Opened by keyboard focus, so the scroll the browser is about to perform to
   * bring the control into view is not the user scrolling.
   */
  const openFromFocus = useCallback(() => {
    open();
    focusScrollUntil.current = Date.now() + FOCUS_SCROLL_SETTLE_MS;
  }, [open]);

  const close = useCallback(() => {
    setShow(false);
    if (activeTooltipClose === hideSelf) activeTooltipClose = null;
  }, [hideSelf]);

  useLayoutEffect(() => {
    setHost(iconRef.current?.parentElement?.closest<HTMLElement>(INTERACTIVE_HOST) ?? null);
  }, []);

  // Keyboard path when nested inside an interactive element.
  useEffect(() => {
    if (!host) return;
    const onFocusIn = (e: FocusEvent) => {
      if (e.target === host && isFocusVisible(host)) openFromFocus();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.target === host) close();
    };
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    return () => {
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
    };
  }, [host, openFromFocus, close]);

  useLayoutEffect(() => {
    if (!host || !show) return;
    const prev = host.getAttribute("aria-describedby");
    host.setAttribute("aria-describedby", prev ? `${prev} ${tooltipId}` : tooltipId);
    return () => {
      if (prev === null) host.removeAttribute("aria-describedby");
      else host.setAttribute("aria-describedby", prev);
    };
  }, [host, show, tooltipId]);

  useEffect(() => {
    if (!show) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // `capture: true` on window is what lets an inner scroll container reach
    // this at all — `scroll` does not bubble, and the Export modal's pills sit
    // inside one.
    const onScroll = () => {
      if (Date.now() < focusScrollUntil.current) {
        // Focus's own scroll-into-view. Slide the window so the rest of a
        // smooth animation stays inside it, and keep the bubble on its icon
        // rather than letting it drift.
        focusScrollUntil.current = Date.now() + FOCUS_SCROLL_SETTLE_MS;
        place();
        return;
      }
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [show, close, place]);

  const standalone = host === null;

  return (
    <>
      <span
        ref={iconRef}
        className="inline-flex items-center ml-1.5 cursor-help"
        data-testid="info-tooltip-trigger"
        tabIndex={standalone ? 0 : undefined}
        // Named only when standalone: inside a button a descendant aria-label
        // would be folded into the button's own accessible name.
        role={standalone ? "img" : undefined}
        aria-label={standalone ? "More information" : undefined}
        aria-describedby={standalone && show ? tooltipId : undefined}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={standalone ? openFromFocus : undefined}
        onBlur={standalone ? close : undefined}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
      >
        <svg
          className={`w-4 h-4 transition-colors ${show ? "text-purple-500" : "text-gray-400 hover:text-purple-500"}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" strokeWidth="2" />
          <path strokeLinecap="round" strokeWidth="2" d="M12 16v-4m0-4h.01" />
        </svg>
      </span>
      {show && ReactDOM.createPortal(
        <div
          id={tooltipId}
          role="tooltip"
          className={`fixed z-[9999] px-3 py-2 rounded-lg bg-gray-900 text-white text-xs normal-case tracking-normal shadow-lg ${
            wide ? "w-72 text-left whitespace-pre-line" : "w-52 text-center"
          }`}
          style={{ top: pos.top, left: pos.left, transform: "translateY(-100%)" }}
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
