'use client';

/**
 * Reusable StatusBadge component for ticket status display.
 */

import { Badge } from '@keepr/design-system';
import type { BadgeHue } from '@keepr/design-system';
import type { TicketStatus } from '@/lib/support-types';
import { STATUS_LABELS } from '@/lib/support-types';

const STATUS_HUES: Record<TicketStatus, BadgeHue> = {
  new: 'blue',
  assigned: 'yellow',
  in_progress: 'green',
  pending: 'orange',
  resolved: 'purple',
  closed: 'gray',
  deleted: 'red',
};

interface StatusBadgeProps {
  status: TicketStatus;
  className?: string;
}

export function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  return (
    <Badge hue={STATUS_HUES[status]} size="sm" className={className}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}
