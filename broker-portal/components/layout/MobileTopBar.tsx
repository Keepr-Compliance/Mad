'use client';

/**
 * MobileTopBar - Broker Portal (BACKLOG-3798)
 *
 * Below md the desktop sidebar is hidden; this bar holds the menu button that
 * opens the slide-out drawer (Sidebar's mobileOpen). Hidden from md up.
 */

import { forwardRef } from 'react';
import { Menu } from 'lucide-react';
import { Wordmark } from '@keepr/ui';

export interface MobileTopBarProps {
  menuOpen: boolean;
  onOpenMenu: () => void;
}

export const MobileTopBar = forwardRef<HTMLButtonElement, MobileTopBarProps>(function MobileTopBar(
  { menuOpen, onOpenMenu },
  ref
) {
  return (
    <header
      data-testid="mobile-top-bar"
      className="md:hidden sticky top-0 z-30 flex h-14 items-center gap-2 bg-gray-900 px-2 text-white"
    >
      <button
        ref={ref}
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        aria-expanded={menuOpen}
        aria-controls="mobile-nav"
        className="flex h-11 w-11 items-center justify-center rounded-md text-gray-300 hover:bg-gray-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-gray-600"
      >
        <Menu className="h-6 w-6" aria-hidden="true" />
      </button>
      <Wordmark className="text-xl font-bold" />
      <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Broker</span>
    </header>
  );
});
