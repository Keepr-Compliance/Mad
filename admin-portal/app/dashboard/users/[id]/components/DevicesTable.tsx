'use client';

/**
 * DevicesTable - Displays registered devices for a user with revoke capability.
 *
 * Shows device name, platform, OS, app version, status badge, last active,
 * activated date, and a revoke button for active devices.
 */

import { useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Monitor } from 'lucide-react';
import { Card, Button } from '@keepr/design-system';
import { formatTimestamp } from '@/lib/format';
import { deactivateDevice } from '@/lib/admin-queries';

interface Device {
  id: string;
  device_name: string | null;
  device_id: string;
  os: string | null;
  app_version: string | null;
  platform: string | null;
  is_active: boolean;
  last_seen_at: string | null;
  activated_at: string | null;
}

interface DevicesTableProps {
  devices: Device[];
  userId: string;
  canManage: boolean;
}

export function DevicesTable({ devices, userId, canManage }: DevicesTableProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDialog = useCallback((device: Device) => {
    setSelectedDevice(device);
    setError(null);
    dialogRef.current?.showModal();
  }, []);

  const closeDialog = useCallback(() => {
    dialogRef.current?.close();
    setSelectedDevice(null);
  }, []);

  const handleRevoke = useCallback(async () => {
    if (!selectedDevice) return;
    setLoading(true);
    setError(null);

    try {
      const result = await deactivateDevice(selectedDevice.id, userId);
      if (result.error) {
        setError(result.error.message);
        return;
      }
      closeDialog();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }, [selectedDevice, userId, closeDialog, router]);

  return (
    <Card>
      <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wider flex items-center gap-2">
        <Monitor className="h-4 w-4 text-gray-400" />
        Devices
      </h3>

      {devices.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No devices registered.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Device
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Platform
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  OS
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Version
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Last Active
                </th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Activated
                </th>
                {canManage && (
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {devices.map((device) => (
                <tr key={device.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-sm text-gray-900 whitespace-nowrap">
                    {device.device_name || 'Unknown Device'}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-600 whitespace-nowrap">
                    {device.platform || '--'}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-600 whitespace-nowrap">
                    {device.os || '--'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <code className="text-xs text-gray-500 bg-gray-50 px-1.5 py-0.5 rounded">
                      {device.app_version || '--'}
                    </code>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {device.is_active ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                        Revoked
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-600 whitespace-nowrap">
                    {formatTimestamp(device.last_seen_at, 'Never')}
                  </td>
                  <td className="px-3 py-2 text-sm text-gray-500 whitespace-nowrap">
                    {formatTimestamp(device.activated_at, '--')}
                  </td>
                  {canManage && (
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {device.is_active && (
                        <button
                          type="button"
                          onClick={() => openDialog(device)}
                          className="text-xs font-medium text-danger-600 hover:text-danger-800 transition-colors"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Revoke confirmation dialog */}
      <dialog
        ref={dialogRef}
        className="rounded-lg shadow-xl border border-gray-200 p-0 backdrop:bg-black/50 max-w-md w-full"
      >
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900">Revoke Device</h3>

          <p className="mt-2 text-sm text-gray-600">
            Are you sure you want to revoke access for{' '}
            <span className="font-medium text-gray-900">
              {selectedDevice?.device_name || 'this device'}
            </span>
            ? The device will no longer be able to sync data.
          </p>

          {error && (
            <div className="mt-3 rounded-md bg-danger-50 p-3">
              <p className="text-sm text-danger-700">{error}</p>
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={closeDialog}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleRevoke}
              disabled={loading}
            >
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Revoking...
                </span>
              ) : (
                'Confirm Revoke'
              )}
            </Button>
          </div>
        </div>
      </dialog>
    </Card>
  );
}
