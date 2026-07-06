'use client';

/**
 * CreateOrganizationDialog - Modal dialog for creating a new organization.
 *
 * Collects name, max seats, and optional plan assignment.
 * Uses admin_create_organization RPC, then optionally admin_assign_org_plan.
 * Does NOT set the legacy `plan` column on organizations.
 */

import { useState, useEffect, useId } from 'react';
import { Button, FieldError, FieldHelp, Input, Label, Modal, Select } from '@keepr/design-system';
import { createOrganization, assignOrgPlan, getActivePlansForOrgs, type Plan } from '@/lib/admin-queries';

interface CreateOrganizationDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

export function CreateOrganizationDialog({ onClose, onCreated }: CreateOrganizationDialogProps) {
  const [name, setName] = useState('');
  const [maxSeats, setMaxSeats] = useState(5);
  const [selectedPlanId, setSelectedPlanId] = useState('');
  const [defaultLicenseStatus, setDefaultLicenseStatus] = useState<'trial' | 'active'>('trial');
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
    const result = await createOrganization(name.trim(), maxSeats);

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
    <Modal open onClose={onClose} size="sm" dismissible={!isLoading}>
      <h3 id={titleId} className="text-lg font-semibold text-gray-900">
        Create Organization
      </h3>
      <p className="mt-1 text-sm text-gray-500">
        Set up a new organization with a name and seat limit.
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

        {/* Max Seats */}
        <div>
          <Label htmlFor="org-max-seats">Max Seats</Label>
          <Input
            id="org-max-seats"
            type="number"
            min={1}
            max={1000}
            value={maxSeats}
            onChange={(e) => setMaxSeats(Math.max(1, parseInt(e.target.value) || 1))}
            disabled={isLoading}
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

        {/* Default License Status */}
        <div>
          <Label htmlFor="org-license-status">Default License Status</Label>
          <Select
            id="org-license-status"
            value={defaultLicenseStatus}
            onChange={(e) => setDefaultLicenseStatus(e.target.value as 'trial' | 'active')}
            disabled={isLoading}
          >
            <option value="trial">Trial</option>
            <option value="active">Active</option>
          </Select>
          <FieldHelp>
            License status applied to members who join this organization.
          </FieldHelp>
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
