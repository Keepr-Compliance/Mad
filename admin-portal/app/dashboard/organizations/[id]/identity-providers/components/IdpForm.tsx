'use client';

/**
 * IdpForm - Create/edit form for identity provider configuration.
 *
 * Form fields adapt based on the selected provider type:
 * - Azure AD: tenant ID (populates well-known URLs), client ID, client secret
 * - Google Workspace: workspace domain, client ID, client secret
 *
 * Client secrets are masked with "********" for existing entries.
 * On save, an empty secret field preserves the existing secret.
 */

import { useState, useEffect } from 'react';
import { X, Shield, Info } from 'lucide-react';
import { Button, Card, Input, Label, Select } from '@keepr/design-system';
import type { IdentityProviderDisplay, ProviderType, IdpFormData } from '@/lib/idp-types';
import { providerTypeLabel } from '@/lib/idp-types';

interface IdpFormProps {
  /** Existing IdP to edit, or null for create mode */
  editingIdp: IdentityProviderDisplay | null;
  /** Called with form data when the user submits */
  onSave: (data: IdpFormData) => Promise<void>;
  /** Called when the user cancels */
  onCancel: () => void;
  /** Pre-populated org data for Azure/Google fields */
  orgTenantId: string | null;
  orgWorkspaceDomain: string | null;
}

const PROVIDER_TYPES: { value: ProviderType; label: string }[] = [
  { value: 'azure_ad', label: 'Azure AD' },
  { value: 'google_workspace', label: 'Google Workspace' },
];

export function IdpForm({
  editingIdp,
  onSave,
  onCancel,
  orgTenantId,
  orgWorkspaceDomain,
}: IdpFormProps) {
  const isEditing = !!editingIdp;

  const [providerType, setProviderType] = useState<ProviderType>(
    editingIdp?.provider_type ?? 'azure_ad'
  );
  const [displayName, setDisplayName] = useState(editingIdp?.display_name ?? '');
  const [clientId, setClientId] = useState(editingIdp?.client_id ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [tenantId, setTenantId] = useState(orgTenantId ?? '');
  const [workspaceDomain, setWorkspaceDomain] = useState(orgWorkspaceDomain ?? '');
  const [isActive, setIsActive] = useState(editingIdp?.is_active ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // When editing an Azure AD IdP, extract tenant ID from issuer URL if we
  // don't already have it from the org record
  useEffect(() => {
    if (editingIdp?.provider_type === 'azure_ad' && editingIdp.issuer_url && !tenantId) {
      const match = editingIdp.issuer_url.match(
        /login\.microsoftonline\.com\/([^/]+)/
      );
      if (match?.[1]) {
        setTenantId(match[1]);
      }
    }
  }, [editingIdp, tenantId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!displayName.trim()) {
      setError('Display name is required.');
      return;
    }
    if (!clientId.trim()) {
      setError('Client ID is required.');
      return;
    }
    if (!isEditing && !clientSecret.trim()) {
      setError('Client secret is required for new providers.');
      return;
    }
    if (providerType === 'azure_ad' && !tenantId.trim()) {
      setError('Tenant ID is required for Azure AD providers.');
      return;
    }
    if (providerType === 'google_workspace' && !workspaceDomain.trim()) {
      setError('Workspace domain is required for Google Workspace providers.');
      return;
    }

    setSaving(true);
    try {
      await onSave({
        provider_type: providerType,
        display_name: displayName.trim(),
        client_id: clientId.trim(),
        client_secret: clientSecret.trim() || undefined,
        tenant_id: providerType === 'azure_ad' ? tenantId.trim() : undefined,
        workspace_domain: providerType === 'google_workspace' ? workspaceDomain.trim() : undefined,
        is_active: isActive,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-primary-100 text-primary-700 flex items-center justify-center">
            <Shield className="h-4 w-4" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider">
            {isEditing ? 'Edit Identity Provider' : 'Add Identity Provider'}
          </h3>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="p-1 rounded hover:bg-gray-100 transition-colors"
          aria-label="Close form"
        >
          <X className="h-5 w-5 text-gray-400" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Provider Type */}
        <div>
          <Label htmlFor="idp-provider-type">
            Provider Type
          </Label>
          <Select
            id="idp-provider-type"
            value={providerType}
            onChange={(e) => {
              setProviderType(e.target.value as ProviderType);
              setError(null);
            }}
            disabled={isEditing || saving}
            className="disabled:bg-gray-50"
          >
            {PROVIDER_TYPES.map((pt) => (
              <option key={pt.value} value={pt.value}>
                {pt.label}
              </option>
            ))}
          </Select>
          {isEditing && (
            <p className="mt-1 text-xs text-gray-500">
              Provider type cannot be changed after creation.
            </p>
          )}
        </div>

        {/* Display Name */}
        <div>
          <Label htmlFor="idp-display-name">
            Display Name
          </Label>
          <Input
            id="idp-display-name"
            type="text"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setError(null);
            }}
            disabled={saving}
            placeholder={`e.g. ${providerTypeLabel(providerType)} SSO`}
          />
        </div>

        {/* Azure AD: Tenant ID */}
        {providerType === 'azure_ad' && (
          <div>
            <Label htmlFor="idp-tenant-id">
              Tenant ID
            </Label>
            <Input
              id="idp-tenant-id"
              type="text"
              value={tenantId}
              onChange={(e) => {
                setTenantId(e.target.value);
                setError(null);
              }}
              disabled={saving}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
            <div className="mt-1 flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-gray-500">
                The Azure AD tenant ID is used to auto-populate OAuth endpoints and will be saved to the organization record.
              </p>
            </div>
          </div>
        )}

        {/* Google Workspace: Domain */}
        {providerType === 'google_workspace' && (
          <div>
            <Label htmlFor="idp-workspace-domain">
              Workspace Domain
            </Label>
            <Input
              id="idp-workspace-domain"
              type="text"
              value={workspaceDomain}
              onChange={(e) => {
                setWorkspaceDomain(e.target.value);
                setError(null);
              }}
              disabled={saving}
              placeholder="e.g. example.com"
            />
            <div className="mt-1 flex items-start gap-1.5">
              <Info className="h-3.5 w-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-gray-500">
                The Google Workspace domain will be saved to the organization record for JIT provisioning.
              </p>
            </div>
          </div>
        )}

        {/* Client ID */}
        <div>
          <Label htmlFor="idp-client-id">
            Client ID
          </Label>
          <Input
            id="idp-client-id"
            type="text"
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              setError(null);
            }}
            disabled={saving}
            placeholder="OAuth client ID"
          />
        </div>

        {/* Client Secret */}
        <div>
          <Label htmlFor="idp-client-secret">
            Client Secret
          </Label>
          <Input
            id="idp-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => {
              setClientSecret(e.target.value);
              setError(null);
            }}
            disabled={saving}
            placeholder={isEditing ? '********  (leave blank to keep current)' : 'OAuth client secret'}
          />
          {isEditing && (
            <p className="mt-1 text-xs text-gray-500">
              Leave blank to keep the existing secret. Enter a new value to replace it.
            </p>
          )}
        </div>

        {/* Active toggle */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={isActive}
            onClick={() => setIsActive(!isActive)}
            disabled={saving}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 ${
              isActive ? 'bg-primary-600' : 'bg-gray-200'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                isActive ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
          <span className="text-sm text-gray-700">
            {isActive ? 'Active' : 'Inactive'}
          </span>
        </div>

        {/* Auto-populated URLs info */}
        {providerType === 'azure_ad' && tenantId && (
          <div className="rounded-md bg-blue-50 border border-blue-200 p-3">
            <p className="text-xs font-medium text-blue-800 mb-1.5">
              Auto-populated endpoints for tenant: {tenantId}
            </p>
            <ul className="text-xs text-blue-700 space-y-0.5">
              <li>Authorization: login.microsoftonline.com/{tenantId}/oauth2/v2.0/authorize</li>
              <li>Token: login.microsoftonline.com/{tenantId}/oauth2/v2.0/token</li>
              <li>UserInfo: graph.microsoft.com/oidc/userinfo</li>
            </ul>
          </div>
        )}

        {providerType === 'google_workspace' && (
          <div className="rounded-md bg-blue-50 border border-blue-200 p-3">
            <p className="text-xs font-medium text-blue-800 mb-1.5">
              Auto-populated Google OAuth endpoints
            </p>
            <ul className="text-xs text-blue-700 space-y-0.5">
              <li>Authorization: accounts.google.com/o/oauth2/v2/auth</li>
              <li>Token: oauth2.googleapis.com/token</li>
              <li>UserInfo: openidconnect.googleapis.com/v1/userinfo</li>
            </ul>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="secondary"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={saving}
          >
            {saving ? (
              <span className="inline-flex items-center gap-1.5">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Saving...
              </span>
            ) : (
              isEditing ? 'Save Changes' : 'Create Provider'
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}
