'use client';

/**
 * Setup guide UI — BACKLOG-4007 PR-3. The page (app/dashboard/setup/page.tsx) picks the step.
 * Copy rule (founder): banners at most 4 short sentences.
 */

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Card, PageHeader } from '@keepr/design-system';
import type { BillingSetupView } from '@/lib/billing/setupState';
import type { SetupStep } from '@/lib/billing/setupSteps';
import { formatDateOnly } from '@/lib/billing/setupCopy';
import { BillingStep } from './BillingStep';
import { billingLoginErrorMessage } from '@/lib/billing/billingLoginErrors';

const STEPS: Array<{ key: SetupStep; label: string }> = [
  { key: 'billing', label: 'Billing' },
  { key: 'microsoft', label: 'Connect Microsoft' },
  { key: 'done', label: 'Done' },
];

export interface SetupGuideProps {
  step: SetupStep;
  organizationId: string;
  brokerageName: string | null;
  view: BillingSetupView;
  isGoogleSignIn: boolean;
  role: string;
  /** BACKLOG-4007 PR-4: the billing-only login's outcome from the Billing step ('sent', 'created' or a refusal code). */
  billingLogin?: string | null;
}

function StepList({ step }: { step: SetupStep }) {
  const at = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="flex flex-wrap gap-4 text-sm" aria-label="Setup steps">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          aria-current={s.key === step ? 'step' : undefined}
          className={s.key === step ? 'font-semibold text-gray-900' : i < at ? 'text-gray-500' : 'text-gray-400'}
        >
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}

function ConnectMicrosoftStep() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    setBusy(true);
    setError(null);
    const { createClient } = await import('@/lib/supabase/client');
    const { error: authError } = await createClient().auth.signInWithOAuth({
      provider: 'azure',
      options: {
        redirectTo: `${window.location.origin}/auth/setup/callback`,
        queryParams: { prompt: 'consent' },
        scopes: 'email profile openid',
      },
    });
    if (authError) {
      setError(authError.message);
      setBusy(false);
    }
  };
  return (
    <Card>
      <h2 className="text-lg font-semibold text-gray-900">Connect your Microsoft organization</h2>
      <p className="mt-2 text-sm text-gray-600">
        This lets your agents sign in with their work accounts. You can also do it later in Settings.
      </p>
      {error ? (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        <Button onClick={connect} disabled={busy}>
          {busy ? 'Opening Microsoft…' : 'Connect Microsoft'}
        </Button>
        <Link href="/dashboard/setup?step=done" className="inline-flex items-center px-3 text-sm text-gray-600 hover:text-gray-900">
          Skip for now
        </Link>
      </div>
    </Card>
  );
}

/** BACKLOG-4007 PR-4: one line about the billing-only login, or null. Exported for the tests. */
export function billingLoginNote(outcome: string | null | undefined): { tone: 'info' | 'warning'; text: string } | null {
  if (!outcome) return null;
  if (outcome === 'sent') return { tone: 'info', text: 'We emailed the billing contact an invitation to their billing-only login.' };
  if (outcome === 'created') {
    return { tone: 'warning', text: 'The billing-only login was created, but its invitation email did not send. Resend it from the Users page.' };
  }
  // Founder F6 (REFUSE): this sentence is shown exactly as written.
  if (outcome === 'has_personal_account') return { tone: 'warning', text: billingLoginErrorMessage(outcome) };
  return { tone: 'warning', text: `${billingLoginErrorMessage(outcome)} The billing-only login was not created.` };
}

function DoneStep({ view, isGoogleSignIn, role, billingLogin }: Pick<SetupGuideProps, 'view' | 'isGoogleSignIn' | 'role' | 'billingLogin'>) {
  const note = billingLoginNote(billingLogin);
  return (
    <Card>
      <h2 className="text-lg font-semibold text-gray-900">Setup is complete</h2>
      <p className="mt-2 text-sm text-gray-600">
        Billing starts {formatDateOnly(view.billing_starts_on)}. Invoices go to the billing contact by email. You can now
        invite your team.
      </p>
      {isGoogleSignIn && role === 'admin' ? (
        <p className="mt-2 text-sm text-gray-600">To connect Microsoft later, sign in with a Microsoft work account.</p>
      ) : null}
      {note ? (
        <Alert variant={note.tone} className="mt-4">
          {note.text}
        </Alert>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/dashboard/users" className="inline-flex items-center rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700">
          Invite your team
        </Link>
        <Link href="/dashboard" className="inline-flex items-center px-3 text-sm text-gray-600 hover:text-gray-900">
          Go to dashboard
        </Link>
      </div>
    </Card>
  );
}

/** No deal on record (or it could not be read): nothing for the broker to do here. */
export function NothingToSetUp() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Account setup" />
      <Card>
        <p className="text-sm text-gray-600">There is nothing to set up right now.</p>
        <div className="mt-4">
          <Link href="/dashboard" className="text-sm text-primary-600 hover:text-primary-700">
            Go to dashboard
          </Link>
        </div>
      </Card>
    </div>
  );
}

export function SetupGuide(props: SetupGuideProps) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Finish setting up Keepr"
        subtitle={props.brokerageName ? `For ${props.brokerageName}` : undefined}
      />
      <StepList step={props.step} />
      {props.step === 'billing' ? (
        <BillingStep organizationId={props.organizationId} view={props.view} />
      ) : props.step === 'microsoft' ? (
        <ConnectMicrosoftStep />
      ) : (
        <DoneStep view={props.view} isGoogleSignIn={props.isGoogleSignIn} role={props.role} billingLogin={props.billingLogin} />
      )}
    </div>
  );
}
