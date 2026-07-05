'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../cn';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 'sm' = compact confirm/form panel (max-w-md p-6); 'lg' = large form with header (max-w-2xl). */
  size?: 'sm' | 'lg';
  /** Renders the standard header row (title + close X). Omit for fully custom content. */
  title?: ReactNode;
  className?: string;
  /** Set false to block backdrop/Escape dismissal (e.g. while submitting). */
  dismissible?: boolean;
}

/**
 * Overlay dialog: fixed backdrop `bg-black/50` + white rounded-lg shadow-xl panel.
 * Closes on Escape and backdrop click unless `dismissible` is false.
 */
export function Modal({ open, onClose, children, size = 'sm', title, className, dismissible = true }: ModalProps) {
  useEffect(() => {
    if (!open || !dismissible) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, dismissible, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden="true"
        onClick={dismissible ? onClose : undefined}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative bg-white rounded-lg shadow-xl w-full mx-4',
          size === 'sm' ? 'max-w-md p-6' : 'max-w-2xl max-h-[90vh] overflow-y-auto',
          className
        )}
      >
        {title != null && (
          <div
            className={cn(
              'flex items-center justify-between',
              size === 'sm' ? 'mb-4' : 'px-6 py-4 border-b border-gray-200'
            )}
          >
            <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/** Body padding wrapper for `size="lg"` modals (matches the header's px-6). */
export function ModalBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-6 py-4 space-y-4', className)}>{children}</div>;
}

/** Right-aligned action row for modal footers. */
export function ModalFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-6 flex justify-end gap-3', className)}>{children}</div>;
}
