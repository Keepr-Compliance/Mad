'use client';

/**
 * CreateOrganizationDialog - Modal dialog for creating a new organization.
 *
 * Collects name and optional plan assignment. BACKLOG-4007: no Max Seats and no Default
 * License Status. Seats are entered once, on the deal; until a deal exists the database
 * default (admin_create_organization p_max_seats DEFAULT 5) applies.
 * Uses admin_create_organization RPC, then optionally admin_assign_org_plan.
 * Does NOT set the legacy `plan` column on organizations.
 */

import { useState, useEffect, useId } from 'react';
import { Button, FieldError, Input, Label, Modal, Select } from '@keepr/design-system';
import { createOrganization, assignOrgPlan, getActivePlansForOrgs, type Plan } from '@/lib/admin-queries';

interface CreateOrganizationDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateOrganizationDialog({ onClose, onCreated }: CreateOrganizationDialogProps) {
  const [name, setName] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [plans, setPlans] = useState<Plan[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingPlans, setIsLoadingPlans] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  // Load available plans for optional assignment
  useEffect(() => {
    async function loadPlans() {
      const result = await getActivePlansForOrgs();
      if (result.data) {
        setPlans(result.data);
      }
      setIsLoadingPlans(false);
    }
    loadPlans();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Organization name is required.');
      return;
    }

    setIsLoading(true);
    setError(null);

    // Step 1: Create the organization
    const result = await createOrganization(name.trim());

    if (result.error) {
      setError(result.error.message);
      setIsLoading(false);
      return;
    }

    // Step 2: Optionally assign plan (separate RPC call, not via legacy column)
    if (selectedPlanId && result.data?.id) {
      const planResult = await assignOrgPlan(result.data.id, selectedPlanId);
      if (planResult.error) {
        // Org was created but plan assignment failed — still succeed but warn
        setError(`Organization created, but plan assignment failed: ${planResult.error.message}`);
        setIsLoading(false);
        // Still refresh the list since org was created
        onCreated();
        return;
      }
    }

    onCreated();
  };

  return (
    <Modal open onClose={onClose} size="sm" dismissible={!isLoading} aria-labelledby={titleId}>
      <h3 id={titleId} className="text-lg font-semibold text-gray-900">
        Create Organization
      </h3>
      <p className="mt-1 text-sm text-gray-500">
        Seats are set on the deal, after the organization exists.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        {/* Organization Name */}
        <div>
          <Label htmlFor="org-name">Organization Name</Label>
          <Input
            id="org-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Realty"
            disabled={isLoading}
            autoFocus
          />
        </div>

        {/* Optional Plan */}
        <div>
          <Label htmlFor="org-plan">Plan (optional)</Label>
          <Select
            id="org-plan"
            value={selectedPlanId}
            onChange={(e) => setSelectedPlanId(e.target.value)}
            disabled={isLoading || isLoadingPlans}
          >
            <option value="">No plan</option>
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} ({plan.tier})
              </option>
            ))}
          </Select>
        </div>

        {/* Error */}
        {error && (
          <FieldError>{error}</FieldError>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isLoading || !name.trim()}
          >
            {isLoading ? 'Creating...' : 'Create Organization'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
