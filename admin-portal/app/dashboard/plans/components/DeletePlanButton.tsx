'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { deletePlan } from '@/lib/admin-queries';
import { ConfirmationDialog } from '@/components/shared/ConfirmationDialog';

interface DeletePlanButtonProps {
  planId: string;
  planName: string;
}

export function DeletePlanButton({ planId, planName }: DeletePlanButtonProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleDelete = async () => {
    setIsDeleting(true);
    setError(null);

    const result = await deletePlan(planId);

    if (result.error) {
      setError(result.error.message);
      setIsDeleting(false);
      setShowConfirm(false);
      return;
    }

    router.push('/dashboard/plans');
    router.refresh();
  };

  return (
    <>
      {error && (
        <p className="text-sm text-red-600 mb-2">{error}</p>
      )}
      <button
        onClick={() => setShowConfirm(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 transition-colors"
      >
        <Trash2 className="h-4 w-4" />
        Delete Plan
      </button>

      {showConfirm && (
        <ConfirmationDialog
          title="Delete Plan"
          description={`Are you sure you want to delete "${planName}"? This action cannot be undone. Plans with assigned organizations cannot be deleted.`}
          confirmLabel="Delete Plan"
          onConfirm={handleDelete}
          onCancel={() => setShowConfirm(false)}
          isLoading={isDeleting}
          isDestructive={true}
        />
      )}
    </>
  );
}
