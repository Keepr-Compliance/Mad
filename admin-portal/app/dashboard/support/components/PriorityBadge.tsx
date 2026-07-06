'use client';

/**
 * Reusable PriorityBadge component for ticket priority display.
 */

import { Badge } from '@keepr/design-system';
import type { BadgeHue } from '@keepr/design-system';
import type { TicketPriority } from '@/lib/support-types';
import { PRIORITY_LABELS } from '@/lib/support-types';

const PRIORITY_HUES: Record<TicketPriority, BadgeHue> = {
  low: 'gray',
  normal: 'blue',
  high: 'orange',
  urgent: 'red',
};

interface PriorityBadgeProps {
  priority: TicketPriority;
  className?: string;
}

export function PriorityBadge({ priority, className = '' }: PriorityBadgeProps) {
  return (
    <Badge hue={PRIORITY_HUES[priority]} size="sm" className={className}>
      {PRIORITY_LABELS[priority]}
    </Badge>
  );
}
