'use client';

/**
 * The Agent plan's buttons — BACKLOG-3847. Presentation only: every action
 * re-checks on the server who may do what (lib/actions/agentPlan.ts).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  confirmAgentCheckout,
  endAgentPlanAtPeriodEnd,
  keepAgentPlan,
  startAgentCheckout,
  type AgentActionResult,
} from '@/lib/actions/agentPlan';

const PRIMARY =
  'rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60';
const SECONDARY =
  'rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60';
const GENERIC_ERROR = 'Something went wrong. Please try again.';

/** redirect() inside a server action surfaces as a digest error; it is not a failure. */
function isRedirect(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === 'string' && d.startsWith('NEXT_REDIRECT');
}

function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<AgentActionResult | undefined>, onOk?: () => void) => {
    setError(null);
    setPending(true);
    try {
      const r = await fn();
      if (r && 'error' in r) setError(r.error);
      else onOk?.();
    } catch (e) {
      if (!isRedirect(e)) setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-2 text-sm text-red-700">
      {error}
    </p>
  ) : null;
}

export function SubscribeButton({ label, interval = 'month' }: { label: string; interval?: 'month' | 'year' }) {
  const { pending, error, run } = useAction();
  return (
    <div>
      <button type="button" className={PRIMARY} disabled={pending} onClick={() => void run(() => startAgentCheckout(interval))}>
        {pending ? 'Opening Stripe…' : label}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

export function KeepPlanButton() {
  const { pending, error, run } = useAction();
  return (
    <div>
      <button type="button" className={PRIMARY} disabled={pending} onClick={() => void run(keepAgentPlan)}>
        {pending ? 'Keeping your plan…' : 'Keep my plan'}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

/** Cancel plan + the confirm dialog (mockup v14). */
export function CancelPlanButton({ paidThrough }: { paidThrough: string }) {
  const [open, setOpen] = useState(false);
  const { pending, error, run } = useAction();
  return (
    <div>
      <button type="button" className={SECONDARY} onClick={() => setOpen(true)}>
        Cancel plan
      </button>
      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="agent-cancel-title" className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 id="agent-cancel-title" className="text-lg font-semibold text-gray-900">
              Cancel your Agent plan?
            </h2>
            <div className="mt-3 space-y-2 text-sm text-gray-700">
              <p>
                You&apos;ve paid through <strong>{paidThrough}</strong>. Exports stay unlimited until then, and you
                won&apos;t be charged again.
              </p>
              <p>After that, each export uses one of your saved credits, or is bought in the Keepr app.</p>
              <p className="text-gray-500">No partial refund for the rest of the period.</p>
            </div>
            <ErrorLine error={error} />
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" className={SECONDARY} disabled={pending} onClick={() => setOpen(false)}>
                Keep my plan
              </button>
              <button
                type="button"
                className={PRIMARY}
                disabled={pending}
                onClick={() => void run(endAgentPlanAtPeriodEnd, () => setOpen(false))}
              >
                {pending ? 'Cancelling…' : 'Cancel at end of period'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Back from Checkout: record the subscription once, then re-render the page. */
export function CheckoutReturn({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const done = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    confirmAgentCheckout(sessionId)
      .then((r) => {
        if ('error' in r) setFailed(true);
        router.refresh();
      })
      .catch(() => setFailed(true));
  }, [sessionId, router]);
  return (
    <p role="status" className="mt-3 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-800">
      {failed
        ? 'Your payment is being confirmed. This can take a minute; refresh the page to see your plan.'
        : 'Finishing your subscription…'}
    </p>
  );
}
