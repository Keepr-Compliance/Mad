'use client';

/**
 * An (i) button next to a header that shows a short tip (BACKLOG-4186). Opens on hover, and on
 * click or Enter/Space (toggles); closes on leaving, blur or Escape (Escape works wherever focus
 * is, WCAG 1.4.13). While open, the tip is the button's accessible description. Neither
 * @keepr/ui nor admin-portal has a keyboard-reachable tooltip, so this is the smallest one that is.
 *
 * The tip is portalled to <body> with fixed placement: several sit in the modes table, inside an
 * `overflow-x-auto` box that would clip an absolutely placed tip (overflow-x:auto makes
 * overflow-y auto too).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

export interface InfoTipProps {
  /** The header the tip is about; the button is named "About <label>". */
  label: string;
  text: string;
}

const TIP_WIDTH = 256;
const EDGE = 8;
/** Time to cross from the button to the tip without it closing (the tip stays hoverable). */
const CLOSE_DELAY_MS = 120;

export function InfoTip({ label, text }: InfoTipProps) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const open = hover || pinned;

  const enter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setHover(true);
  };
  const leave = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setHover(false), CLOSE_DELAY_MS);
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const place = useCallback(() => {
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const max = Math.max(EDGE, window.innerWidth - TIP_WIDTH - EDGE);
    setPos({ top: r.bottom + 4, left: Math.min(Math.max(EDGE, r.left), max) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (closeTimer.current) clearTimeout(closeTimer.current);
        setPinned(false);
        setHover(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span className="inline-flex align-middle" onMouseEnter={enter} onMouseLeave={leave}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setPinned((v) => !v)}
        onBlur={() => setPinned(false)}
        className="rounded-full text-gray-400 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            onMouseEnter={enter}
            onMouseLeave={leave}
            style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, width: TIP_WIDTH }}
            className="z-50 block rounded-md bg-gray-900 px-2.5 py-1.5 text-left text-xs font-normal normal-case leading-snug text-white shadow-lg"
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
