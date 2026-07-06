/**
 * Skeleton Loading Component
 *
 * Provides placeholder loading states for various UI elements.
 * Built on the @keepr/design-system Skeleton primitive.
 */

import { Skeleton } from '@keepr/ui';
// cardSurfaceClasses/cn have no @keepr/ui equivalent (Tier-2), keep from design-system.
import { cardSurfaceClasses, cn } from '@keepr/design-system';

export { Skeleton } from '@keepr/ui';

interface SkeletonProps {
  className?: string;
}

/**
 * Table Row Skeleton
 */
export function TableRowSkeleton() {
  return (
    <tr className="border-b border-gray-200">
      <td className="px-6 py-4">
        <Skeleton className="h-4 w-48 mb-2" />
        <Skeleton className="h-3 w-32" />
      </td>
      <td className="px-6 py-4">
        <Skeleton className="h-4 w-16" />
      </td>
      <td className="px-6 py-4">
        <Skeleton className="h-4 w-24" />
      </td>
      <td className="px-6 py-4">
        <Skeleton className="h-6 w-24 rounded-full" />
      </td>
      <td className="px-6 py-4">
        <Skeleton className="h-4 w-32" />
      </td>
      <td className="px-6 py-4">
        <Skeleton className="h-4 w-16" />
      </td>
      <td className="px-6 py-4 text-right">
        <Skeleton className="h-4 w-12 ml-auto" />
      </td>
    </tr>
  );
}

/**
 * Submission Table Loading Skeleton
 */
export function SubmissionTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className={cn(cardSurfaceClasses, 'overflow-hidden')}>
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Property
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Type
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Price
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Status
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Docs
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              Submitted
            </th>
            <th className="relative px-6 py-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {Array.from({ length: rows }).map((_, i) => (
            <TableRowSkeleton key={i} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Card Skeleton
 */
export function CardSkeleton({ className }: SkeletonProps) {
  return (
    <div className={cn(cardSurfaceClasses, 'p-6', className)}>
      <Skeleton className="h-6 w-32 mb-4" />
      <Skeleton className="h-4 w-full mb-2" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

/**
 * Stats Card Skeleton
 *
 * Mirrors the design-system StatCard layout (icon tile + label + value).
 */
export function StatsCardSkeleton() {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5 flex items-center gap-4">
      <Skeleton className="h-11 w-11 rounded-lg" />
      <div className="flex-1 min-w-0">
        <Skeleton className="h-4 w-24 mb-2" />
        <Skeleton className="h-8 w-16" />
      </div>
    </div>
  );
}

/**
 * Detail Page Header Skeleton
 */
export function DetailHeaderSkeleton() {
  return (
    <div className={cn(cardSurfaceClasses, 'overflow-hidden')}>
      <div className="px-6 py-5 border-b border-gray-200">
        <div className="flex justify-between items-start">
          <div>
            <Skeleton className="h-8 w-64 mb-2" />
            <Skeleton className="h-4 w-48" />
          </div>
          <Skeleton className="h-8 w-28 rounded-full" />
        </div>
      </div>
      <div className="px-6 py-5 grid grid-cols-2 md:grid-cols-4 gap-6">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i}>
            <Skeleton className="h-4 w-24 mb-2" />
            <Skeleton className="h-5 w-32" />
          </div>
        ))}
      </div>
    </div>
  );
}
