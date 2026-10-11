'use client';

import * as React from 'react';
import { Menu } from 'lucide-react';
import { Wordmark } from '../wordmark';
import { cn } from '../../lib/cn';

/**
 * Phone kit — top bar shown below `md` (768px). Holds the menu button that
 * opens the kit `Drawer`; hidden from `md` up. The ref forwards to the menu
 * button so the shell can hand it to `Drawer` as `returnFocusRef`.
 *
 * Consumers: BACKLOG-3896 (broker drawer swap), BACKLOG-3897 (admin drawer swap).
 */
export interface MobileTopBarProps {
  /** Small uppercase label after the wordmark, e.g. "Broker" or "Admin". */
  qualifier: string;
  menuOpen: boolean;
  onOpenMenu: () => void;
  /** id of the drawer the button controls. */
  menuControlsId?: string;
  /** Replaces the wordmark + qualifier block. */
  leading?: React.ReactNode;
  /** Right-aligned slot (e.g. an avatar button). */
  trailing?: React.ReactNode;
  className?: string;
}

export const MobileTopBar = React.forwardRef<HTMLButtonElement, MobileTopBarProps>(
  function MobileTopBar(
    { qualifier, menuOpen, onOpenMenu, menuControlsId = 'mobile-nav', leading, trailing, className },
    ref
  ) {
    return (
      <header
        data-testid="mobile-top-bar"
        className={cn(
          'sticky top-0 z-30 bg-gray-900 pt-[env(safe-area-inset-top,0px)] text-white md:hidden',
          className
        )}
      >
        <div className="flex h-14 items-center gap-2 px-2">
          <button
            ref={ref}
            type="button"
            onClick={onOpenMenu}
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls={menuControlsId}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-600 [@media(hover:hover)]:hover:bg-gray-800 [@media(hover:hover)]:hover:text-white"
          >
            <Menu className="h-6 w-6" aria-hidden="true" />
          </button>
          {leading ?? (
            <>
              <Wordmark className="text-xl font-bold" />
              <span className="text-xs font-medium uppercase tracking-wider text-gray-400">
                {qualifier}
              </span>
            </>
          )}
          {trailing ? <div className="ml-auto flex items-center">{trailing}</div> : null}
        </div>
      </header>
    );
  }
);
