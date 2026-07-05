/**
 * Users Page Loading State
 *
 * Shows skeleton UI while users data is being fetched.
 * TASK-1808: Loading skeleton for users management page
 */

import { Skeleton } from '@/components/ui/Skeleton';

export default function UsersLoading() {
  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header Skeleton */}
      <div className="flex justify-between items-center">
        <div>
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>

      {/* Search/Filter Bar Skeleton */}
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg p-4">
        <div className="flex flex-wrap gap-4 items-center">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-32" />
        </div>
      </div>

      {/* User Cards/Table Skeleton */}
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
        <div className="divide-y divide-gray-200">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                {/* Avatar */}
                <Skeleton className="h-12 w-12 rounded-full" />
                {/* User Info */}
                <div>
                  <Skeleton className="h-5 w-40 mb-2" />
                  <Skeleton className="h-4 w-48" />
                </div>
              </div>
              <div className="flex items-center gap-4">
                {/* Role Badge */}
                <Skeleton className="h-6 w-20 rounded-full" />
                {/* Actions */}
                <Skeleton className="h-8 w-8 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
