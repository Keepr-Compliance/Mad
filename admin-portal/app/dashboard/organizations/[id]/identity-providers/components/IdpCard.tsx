'use client';

/**
 * IdpCard - Displays a single identity provider configuration.
 *
 * Shows provider type, display name, status badge, and action buttons
 * for edit, toggle active, and delete.
 */

import { useState } from 'react';
import { Shield, Pencil, Trash2, ToggleLeft, ToggleRight, ExternalLink } from 'lucide-react';
import { Button, Card } from '@keepr/design-system';
import { ConfirmationDialog } from '@keepr/ui';
import { formatDate } from '@/lib/format';
import type { IdentityProviderDisplay, ProviderType } from '@/lib/idp-types';
import { providerTypeLabel } from '@/lib/idp-types';

interface IdpCardProps {
  idp: IdentityProviderDisplay;
  onEdit: (idp: IdentityProviderDisplay) => void;
  onToggleActive: (idpId: string, newState: boolean) => Promise<void>;
  onDelete: (idpId: string) => Promise<void>;
}

function ProviderIcon({ type }: { type: ProviderType }) {
  // Color coding by provider type
  const colorMap: Record<ProviderType, string> = {
    azure_ad: 'bg-blue-100 text-blue-700',
    google_workspace: 'bg-red-100 text-red-700',
    okta: 'bg-indigo-100 text-indigo-700',
    generic_saml: 'bg-purple-100 text-purple-700',
    generic_oidc: 'bg-teal-100 text-teal-700',
  };
  const color = colorMap[type] ?? 'bg-gray-100 text-gray-700';

  return (
    <div className={`h-10 w-10 rounded-lg ${color} flex items-center justify-center`}>
      <Shield className="h-5 w-5" />
    </div>
  );
}

function StatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        isActive
          ? 'bg-green-100 text-green-800'
          : 'bg-gray-100 text-gray-600'
      }`}
    >
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );
}

export function IdpCard({ idp, onEdit, onToggleActive, onDelete }: IdpCardProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const handleToggle = async () => {
    setActionLoading(true);
    try {
      await onToggleActive(idp.id, !idp.is_active);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      await onDelete(idp.id);
    } finally {
      setActionLoading(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <>
      <Card padding="none" className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <ProviderIcon type={idp.provider_type} />
            <div>
              <h3 className="text-sm font-semibold text-gray-900">
                {idp.display_name}
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {providerTypeLabel(idp.provider_type)}
              </p>
            </div>
          </div>
          <StatusBadge isActive={idp.is_active} />
        </div>

        {/* Details grid */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Client ID</dt>
            <dd className="mt-0.5 text-sm text-gray-900 truncate" title={idp.client_id ?? undefined}>
              {idp.client_id || '--'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Client Secret</dt>
            <dd className="mt-0.5 text-sm text-gray-900">
              {idp.has_client_secret ? '********' : '--'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Created</dt>
            <dd className="mt-0.5 text-sm text-gray-900">
              {formatDate(idp.created_at)}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Verified</dt>
            <dd className="mt-0.5 text-sm text-gray-900">
              {idp.verified_at ? formatDate(idp.verified_at) : 'Not verified'}
            </dd>
          </div>
        </div>

        {/* Issuer URL */}
        {idp.issuer_url && (
          <div className="mt-3">
            <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">Issuer URL</dt>
            <dd className="mt-0.5 text-sm text-gray-900 flex items-center gap-1 truncate">
              <ExternalLink className="h-3 w-3 flex-shrink-0 text-gray-400" />
              <span className="truncate" title={idp.issuer_url}>{idp.issuer_url}</span>
            </dd>
          </div>
        )}

        {/* Actions */}
        <div className="mt-4 pt-4 border-t border-gray-100 flex items-center gap-2">
          <Button
            variant="secondary"
            size="xs"
            onClick={() => onEdit(idp)}
            disabled={actionLoading}
          >
            <Pencil className="h-3 w-3" />
            Edit
          </Button>
          <button
            type="button"
            onClick={handleToggle}
            disabled={actionLoading}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors disabled:opacity-50 ${
              idp.is_active
                ? 'text-amber-700 bg-white border-amber-300 hover:bg-amber-50'
                : 'text-green-700 bg-white border-green-300 hover:bg-green-50'
            }`}
          >
            {idp.is_active ? (
              <>
                <ToggleLeft className="h-3 w-3" />
                Deactivate
              </>
            ) : (
              <>
                <ToggleRight className="h-3 w-3" />
                Activate
              </>
            )}
          </button>
          <Button
            variant="dangerOutline"
            size="xs"
            onClick={() => setShowDeleteConfirm(true)}
            disabled={actionLoading}
            className="ml-auto"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>
      </Card>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <ConfirmationDialog
          open
          title="Delete Identity Provider"
          description={`Are you sure you want to delete "${idp.display_name}"? This will remove the ${providerTypeLabel(idp.provider_type)} configuration for this organization. This action cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
          isDestructive
          loading={actionLoading}
        />
      )}
    </>
  );
}
