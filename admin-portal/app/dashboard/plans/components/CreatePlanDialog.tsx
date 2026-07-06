'use client';

/**
 * CreatePlanDialog - Modal dialog for creating a new plan.
 *
 * Collects name, tier, and optional description.
 * Uses the ConfirmationDialog pattern for consistent modal behavior.
 */

import { useState, useId } from 'react';
import { Modal, Label, Input, Select, FieldError, Button } from '@keepr/design-system';
import { createPlan } from '@/lib/admin-queries';

const TIER_OPTIONS = ['individual', 'team', 'enterprise', 'custom'] as const;

interface CreatePlanDialogProps {
  onClose: () => void;
  onCreated: (planId?: string) => void;
}

export function CreatePlanDialog({ onClose, onCreated }: CreatePlanDialogProps) {
  const [name, setName] = useState('');
  const [tier, setTier] = useState<string>('individual');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Plan name is required.');
      return;
    }

    setIsLoading(true);
    setError(null);

    const result = await createPlan(name.trim(), tier, description.trim() || undefined);

    if (result.error) {
      setError(result.error.message);
      setIsLoading(false);
      return;
    }

    const planId = (result.data as unknown as Record<string, unknown>)?.id as string | undefined;
    onCreated(planId);
  };

  return (
    <Modal open onClose={onClose} size="sm" dismissible={!isLoading}>
      <h3 id={titleId} className="text-lg font-semibold text-gray-900">
        Create New Plan
      </h3>
      <p className="mt-1 text-sm text-gray-500">
        Define a new subscription plan with a name and tier.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {/* Plan Name */}
        <div>
          <Label htmlFor="plan-name">Plan Name</Label>
          <Input
            id="plan-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Professional"
            disabled={isLoading}
          />
        </div>

        {/* Tier */}
        <div>
          <Label htmlFor="plan-tier">Tier</Label>
          <Select
            id="plan-tier"
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            disabled={isLoading}
          >
            {TIER_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </option>
            ))}
          </Select>
        </div>

        {/* Description */}
        <div>
          <label htmlFor="plan-description" className="block text-sm font-medium text-gray-700">
            Description (optional)
          </label>
          <textarea
            id="plan-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of this plan..."
            rows={3}
            disabled={isLoading}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-1 focus:ring-primary-500 disabled:opacity-50"
          />
        </div>

        {/* Error */}
        {error && (
          <FieldError>{error}</FieldError>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading || !name.trim()}>
            {isLoading ? 'Creating...' : 'Create Plan'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
