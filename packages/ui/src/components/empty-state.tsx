import * as React from 'react';
import { cn } from '../lib/cn';

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /**
   * lucide icon element; the standard treatment is
   * `<Icon className="mx-auto h-12 w-12 text-muted-foreground" />`.
   */
  icon?: React.ReactNode;
  /** Optional call-to-action rendered under the description. */
  action?: React.ReactNode;
  /** Set false when rendering inside an existing card to skip the card chrome. */
  card?: boolean;
}

/**
 * Centered empty/zero state: icon + title + description (+ action), with or
 * without card chrome. Matches @keepr/design-system's EmptyState API.
 */
export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  ({ title, description, icon, action, card = true, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'text-center',
        card ? 'rounded-lg border bg-card p-12 shadow-sm' : 'py-12',
        className
      )}
      {...props}
    >
      {icon}
      <p
        className={cn(
          'text-sm font-medium text-foreground',
          icon ? 'mt-4' : undefined
        )}
      >
        {title}
      </p>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
);
EmptyState.displayName = 'EmptyState';
