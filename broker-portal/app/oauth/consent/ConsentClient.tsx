'use client';

/**
 * Consent screen for connecting an AI app — BACKLOG-4237.
 *
 * Navigation after a decision is done in script (window.location.assign),
 * not by a form post: the portal CSP sets form-action 'self'.
 */

import { useEffect, useState } from 'react';
import { decideConsent } from './actions';
import type { ConsentDecision } from '@/lib/mcp/consent';

export type ConsentClientProps =
  | { mode: 'consent'; authorizationId: string; clientName: string; redirectHost: string }
  | { mode: 'redirect'; url: string };

export function navigateTo(url: string): void {
  window.location.assign(url);
}

export default function ConsentClient(props: ConsentClientProps) {
  const [busy, setBusy] = useState<ConsentDecision | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (props.mode === 'redirect') navigateTo(props.url);
  }, [props]);

  if (props.mode === 'redirect') {
    return <p className="text-sm text-gray-600">Returning you to the app…</p>;
  }

  const { authorizationId, clientName, redirectHost } = props;

  async function onDecide(decision: ConsentDecision) {
    setBusy(decision);
    setFailed(false);
    const result = await decideConsent(authorizationId, decision);
    if (result.ok) {
      navigateTo(result.url);
      return;
    }
    setBusy(null);
    setFailed(true);
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 space-y-4">
      <h1 className="text-xl font-semibold text-gray-900">Connect an AI app to Keepr</h1>
      <dl className="text-sm space-y-2">
        <div>
          <dt className="text-gray-500">App name (as registered by the app)</dt>
          <dd className="text-gray-900 font-medium break-words" data-testid="consent-client-name">
            {clientName || 'Unnamed app'}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Returns you to</dt>
          <dd className="text-gray-900 font-medium" data-testid="consent-redirect-host">
            {redirectHost}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-gray-700" data-testid="consent-disclosure">
        Draft: this test connection lets the app check that it is connected to your Keepr account. It
        reads no transactions, messages or contacts. Anything an app receives is handled by that app&apos;s
        company under your agreement with it.
      </p>
      {failed && (
        <p role="alert" className="text-sm text-red-700">
          That did not work. Start the connection again from the app.
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => onDecide('approve')}
          disabled={busy !== null}
          className="flex-1 px-4 py-2 rounded-lg bg-primary-600 text-white font-medium hover:bg-primary-700 disabled:opacity-50"
        >
          {busy === 'approve' ? 'Connecting…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => onDecide('deny')}
          disabled={busy !== null}
          className="flex-1 px-4 py-2 rounded-lg border border-gray-300 text-gray-700 font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          {busy === 'deny' ? 'Cancelling…' : 'Deny'}
        </button>
      </div>
    </div>
  );
}
