'use client';

import * as React from 'react';
import { badgeHueClasses } from '@keepr/design-system';
import type { BadgeHue } from '@keepr/design-system';
import { cn } from '../../lib/cn';

/**
 * Phone kit — status / priority pills.
 *
 * Colour comes from the ONE hue map in @keepr/design-system (`badgeHueClasses`);
 * the kit holds no hue table of its own. Mapping a domain status ("testing",
 * "blocked") to a hue stays in each app — e.g. testing → `yellow`.
 * Pills always render their word: colour is never the only signal.
 *
 * Consumers: BACKLOG-3898 (support queue), BACKLOG-3899 (ticket conversation),
 * BACKLOG-3900 (projects), BACKLOG-3902 (broker users).
 */
export interface StatusPillProps {
  hue: BadgeHue;
  children: React.ReactNode;
  className?: string;
}

export function StatusPill({ hue, children, className }: StatusPillProps) {
  return (
    <span
      data-slot="status-pill"
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        badgeHueClasses(hue),
        className
      )}
    >
      {children}
    </span>
  );
}

/**
 * Priority pill: same hue source as StatusPill, square-cornered so a priority and a
 * status sitting side by side on a card stay distinguishable.
 *
 * Consumers: BACKLOG-3898 (support queue), BACKLOG-3900 (projects).
 */
export function PriorityPill({ hue, children, className }: StatusPillProps) {
  return (
    <span
      data-slot="priority-pill"
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border border-current/20 px-2 py-0.5 text-xs font-medium',
        badgeHueClasses(hue),
        className
      )}
    >
      {children}
    </span>
  );
}

export type { BadgeHue };
