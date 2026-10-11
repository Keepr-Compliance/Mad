'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — slide-out navigation drawer (below `md`), on Radix Dialog.
 *
 * Radix supplies the focus trap, Escape, scroll lock and `aria-modal`.
 * The kit adds what the two portal drawers each hand-rolled:
 *  - focus returns to `returnFocusRef` on close, even when the tap that opened
 *    the drawer never focused the menu button;
 *  - ANY link activation inside the drawer closes it — including the page that
 *    is already open, where no route change fires (BACKLOG-3891 item 2);
 *  - crossing to the desktop breakpoint closes it.
 * Route-change close stays in the app shell (one effect on `pathname`).
 * Nav items, RBAC and sign-out stay per app (`children` / `footer`).
 *
 * Geometry: `fixed inset-y-0` (never 100vh) with top + bottom safe-area padding.
 *
 * Consumers: BACKLOG-3896 (broker drawer swap), BACKLOG-3897 (admin drawer swap).
 */
export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name (visually hidden Dialog.Title). */
  title?: string;
  /** Visible header content (wordmark + qualifier). The close button is added. */
  header?: React.ReactNode;
  /** Nav items. */
  children: React.ReactNode;
  /** User block / sign out. */
  footer?: React.ReactNode;
  /** Element focused when the drawer closes (the menu button). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Media query at which the drawer closes itself. */
  closeOnDesktopQuery?: string;
  id?: string;
  className?: string;
}

export function Drawer({
  open,
  onOpenChange,
  title = 'Main menu',
  header,
  children,
  footer,
  returnFocusRef,
  closeOnDesktopQuery = '(min-width: 768px)',
  id = 'mobile-nav',
  className,
}: DrawerProps) {
  const onOpenChangeRef = React.useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // Close when the viewport crosses to desktop while open.
  React.useEffect(() => {
    if (!open || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(closeOnDesktopQuery);
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) onOpenChangeRef.current(false);
    };
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, [open, closeOnDesktopQuery]);

  // Any link tap inside the drawer closes it (same-page taps included).
  const handleClick = (e: React.MouseEvent<HTMLElement>) => {
    const target = e.target as Element | null;
    if (target?.closest?.('a[href]')) onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <div className="fixed inset-0 z-[60] md:hidden" data-testid="mobile-nav-overlay">
          <DialogPrimitive.Overlay className="absolute inset-0 bg-gray-900/55" />
          <DialogPrimitive.Content
            id={id}
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              returnFocusRef?.current?.focus();
            }}
            onClick={handleClick}
            className={cn(
              'fixed inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-gray-900 pb-[env(safe-area-inset-bottom,0px)] pt-[env(safe-area-inset-top,0px)] text-white shadow-xl focus:outline-none',
              className
            )}
          >
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            <div className="flex items-center justify-between border-b border-gray-800 py-2 pl-6 pr-2">
              <div className="flex min-w-0 items-center gap-2">{header}</div>
              <DialogPrimitive.Close
                aria-label="Close menu"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-600 [@media(hover:hover)]:hover:bg-gray-800 [@media(hover:hover)]:hover:text-white"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </DialogPrimitive.Close>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">{children}</nav>
            {footer ? <div className="border-t border-gray-800 px-3 py-4">{footer}</div> : null}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
