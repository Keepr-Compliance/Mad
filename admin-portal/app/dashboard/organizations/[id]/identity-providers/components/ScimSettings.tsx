'use client';

/**
 * ScimSettings - SCIM endpoint URL and bearer token management.
 *
 * Displays the organization's SCIM endpoint URL and allows admins to:
 * - Generate a new bearer token (shown only once)
 * - Regenerate a token (invalidates the previous one)
 * - View token metadata (last used, request count)
 */

import { useState, useCallback } from 'react';
import { Key, Copy, RefreshCw, Check, AlertTriangle, Eye, EyeOff } from 'lucide-react';
import { Card } from '@keepr/design-system';
import { ConfirmationDialog } from '@keepr/ui';
import { formatTimestamp } from '@/lib/format';

// ---------------------------------------------------------------------------
// Types (inline -- NOT from @keepr/shared per Vercel deploy limitation)
// ---------------------------------------------------------------------------

export interface ScimTokenInfo {
  id: string;
  description: string | null;
  last_used_at: string | null;
  request_count: number;
  expires_at: string | null;
  created_at: string;
}

interface ScimSettingsProps {
  organizationId: string;
  scimEndpointUrl: string;
  existingToken: ScimTokenInfo | null;
  onGenerateToken: (description: string) => Promise<{ token: string; tokenInfo: ScimTokenInfo } | null>;
  onRevokeToken: (tokenId: string) => Promise<boolean>;
}

export function ScimSettings({
  organizationId,
  scimEndpointUrl,
  existingToken,
  onGenerateToken,
  onRevokeToken,
}: ScimSettingsProps) {
  const [tokenInfo, setTokenInfo] = useState<ScimTokenInfo | null>(existingToken);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<'url' | 'token' | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCopy = useCallback(async (text: string, type: 'url' | 'token') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(type);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard API not available
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await onGenerateToken(`SCIM token for org ${organizationId}`);
      if (result) {
        setNewToken(result.token);
        setShowToken(true);
        setTokenInfo(result.tokenInfo);
      } else {
        setError('Failed to generate token.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token.');
    } finally {
      setLoading(false);
    }
  }, [onGenerateToken, organizationId]);

  const handleRegenerate = useCallback(async () => {
    if (!tokenInfo) return;
    setLoading(true);
    setError(null);
    try {
      // Revoke the old token first
      const revoked = await onRevokeToken(tokenInfo.id);
      if (!revoked) {
        setError('Failed to revoke existing token.');
        return;
      }
      // Generate a new one
      const result = await onGenerateToken(`SCIM token for org ${organizationId}`);
      if (result) {
        setNewToken(result.token);
        setShowToken(true);
        setTokenInfo(result.tokenInfo);
      } else {
        setError('Token revoked but failed to generate a new one.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to regenerate token.');
    } finally {
      setLoading(false);
      setShowRegenerateConfirm(false);
    }
  }, [tokenInfo, onRevokeToken, onGenerateToken, organizationId]);

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center">
          <Key className="h-5 w-5" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">SCIM Provisioning</h3>
          <p className="text-xs text-gray-500">
            Configure SCIM 2.0 endpoint for automatic user provisioning
          </p>
        </div>
      </div>

      {/* SCIM Endpoint URL */}
      <div className="mb-4">
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
          SCIM Endpoint URL
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            readOnly
            value={scimEndpointUrl}
            className="flex-1 rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 font-mono"
          />
          <button
            type="button"
            onClick={() => handleCopy(scimEndpointUrl, 'url')}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
            title="Copy URL"
          >
            {copied === 'url' ? (
              <Check className="h-4 w-4 text-green-600" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Newly generated token (show only once) */}
      {newToken && (
        <div className="mb-4 rounded-md bg-amber-50 border border-amber-200 p-4">
          <div className="flex items-start gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <p className="text-sm font-medium text-amber-800">
              Copy this token now. It will not be shown again.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type={showToken ? 'text' : 'password'}
              readOnly
              value={newToken}
              className="flex-1 rounded-md border border-amber-300 bg-white px-3 py-2 text-sm text-gray-900 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-2 text-gray-700 hover:bg-gray-50 transition-colors"
              title={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => handleCopy(newToken, 'token')}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              title="Copy token"
            >
              {copied === 'token' ? (
                <Check className="h-4 w-4 text-green-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      )}

      {/* Token status */}
      {tokenInfo ? (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Created
              </dt>
              <dd className="mt-0.5 text-sm text-gray-900">
                {formatTimestamp(tokenInfo.created_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Last Used
              </dt>
              <dd className="mt-0.5 text-sm text-gray-900">
                {formatTimestamp(tokenInfo.last_used_at, 'Never')}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Requests
              </dt>
              <dd className="mt-0.5 text-sm text-gray-900">
                {tokenInfo.request_count.toLocaleString()}
              </dd>
            </div>
          </div>
          {tokenInfo.expires_at && (
            <div>
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Expires
              </dt>
              <dd className="mt-0.5 text-sm text-gray-900">
                {formatTimestamp(tokenInfo.expires_at)}
              </dd>
            </div>
          )}

          <div className="pt-3 border-t border-gray-100">
            <button
              type="button"
              onClick={() => setShowRegenerateConfirm(true)}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              Regenerate Token
            </button>
          </div>
        </div>
      ) : (
        <div className="pt-2">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 transition-colors disabled:opacity-50"
          >
            <Key className="h-4 w-4" />
            {loading ? 'Generating...' : 'Generate Bearer Token'}
          </button>
        </div>
      )}

      {/* Regenerate confirmation dialog */}
      {showRegenerateConfirm && (
        <ConfirmationDialog
          open
          title="Regenerate SCIM Token"
          description="This will invalidate the existing token immediately. Any IdP integration using the current token will stop working until reconfigured with the new token."
          confirmLabel="Regenerate"
          onConfirm={handleRegenerate}
          onCancel={() => setShowRegenerateConfirm(false)}
          isDestructive
          loading={loading}
        />
      )}
    </Card>
  );
}
