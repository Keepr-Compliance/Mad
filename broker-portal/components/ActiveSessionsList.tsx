'use client';

/**
 * TASK-2062: Active Sessions list for the broker portal.
 * Displays devices where the user is currently logged in.
 * The broker portal session itself is shown as "Web Portal (this browser)".
 */

import { useState, useEffect } from 'react';
import { Globe, Monitor } from 'lucide-react';
import { Badge } from '@keepr/design-system';
import { getActiveDevices } from '@/lib/actions/getActiveDevices';

interface DeviceSession {
  device_id: string;
  device_name: string | null;
  os: string | null;
  platform: string | null;
  last_seen_at: string | null;
}

function formatRelativeTime(isoDate: string | null): string {
  if (!isoDate) return 'Unknown';

  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 0 || isNaN(diffMs)) return 'Just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'Just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;

  return new Date(isoDate).toLocaleDateString();
}

export function ActiveSessionsList() {
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const result = await getActiveDevices();
        if (result.success && result.devices) {
          setDevices(result.devices);
        } else if (result.error) {
          setError(result.error);
        }
      } catch {
        setError('Failed to load active sessions');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <div>
      {/* Current browser session (broker portal) */}
      <div className="mb-3 flex items-center gap-3 p-3 rounded-lg bg-primary-50 border border-primary-200">
        <Globe className="h-5 w-5 text-primary-500 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-primary-900">Web Portal</p>
          <p className="text-xs text-primary-700">This browser &middot; Active now</p>
        </div>
        <Badge hue="primary" size="sm" className="ml-auto">
          Current
        </Badge>
      </div>

      {/* Desktop devices from Supabase */}
      {loading ? (
        <p className="text-sm text-gray-500 py-2">Loading devices...</p>
      ) : error ? (
        <p className="text-sm text-red-500 py-2">{error}</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-gray-400 py-2 italic">No desktop sessions found.</p>
      ) : (
        <div className="space-y-2">
          {devices.map((device) => (
            <div
              key={device.device_id}
              className="flex items-center gap-3 p-3 rounded-lg bg-white border border-gray-200"
            >
              <Monitor className="h-5 w-5 text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {device.device_name || 'Unknown device'}
                </p>
                <p className="text-xs text-gray-500">
                  {device.os || device.platform || 'Unknown OS'} &middot;{' '}
                  {formatRelativeTime(device.last_seen_at)}
                </p>
              </div>
              <Badge hue="success" size="sm">
                Desktop
              </Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
