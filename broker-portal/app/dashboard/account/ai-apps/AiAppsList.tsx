'use client';

/**
 * The AI apps list with Disconnect per row and Disconnect all — BACKLOG-4238.
 * Every value shown was checked and formatted on the server; the app's own
 * name is shown as text inside <bdi>, after the provider and the return host.
 */

import { useState } from 'react';
import { Button } from '@keepr/ui';
import { disconnectAiApp, disconnectAllAiApps } from '@/lib/mcp/account/actions';
import { AI_APPS, M_A } from '@/lib/mcp/account/messages';

export interface AiAppRow {
  id: string;
  providerLabel: string;
  clientName: string;
  sendsBackTo: string;
  connected: string;
  lastUsed: string;
}

export function AiAppsList({ rows }: { rows: AiAppRow[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    setBusy(key);
    setMessage(null);
    try {
      const r = await action();
      if (!r.ok) setMessage(r.message);
    } catch {
      setMessage(M_A.disconnectFailed);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {message && (
        <p role="alert" className="text-red-700">
          {message}
        </p>
      )}
      <ul className="divide-y divide-gray-100">
        {rows.map((row) => (
          <li key={row.id} data-testid="ai-app-row" className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0 space-y-1">
              <p className="font-semibold text-gray-900">{row.providerLabel}</p>
              <p>{row.sendsBackTo}</p>
              <p>
                {AI_APPS.nameLabel}
                <bdi>{row.clientName}</bdi>
              </p>
              <p className="text-gray-600">{row.connected}</p>
              <p className="text-gray-600">{row.lastUsed}</p>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void run(row.id, () => disconnectAiApp(row.id))}
            >
              {AI_APPS.disconnect}
            </Button>
          </li>
        ))}
      </ul>
      <div className="pt-2 border-t border-gray-200">
        <Button
          type="button"
          variant="destructive"
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm(AI_APPS.confirmAll)) void run('all', () => disconnectAllAiApps());
          }}
        >
          {AI_APPS.disconnectAll}
        </Button>
      </div>
    </div>
  );
}
