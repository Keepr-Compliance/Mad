'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — bottom sheet (filters, quick edits) on Radix Dialog.
 * Modal: focus trap, Escape and backdrop close come from Radix. The body
 * scrolls; the primary action sits in a footer outside the scroll area with
 * bottom safe-area padding. Height caps at 90dvh, with a 90vh fallback for
 * browsers without dynamic viewport units.
 *
 * Focus on close (BACKLOG-4032): the sheet has no Radix Trigger, so Radix
 * would send focus to <body>. It returns to `returnFocusRef` when given, else
 * to the element that had focus when the sheet opened (ignored when that was
 * <body>, e.g. a tapped button on iOS Safari). Pass `returnFocusRef` = the
 * opener so a tap, which may not focus the button, still gets focus back.
 *
 * Focus on open: an element in the body marked `data-autofocus` (DropdownOptions
 * with autoFocus marks its search field) gets focus; otherwise Radix's default
 * (the first focusable, the Close button). Needed when the sheet opens inside
 * another dialog: that dialog's focus trap pulls a focus() made during mount
 * back out, before this sheet's trap takes over.
 *
 * Consumers: BACKLOG-3898 (support queue filters), BACKLOG-3900 (projects),
 * BACKLOG-3902 (broker users).
 */
export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Optional control left of Close (e.g. "Reset"). */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  /** Pinned footer content (usually one full-width button). */
  primaryAction?: React.ReactNode;
  className?: string;
  /** Element that gets focus when the sheet closes (usually the button that opened it). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

export function BottomSheet({
  open,
  onOpenChange,
  title,
  headerAction,
  children,
  primaryAction,
  className,
  returnFocusRef,
}: BottomSheetProps) {
  // The element focused when the sheet opened: the fallback focus target on close.
  const openerRef = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const active = document.activeElement as HTMLElement | null;
    openerRef.current = active && active !== document.body ? active : null;
  }, [open]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid="bottom-sheet-overlay"
          className="fixed inset-0 z-[60] bg-gray-900/55"
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            const target = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-autofocus]');
            if (target) {
              e.preventDefault();
              target.focus();
            }
          }}
          onCloseAutoFocus={(e) => {
            const el = returnFocusRef?.current ?? openerRef.current;
            if (el?.isConnected) {
              e.preventDefault();
              el.focus();
            }
          }}
          className={cn(
            'fixed inset-x-0 bottom-0 z-[60] flex max-h-[90vh] flex-col rounded-t-xl bg-white shadow-xl focus:outline-none supports-[height:100dvh]:max-h-[90dvh]',
            className
          )}
        >
          <div className="flex justify-center pt-2" aria-hidden="true">
            <div className="h-1 w-10 rounded-full bg-gray-300" />
          </div>
          <div className="flex items-center gap-2 border-b border-gray-200 py-1 pl-4 pr-1">
            <DialogPrimitive.Title className="flex-1 truncate text-lg font-semibold text-gray-900">
              {title}
            </DialogPrimitive.Title>
            {headerAction}
            <DialogPrimitive.Close
              aria-label="Close"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 [@media(hover:hover)]:hover:bg-gray-50"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <div data-slot="bottom-sheet-body" className="flex-1 overflow-y-auto px-4 py-4">
            {children}
          </div>
          {primaryAction ? (
            <div
              data-slot="bottom-sheet-footer"
              className="border-t border-gray-200 px-4 pb-[calc(env(safe-area-inset-bottom,0px)_+_12px)] pt-3"
            >
              {primaryAction}
            </div>
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
