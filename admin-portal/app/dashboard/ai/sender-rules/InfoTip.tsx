'use client';

/**
 * An (i) button next to a header that shows a short tip (BACKLOG-4186). Opens on hover, and on
 * click or Enter/Space (toggles); closes on leaving, blur or Escape. While open, the tip is the
 * button's accessible description. Neither @keepr/ui nor admin-portal has a keyboard-reachable
 * tooltip, so this is the smallest one that is.
 */

import { useId, useState } from 'react';
import { Info } from 'lucide-react';

export interface InfoTipProps {
  /** The header the tip is about; the button is named "About <label>". */
  label: string;
  text: string;
}

export function InfoTip({ label, text }: InfoTipProps) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const id = useId();
  const open = hover || pinned;

  return (
    <span
      className="relative inline-flex align-middle"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        aria-label={`About ${label}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setPinned((v) => !v)}
        onBlur={() => setPinned(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setPinned(false);
            setHover(false);
          }
        }}
        className="rounded-full text-gray-400 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className="absolute left-0 top-full z-50 mt-1 w-64 rounded-md bg-gray-900 px-2.5 py-1.5 text-left text-xs font-normal normal-case leading-snug text-white shadow-lg"
        >
          {text}
        </span>
      )}
    </span>
  );
}
