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
 * Drag to close (BACKLOG-4032): a downward drag that starts on the handle or the
 * header row (not on its buttons) moves the sheet with the pointer. Releasing
 * past 25% of the sheet height, or with a quick flick, closes it through
 * `onOpenChange(false)` (the same path as Escape, so focus return is shared);
 * releasing earlier snaps it back. Under prefers-reduced-motion the snap-back
 * is instant. Pointer events only.
 *
 * `fixedHeight`: the sheet is a constant min(80vh, 40rem) (dvh where supported)
 * instead of sizing to its content, so a body whose content changes (a
 * filtered list) never moves the sheet. The body then scrolls inside it.
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
  /** Constant sheet height instead of content height; the body scrolls inside it. */
  fixedHeight?: boolean;
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
  fixedHeight = false,
  returnFocusRef,
}: BottomSheetProps) {
  // The element focused when the sheet opened: the fallback focus target on close.
  const openerRef = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const active = document.activeElement as HTMLElement | null;
    openerRef.current = active && active !== document.body ? active : null;
  }, [open]);

  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{ id: number; startY: number; startT: number; dy: number } | null>(null);

  const setOffset = (dy: number, animate: boolean) => {
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 150ms ease-out' : 'none';
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    drag.current = { id: e.pointerId, startY: e.clientY, startT: e.timeStamp, dy: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    setOffset(d.dy, false);
  };
  const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const height = contentRef.current?.getBoundingClientRect().height ?? 0;
    const elapsed = Math.max(1, e.timeStamp - d.startT);
    const flick = d.dy >= 40 && d.dy / elapsed >= 0.5;
    if (e.type === 'pointerup' && d.dy > 0 && (flick || d.dy >= height * 0.25)) {
      setOffset(0, false);
      onOpenChange(false);
      return;
    }
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setOffset(0, !reduce);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-testid="bottom-sheet-overlay"
          className="fixed inset-0 z-[60] bg-gray-900/55"
        />
        <DialogPrimitive.Content
          ref={contentRef}
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
            fixedHeight && 'h-[min(80vh,40rem)] supports-[height:100dvh]:h-[min(80dvh,40rem)]',
            className
          )}
        >
          <div
            data-slot="bottom-sheet-drag"
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            style={{ touchAction: 'none' }}
          >
          <div className="flex justify-center pb-1 pt-2" aria-hidden="true">
            <div data-slot="bottom-sheet-handle" className="h-1 w-10 rounded-full bg-gray-300" />
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
          </div>
          <div
            data-slot="bottom-sheet-body"
            className={cn('flex-1 overflow-y-auto px-4 py-4', fixedHeight && 'flex min-h-0 flex-col')}
          >
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
