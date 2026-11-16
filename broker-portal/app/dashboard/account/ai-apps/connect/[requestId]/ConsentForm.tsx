'use client';

/**
 * Allow / Deny on the consent page — BACKLOG-4238.
 *
 * Plain buttons, no form submission: they are disabled until the page is
 * mounted, then call the server actions with the request id and the nonce of
 * the current render (read from props at click time, never kept in state).
 * The browser leaves only from the awaited result, and only to an https
 * address.
 */

import { useEffect, useState } from 'react';
import { Button } from '@keepr/ui';
import { approveAiApp, denyAiApp, type ConsentActionResult } from '@/lib/mcp/account/actions';
import { CONSENT, M_C } from '@/lib/mcp/account/messages';
import { leaveTo } from '@/lib/mcp/account/navigate';

interface ConsentFormProps {
  requestId: string;
  nonce: string;
}

type Pending = 'approve' | 'deny' | null;

export function ConsentForm({ requestId, nonce }: ConsentFormProps) {
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setMounted(true), []);

  async function choose(which: 'approve' | 'deny') {
    setPending(which);
    setMessage(null);
    let result: ConsentActionResult;
    try {
      result = which === 'approve' ? await approveAiApp(requestId, nonce) : await denyAiApp(requestId, nonce);
    } catch {
      result = { kind: 'refused', message: M_C.failed };
    }
    if (result.kind === 'redirect') {
      if (result.location.startsWith('https://')) {
        leaveTo(result.location);
        return;
      }
      result = { kind: 'refused', message: M_C.noReturn };
    }
    setMessage(result.message);
    setPending(null);
  }

  const disabled = !mounted || pending !== null;
  return (
    <div className="space-y-3 pt-2">
      {message && (
        <p role="alert" className="text-red-700">
          {message}
        </p>
      )}
      <div className="flex gap-3">
        <Button type="button" disabled={disabled} onClick={() => void choose('approve')}>
          {pending === 'approve' ? CONSENT.allowing : CONSENT.allow}
        </Button>
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => void choose('deny')}>
          {pending === 'deny' ? CONSENT.denying : CONSENT.deny}
        </Button>
      </div>
    </div>
  );
}
