import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Pulsing placeholder. Size it with width/height utilities, e.g.
 * `<Skeleton className="h-4 w-24" />`. Mirrors @keepr/design-system's Skeleton.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}
