'use client';

/**
 * GroupRoleMappingTable - Editable table for IdP group to Keepr role mappings.
 *
 * Allows admins to:
 * - Add new group-to-role mappings
 * - Edit existing mappings
 * - Remove mappings
 * - Set the default role
 * - Toggle group sync on/off
 *
 * Saves changes to attribute_mapping.group_role_mapping JSONB on the
 * organization_identity_providers row.
 */

import { useState, useCallback } from 'react';
import {
  Users,
  Plus,
  Trash2,
  Save,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { Button, Card } from '@keepr/design-system';

// ---------------------------------------------------------------------------
// Types (inline -- NOT from @keepr/shared per Vercel deploy limitation)
// ---------------------------------------------------------------------------

export interface GroupRoleMappingConfig {
  group_role_mapping: Record<string, string>;
  default_role: string;
  group_sync_enabled: boolean;
}

interface MappingRow {
  /** Temporary key for React rendering */
  key: string;
  groupIdentifier: string;
  role: string;
}

const KEEPR_ROLES = ['agent', 'manager', 'admin'] as const;

interface GroupRoleMappingTableProps {
  initialMapping: GroupRoleMappingConfig;
  onSave: (mapping: GroupRoleMappingConfig) => Promise<boolean>;
}

let nextRowKey = 0;
function generateRowKey(): string {
  nextRowKey += 1;
  return `row-${nextRowKey}-${Date.now()}`;
}

function configToRows(config: GroupRoleMappingConfig): MappingRow[] {
  return Object.entries(config.group_role_mapping).map(([group, role]) => ({
    key: generateRowKey(),
    groupIdentifier: group,
    role,
  }));
}

export function GroupRoleMappingTable({
  initialMapping,
  onSave,
}: GroupRoleMappingTableProps) {
  const [rows, setRows] = useState<MappingRow[]>(() => configToRows(initialMapping));
  const [defaultRole, setDefaultRole] = useState(initialMapping.default_role || 'agent');
  const [groupSyncEnabled, setGroupSyncEnabled] = useState(initialMapping.group_sync_enabled);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleAddRow = useCallback(() => {
    setRows((prev) => [
      ...prev,
      { key: generateRowKey(), groupIdentifier: '', role: 'agent' },
    ]);
    setDirty(true);
    setMessage(null);
  }, []);

  const handleRemoveRow = useCallback((key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    setDirty(true);
    setMessage(null);
  }, []);

  const handleUpdateRow = useCallback((key: string, field: 'groupIdentifier' | 'role', value: string) => {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, [field]: value } : r))
    );
    setDirty(true);
    setMessage(null);
  }, []);

  const handleDefaultRoleChange = useCallback((value: string) => {
    setDefaultRole(value);
    setDirty(true);
    setMessage(null);
  }, []);

  const handleToggleGroupSync = useCallback(() => {
    setGroupSyncEnabled((prev) => !prev);
    setDirty(true);
    setMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    // Validate: no empty group identifiers
    const emptyGroups = rows.filter((r) => !r.groupIdentifier.trim());
    if (emptyGroups.length > 0) {
      setMessage({ type: 'error', text: 'All group identifiers must be filled in.' });
      return;
    }

    // Validate: no duplicate group identifiers
    const groupNames = rows.map((r) => r.groupIdentifier.trim().toLowerCase());
    const uniqueGroups = new Set(groupNames);
    if (uniqueGroups.size !== groupNames.length) {
      setMessage({ type: 'error', text: 'Duplicate group identifiers are not allowed.' });
      return;
    }

    const mapping: GroupRoleMappingConfig = {
      group_role_mapping: Object.fromEntries(
        rows.map((r) => [r.groupIdentifier.trim(), r.role])
      ),
      default_role: defaultRole,
      group_sync_enabled: groupSyncEnabled,
    };

    setSaving(true);
    setMessage(null);
    try {
      const success = await onSave(mapping);
      if (success) {
        setDirty(false);
        setMessage({ type: 'success', text: 'Group role mappings saved.' });
      } else {
        setMessage({ type: 'error', text: 'Failed to save mappings.' });
      }
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save mappings.',
      });
    } finally {
      setSaving(false);
    }
  }, [rows, defaultRole, groupSyncEnabled, onSave]);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Group Role Mapping</h3>
            <p className="text-xs text-gray-500">
              Map identity provider groups to Keepr roles
            </p>
          </div>
        </div>

        {/* Group sync toggle */}
        <button
          type="button"
          onClick={handleToggleGroupSync}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
            groupSyncEnabled
              ? 'text-amber-700 bg-white border-amber-300 hover:bg-amber-50'
              : 'text-green-700 bg-white border-green-300 hover:bg-green-50'
          }`}
        >
          {groupSyncEnabled ? (
            <>
              <ToggleLeft className="h-3 w-3" />
              Disable
            </>
          ) : (
            <>
              <ToggleRight className="h-3 w-3" />
              Enable
            </>
          )}
        </button>
      </div>

      {/* Status message */}
      {message && (
        <div
          className={`mb-4 rounded-md px-4 py-3 text-sm ${
            message.type === 'success'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : 'bg-red-50 text-red-700 border border-red-200'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Default role selector */}
      <div className="mb-4">
        <label
          htmlFor="default-role"
          className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1"
        >
          Default Role (when no group matches)
        </label>
        <select
          id="default-role"
          value={defaultRole}
          onChange={(e) => handleDefaultRoleChange(e.target.value)}
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 w-48"
        >
          {KEEPR_ROLES.map((role) => (
            <option key={role} value={role}>
              {role.charAt(0).toUpperCase() + role.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {/* Mapping table */}
      {groupSyncEnabled && (
        <>
          <div className="overflow-hidden border border-gray-200 rounded-lg">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    IdP Group (ID or Name)
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-40">
                    Keepr Role
                  </th>
                  <th className="px-4 py-2 w-12" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-4 py-6 text-center text-sm text-gray-500"
                    >
                      No mappings configured. Click &quot;Add Mapping&quot; to get started.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.key}>
                      <td className="px-4 py-2">
                        <input
                          type="text"
                          value={row.groupIdentifier}
                          onChange={(e) =>
                            handleUpdateRow(row.key, 'groupIdentifier', e.target.value)
                          }
                          placeholder="e.g., Keepr Agents or group-uuid"
                          className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400"
                        />
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={row.role}
                          onChange={(e) =>
                            handleUpdateRow(row.key, 'role', e.target.value)
                          }
                          className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-900"
                        >
                          {KEEPR_ROLES.map((role) => (
                            <option key={role} value={role}>
                              {role.charAt(0).toUpperCase() + role.slice(1)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => handleRemoveRow(row.key)}
                          className="inline-flex items-center rounded-md p-1 text-red-500 hover:text-red-700 hover:bg-red-50 transition-colors"
                          title="Remove mapping"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3">
            <Button
              variant="secondary"
              size="xs"
              onClick={handleAddRow}
            >
              <Plus className="h-3 w-3" />
              Add Mapping
            </Button>
          </div>
        </>
      )}

      {/* Save button */}
      {dirty && (
        <div className="mt-4 pt-4 border-t border-gray-100 flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 transition-colors disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Mappings'}
          </button>
        </div>
      )}
    </Card>
  );
}
