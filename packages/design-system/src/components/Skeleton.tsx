import type { ReactNode } from 'react';
import { cn } from '../cn';

/** Pulsing gray placeholder bar; size it with width/height utilities. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse bg-gray-200 rounded', className)} />;
}

/** Card-shaped skeleton wrapper matching the canonical Card chrome. */
export function CardSkeleton({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <div className={cn('bg-white rounded-lg shadow-sm border border-gray-200 p-6 animate-pulse', className)}>
      {children ?? (
        <>
          <div className="h-4 bg-gray-200 rounded w-24 mb-3" />
          <div className="h-8 bg-gray-200 rounded w-1/2" />
        </>
      )}
    </div>
  );
}
