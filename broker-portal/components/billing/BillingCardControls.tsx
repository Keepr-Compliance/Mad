'use client';

/**
 * Update card, End plan now, Edit contact and the return from the card page —
 * BACKLOG-3848. Presentation only: every action re-checks on the server who
 * may do what (lib/actions/billingCard.ts, lib/actions/agentPlan.ts).
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { confirmCardUpdate, startCardUpdate, updateBillingContact, type CardActionResult } from '@/lib/actions/billingCard';
import { endAgentPlanNow, type AgentActionResult } from '@/lib/actions/agentPlan';

const PRIMARY =
  'rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60';
const SECONDARY =
  'rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60';
const DANGER =
  'rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-red-700 disabled:opacity-60';
const GENERIC_ERROR = 'Something went wrong. Please try again.';

type Result = CardActionResult | AgentActionResult;

function isRedirect(e: unknown): boolean {
  const d = (e as { digest?: unknown } | null)?.digest;
  return typeof d === 'string' && d.startsWith('NEXT_REDIRECT');
}

function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; link?: string } | null>(null);
  const run = async (fn: () => Promise<Result | undefined>, onOk?: () => void) => {
    setError(null);
    setNotice(null);
    setPending(true);
    try {
      const r = await fn();
      if (r && 'error' in r) setError(r.error);
      else {
        if (r && 'notice' in r && r.notice) setNotice({ text: r.notice, link: 'link' in r ? r.link : undefined });
        onOk?.();
      }
    } catch (e) {
      if (!isRedirect(e)) setError(GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, notice, run };
}

function Lines({ error, notice }: { error: string | null; notice: { text: string; link?: string } | null }) {
  return (
    <>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-2 text-sm text-gray-700">
          {notice.text}{' '}
          {notice.link ? (
            <a className="font-medium text-indigo-700 hover:underline" href={notice.link} target="_blank" rel="noreferrer">
              Open the invoice
            </a>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

export function UpdateCardButton({ primary = false }: { primary?: boolean }) {
  const { pending, error, notice, run } = useAction();
  return (
    <div>
      <button type="button" className={primary ? PRIMARY : SECONDARY} disabled={pending} onClick={() => void run(startCardUpdate)}>
        {pending ? 'Opening Stripe…' : 'Update card'}
      </button>
      <Lines error={error} notice={notice} />
    </div>
  );
}

/** End plan now + its confirm dialog (payment_failed only). */
export function EndPlanNowButton() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { pending, error, notice, run } = useAction();
  return (
    <div>
      <button type="button" className={SECONDARY} onClick={() => setOpen(true)}>
        End plan now
      </button>
      <Lines error={open ? null : error} notice={open ? null : notice} />
      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="agent-end-now-title" className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 id="agent-end-now-title" className="text-lg font-semibold text-gray-900">
              End your Agent plan now?
            </h2>
            <div className="mt-3 space-y-2 text-sm text-gray-700">
              <p>Your plan ends today. The unpaid renewal is cancelled and you won&apos;t be charged for it or again.</p>
              <p>Your saved credits stay. Each export uses one of them, or is bought in the Keepr app.</p>
            </div>
            <Lines error={error} notice={null} />
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" className={SECONDARY} disabled={pending} onClick={() => setOpen(false)}>
                Keep my plan
              </button>
              <button
                type="button"
                className={DANGER}
                disabled={pending}
                onClick={() =>
                  void run(endAgentPlanNow, () => {
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                {pending ? 'Ending…' : 'End plan now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Edit the billing contact in place. */
export function ContactEditor({ name, email }: { name: string | null; email: string | null }) {
  const [editing, setEditing] = useState(false);
  const [n, setN] = useState(name ?? '');
  const [e, setE] = useState(email ?? '');
  const router = useRouter();
  const { pending, error, run } = useAction();
  if (!editing) {
    return (
      <div className="mt-3">
        <button type="button" className={SECONDARY} onClick={() => setEditing(true)}>
          Edit contact
        </button>
      </div>
    );
  }
  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        void run(
          () => updateBillingContact({ name: n, email: e }),
          () => {
            setEditing(false);
            router.refresh();
          }
        );
      }}
    >
      <label className="block text-sm text-gray-700">
        Name
        <input className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900" value={n} maxLength={100} onChange={(x) => setN(x.target.value)} />
      </label>
      <label className="block text-sm text-gray-700">
        Email for receipts
        <input type="email" required className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900" value={e} maxLength={254} onChange={(x) => setE(x.target.value)} />
      </label>
      <Lines error={error} notice={null} />
      <div className="flex gap-3">
        <button type="submit" className={PRIMARY} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={SECONDARY} disabled={pending} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Back from the Stripe card page: apply the card once, then re-render the page. */
export function CardUpdateReturn({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const done = useRef(false);
  const [msg, setMsg] = useState<{ text: string; link?: string; error?: boolean }>({ text: 'Saving your new card…' });
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    confirmCardUpdate(sessionId)
      .then((r) => {
        if ('error' in r) setMsg({ text: r.error, error: true });
        else setMsg({ text: r.notice ?? 'Your card is updated.', link: r.link });
        router.refresh();
      })
      .catch(() => setMsg({ text: 'We could not confirm your new card yet. Refresh the page in a minute to see it.', error: true }));
  }, [sessionId, router]);
  return (
    <p role="status" data-card-return className={`rounded-lg px-4 py-3 text-sm ${msg.error ? 'bg-red-50 text-red-800' : 'bg-indigo-50 text-indigo-800'}`}>
      {msg.text}{' '}
      {msg.link ? (
        <a className="font-medium underline" href={msg.link} target="_blank" rel="noreferrer">
          Open the invoice
        </a>
      ) : null}
    </p>
  );
}
