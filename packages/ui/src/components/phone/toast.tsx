'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — confirmation toast ("Saved", "Reply sent"). Confirmations only:
 * errors still render inline via Alert.
 *
 * The `role=status` live region is ALWAYS mounted; opening inserts the text
 * into it, which is what screen readers announce reliably. It sits above the
 * StickyActionBar (`--keepr-action-bar-h`) and the offline banner
 * (`--keepr-offline-banner-h`) and closes itself after `duration` ms.
 *
 * Consumers: BACKLOG-3899 (ticket conversation), BACKLOG-3901 (plans),
 * BACKLOG-3902 (broker users).
 */
export interface ToastProps {
  open: boolean;
  message: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  duration?: number;
  className?: string;
}

export function Toast({ open, message, onOpenChange, duration = 4000, className }: ToastProps) {
  const onOpenChangeRef = React.useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => onOpenChangeRef.current(false), duration);
    return () => clearTimeout(t);
  }, [open, duration, message]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="toast-region"
      className={cn(
        'pointer-events-none fixed inset-x-0 z-[70] flex justify-center px-4',
        'bottom-[calc(var(--keepr-action-bar-h,env(safe-area-inset-bottom,0px))_+_var(--keepr-offline-banner-h,0px)_+_12px)]',
        className
      )}
    >
      {open ? (
        <div className="pointer-events-auto max-w-sm rounded-lg bg-gray-900 px-4 py-3 text-sm text-white shadow-lg">
          {message}
        </div>
      ) : null}
    </div>
  );
}
