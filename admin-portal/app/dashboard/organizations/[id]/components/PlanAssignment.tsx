'use client';

/**
 * PlanAssignment - Displays and allows changing the plan assigned to an organization.
 *
 * Shows the current plan assignment with a dropdown to change it.
 * Uses the ConfirmationDialog for change confirmation.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { CreditCard, ArrowRight } from 'lucide-react';
import { Button, Card, FieldError, Label, Select } from '@keepr/design-system';
import { assignOrgPlan, getOrgPlan, getActivePlansForOrgs, type Plan, type OrganizationPlan } from '@/lib/admin-queries';
import { ConfirmationDialog } from '@/components/shared/ConfirmationDialog';
import { formatDate } from '@/lib/format';

interface PlanAssignmentProps {
  organizationId: string;
  canManage: boolean;
}

export function PlanAssignment({ organizationId, canManage }: PlanAssignmentProps) {
  const [currentPlan, setCurrentPlan] = useState<OrganizationPlan | null>(null);
  const [availablePlans, setAvailablePlans] = useState<Plan[]>([]);
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const [orgPlanResult, plansResult] = await Promise.all([
        getOrgPlan(organizationId),
        getActivePlansForOrgs(),
      ]);

      if (orgPlanResult.data) {
        setCurrentPlan(orgPlanResult.data);
        setSelectedPlanId(orgPlanResult.data.plan_id);
      }
      if (plansResult.data) {
        setAvailablePlans(plansResult.data);
      }
      setLoading(false);
    }
    load();
  }, [organizationId]);

  const selectedPlan = availablePlans.find((p) => p.id === selectedPlanId);
  const hasChanged = selectedPlanId !== (currentPlan?.plan_id ?? '');

  const handleAssign = async () => {
    if (!selectedPlanId) return;

    setSaving(true);
    setError(null);
    setShowConfirm(false);

    const result = await assignOrgPlan(organizationId, selectedPlanId);

    if (result.error) {
      const message = result.error.message === 'individual_plan_cannot_be_assigned_to_org'
        ? 'Individual plans cannot be assigned to organizations. Use Team, Enterprise, or Custom plans.'
        : result.error.message;
      setError(message);
      setSaving(false);
      return;
    }

    // Reload current plan data
    const orgPlanResult = await getOrgPlan(organizationId);
    if (orgPlanResult.data) {
      setCurrentPlan(orgPlanResult.data);
      setSelectedPlanId(orgPlanResult.data.plan_id);
    }

    setSaving(false);
  };

  if (loading) {
    return (
      <Card>
        <div className="animate-pulse space-y-3">
          <div className="h-4 w-32 bg-gray-200 rounded" />
          <div className="h-8 w-64 bg-gray-200 rounded" />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-8 w-8 rounded-lg bg-primary-100 text-primary-700 flex items-center justify-center">
          <CreditCard className="h-4 w-4" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">
          Plan Assignment
        </h3>
      </div>

      {/* Current plan info */}
      {currentPlan ? (
        <div className="mb-4 p-3 bg-gray-50 rounded-md">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-900">
                Current: {currentPlan.plans.name}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Tier: {currentPlan.plans.tier} | Assigned: {formatDate(currentPlan.assigned_at)}
              </p>
            </div>
            <Link
              href={`/dashboard/plans/${currentPlan.plan_id}`}
              className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
            >
              View Plan <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      ) : (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-md">
          <p className="text-sm text-amber-700">No plan assigned to this organization.</p>
        </div>
      )}

      {/* Plan selection */}
      {canManage && (
        <div className="space-y-3">
          <div>
            <Label htmlFor="plan-select">
              {currentPlan ? 'Change Plan' : 'Assign Plan'}
            </Label>
            <Select
              id="plan-select"
              value={selectedPlanId}
              onChange={(e) => {
                setSelectedPlanId(e.target.value);
                setError(null);
              }}
              disabled={saving}
            >
              <option value="">-- Select a plan --</option>
              {availablePlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} ({plan.tier})
                </option>
              ))}
            </Select>
          </div>

          {error && (
            <FieldError>{error}</FieldError>
          )}

          <Button
            size="sm"
            onClick={() => setShowConfirm(true)}
            disabled={!hasChanged || !selectedPlanId || saving}
          >
            {saving ? 'Saving...' : currentPlan ? 'Update Plan' : 'Assign Plan'}
          </Button>
        </div>
      )}

      {/* Confirmation dialog */}
      {showConfirm && selectedPlan && (
        <ConfirmationDialog
          title={currentPlan ? 'Change Organization Plan' : 'Assign Organization Plan'}
          description={
            currentPlan
              ? `Are you sure you want to change this organization's plan from "${currentPlan.plans.name}" to "${selectedPlan.name}"? This will immediately affect the organization's feature access.`
              : `Are you sure you want to assign the "${selectedPlan.name}" plan to this organization? This will immediately grant feature access based on the plan configuration.`
          }
          confirmLabel={currentPlan ? 'Change Plan' : 'Assign Plan'}
          onConfirm={handleAssign}
          onCancel={() => setShowConfirm(false)}
          isLoading={saving}
        />
      )}
    </Card>
  );
}
