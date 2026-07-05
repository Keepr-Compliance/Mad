'use client';

import { useState, useEffect, useCallback } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  generateScimToken,
  revokeScimToken,
  listScimTokens,
  listScimSyncLogs,
} from '@/lib/actions/scim';
import { useImpersonation } from '@/components/providers/ImpersonationProvider';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  CardContent,
  Input,
  Label,
  PageHeader,
  Table,
  TableHead,
  TableBody,
  Tr,
  Th,
  Td,
} from '@keepr/design-system';

interface ScimToken {
  id: string;
  description: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  request_count: number;
}

interface SyncLogEntry {
  id: string;
  operation: string;
  resource_type: string;
  external_id: string | null;
  response_status: number | null;
  error_message: string | null;
  created_at: string;
}

export default function ScimSettingsPage() {
  const { isImpersonating } = useImpersonation();
  const [tokens, setTokens] = useState<ScimToken[]>([]);
  const [syncLogs, setSyncLogs] = useState<SyncLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Token generation state
  const [description, setDescription] = useState('');
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const scimEndpoint = `${(process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()}/functions/v1/scim/v2/Users`;

  const loadData = useCallback(async () => {
    try {
      setError(null);
      const [tokenData, logData] = await Promise.all([
        listScimTokens(),
        listScimSyncLogs(),
      ]);
      setTokens(tokenData);
      setSyncLogs(logData);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load SCIM data'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleGenerate() {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await generateScimToken(description || 'SCIM Token');
      setGeneratedToken(result.token);
      setDescription('');
      await loadData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to generate token'
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevoke(tokenId: string) {
    if (revoking) return;
    setRevoking(tokenId);
    setError(null);
    try {
      await revokeScimToken(tokenId);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke token');
    } finally {
      setRevoking(null);
    }
  }

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto space-y-6">
        <PageHeader title="SCIM Provisioning" subtitle="Loading..." />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <PageHeader
        title="SCIM Provisioning"
        subtitle="Configure SCIM to automatically sync users from your identity provider"
      />

      {/* Read-only banner during impersonation */}
      {isImpersonating && (
        <Alert variant="warning">Read-only during support session</Alert>
      )}

      {/* Error Banner */}
      {error && <Alert variant="error">{error}</Alert>}

      {/* SCIM Endpoint URL */}
      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">
            SCIM Endpoint URL
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Use this URL in your identity provider&apos;s SCIM configuration
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-gray-50 px-3 py-2 rounded-md text-sm font-mono text-gray-800 border border-gray-200 truncate">
              {scimEndpoint}
            </code>
            <button
              onClick={() => handleCopy(scimEndpoint)}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 flex-shrink-0"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              Copy
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Generate Token */}
      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">
            Generate Bearer Token
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Create a token for your identity provider to authenticate SCIM
            requests
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Label htmlFor="token-description">Description</Label>
              <Input
                id="token-description"
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Okta SCIM Integration"
                disabled={isImpersonating}
              />
            </div>
            <Button
              onClick={handleGenerate}
              disabled={generating || isImpersonating}
            >
              {generating ? 'Generating...' : 'Generate Token'}
            </Button>
          </div>

          {/* Show generated token once */}
          {generatedToken && (
            <Alert variant="warning">
              <p className="font-medium mb-2">
                Copy this token now. It will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-white px-3 py-2 rounded-md text-sm font-mono text-gray-800 border border-amber-300 break-all">
                  {generatedToken}
                </code>
                <button
                  onClick={() => handleCopy(generatedToken)}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-amber-700 bg-amber-100 border border-amber-300 rounded-md hover:bg-amber-200 flex-shrink-0"
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Token List */}
      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">Active Tokens</h2>
          <p className="mt-1 text-sm text-gray-500">
            Manage your SCIM bearer tokens
          </p>
        </CardHeader>
        {tokens.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-500">
            No tokens created yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHead>
                <tr>
                  <Th>Description</Th>
                  <Th>Created</Th>
                  <Th>Last Used</Th>
                  <Th>Requests</Th>
                  <Th>Status</Th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </TableHead>
              <TableBody>
                {tokens.map((token) => {
                  const isRevoked = !!token.revoked_at;
                  return (
                    <Tr key={token.id}>
                      <Td emphasis="primary">{token.description}</Td>
                      <Td>{formatDate(token.created_at)}</Td>
                      <Td>
                        {token.last_used_at
                          ? formatDate(token.last_used_at)
                          : 'Never'}
                      </Td>
                      <Td>{token.request_count}</Td>
                      <Td>
                        <Badge hue={isRevoked ? 'red' : 'green'}>
                          {isRevoked ? 'Revoked' : 'Active'}
                        </Badge>
                      </Td>
                      <Td className="text-right">
                        {!isRevoked && (
                          <button
                            onClick={() => handleRevoke(token.id)}
                            disabled={revoking === token.id || isImpersonating}
                            className="text-red-600 hover:text-red-800 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {revoking === token.id
                              ? 'Revoking...'
                              : 'Revoke'}
                          </button>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Sync Logs */}
      <Card padding="none">
        <CardHeader>
          <h2 className="text-lg font-semibold text-gray-900">
            Sync Activity Log
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Recent SCIM provisioning operations
          </p>
        </CardHeader>
        {syncLogs.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-gray-500">
            No sync activity yet
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHead>
                <tr>
                  <Th>Time</Th>
                  <Th>Operation</Th>
                  <Th>Resource</Th>
                  <Th>External ID</Th>
                  <Th>Status</Th>
                  <Th>Error</Th>
                </tr>
              </TableHead>
              <TableBody>
                {syncLogs.map((log) => (
                  <Tr key={log.id}>
                    <Td>{formatDate(log.created_at)}</Td>
                    <Td emphasis="primary">{log.operation}</Td>
                    <Td>{log.resource_type}</Td>
                    <Td className="font-mono">{log.external_id || '-'}</Td>
                    <Td>
                      <Badge
                        hue={
                          log.response_status && log.response_status < 400
                            ? 'green'
                            : log.response_status && log.response_status >= 400
                              ? 'red'
                              : 'yellow'
                        }
                      >
                        {log.response_status ?? 'pending'}
                      </Badge>
                    </Td>
                    <td className="px-6 py-4 text-sm text-red-600 max-w-xs truncate">
                      {log.error_message || '-'}
                    </td>
                  </Tr>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );
}
