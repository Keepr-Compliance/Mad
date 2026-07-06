/**
 * Submission Detail Page Loading State
 *
 * Shows skeleton UI while submission details are being fetched.
 */

import { DetailHeaderSkeleton, Skeleton, CardSkeleton } from '@/components/ui/Skeleton';

export default function SubmissionDetailLoading() {
  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Back Link Skeleton */}
      <Skeleton className="h-4 w-40" />

      {/* Header Skeleton */}
      <DetailHeaderSkeleton />

      {/* Review Actions Skeleton */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <Skeleton className="h-6 w-32 mb-4" />
        <div className="flex gap-3">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-10 w-28" />
        </div>
      </div>

      {/* Messages Skeleton */}
      <CardSkeleton className="h-64" />

      {/* Attachments Skeleton */}
      <CardSkeleton className="h-48" />
    </div>
  );
}
