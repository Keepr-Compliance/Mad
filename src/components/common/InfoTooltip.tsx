/**
 * InfoTooltip — (i) icon that shows a portal-rendered bubble on hover and on
 * keyboard focus (BACKLOG-3415). Only one tooltip is open at a time. Escape and
 * page scroll dismiss it. There is no timed auto-dismiss.
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

  const open = useCallback(() => {
    if (activeTooltipClose && activeTooltipClose !== hideSelf) activeTooltipClose();
    const rect = iconRef.current?.getBoundingClientRect();
    if (rect) {
      const width = wide ? BUBBLE_WIDTH.wide : BUBBLE_WIDTH.normal;
      setPos({
        top: rect.top - 8,
        left: Math.min(rect.left, window.innerWidth - width - 12),
      });
    }
    setShow(true);
    activeTooltipClose = hideSelf;
  }, [hideSelf, wide]);

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
      if (e.target === host && isFocusVisible(host)) open();
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
  }, [host, open, close]);

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
    window.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [show, close]);

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
        onFocus={standalone ? open : undefined}
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
