/**
 * Consent page for connecting an AI app — BACKLOG-4238.
 *
 * /oauth/authorize sends the browser here with the request id in the path and
 * the binding cookie set. One mcp_authorize_view call per render returns what
 * is shown and this render's nonce; the buttons send both back.
 */

import { notFound, redirect } from 'next/navigation';
// PageHeader / Card are Tier-2 (no @keepr/ui equivalent yet).
import { Card, CardContent, PageHeader } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/server';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';
import { mcpEnabled } from '@/lib/mcp/config';
import { oauthConfig } from '@/lib/mcp/oauth/config';
import { bindingDigest } from '@/lib/mcp/oauth/crypto';
import { isRequestId } from '@/lib/mcp/oauth/validate';
import { CONSENT, M_C, PROVIDER_LABELS } from '@/lib/mcp/account/messages';
import { logAccount } from '@/lib/mcp/account/logging';
import { readAccountRequest } from '@/lib/mcp/account/request';
import { viewRequest } from '@/lib/mcp/account/rpc';
import { ReplayOff } from '@/components/sentry/ReplayOff';
import { ConsentForm } from './ConsentForm';

export const dynamic = 'force-dynamic';

const NOTICE_VERSION = 1;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <ReplayOff />
      <PageHeader phoneHideTitle title={PAGE_TITLES.connectAiApp} />
      <Card>
        <CardContent className="space-y-3 text-sm text-gray-800">{children}</CardContent>
      </Card>
    </div>
  );
}

function Notice({ message }: { message: string }) {
  return (
    <Shell>
      <p role="alert">{message}</p>
    </Shell>
  );
}

export default async function ConnectAiAppPage({ params }: { params: Promise<{ requestId: string }> }) {
  if (!mcpEnabled()) notFound();
  const started = Date.now();

  const { requestId } = await params;
  if (!isRequestId(requestId)) return <Notice message={M_C.badId} />;

  const req = await readAccountRequest();
  if (req.impersonating) return <Notice message={M_C.supportSession} />;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const email = typeof user.email === 'string' && user.email.length > 0 ? user.email : null;

  if (oauthConfig().state !== 'ok') return <Notice message={M_C.misconfigured} />;
  if (req.binding === null) return <Notice message={M_C.noBinding} />;

  const view = await viewRequest(requestId, bindingDigest(req.binding));
  if (view.kind === 'transport') {
    logAccount('consent', 'view_transport', 503, started, view);
    return <Notice message={M_C.failed} />;
  }
  if (view.kind === 'refused') {
    logAccount('consent', `view_${view.error}`, 200, started);
    switch (view.error) {
      case 'not_signed_in':
        return redirect('/login');
      case 'impersonating':
        return <Notice message={M_C.supportSession} />;
      case 'disabled':
        return <Notice message={M_C.disabled} />;
      case 'request_invalid':
        return <Notice message={M_C.requestInvalid} />;
    }
  }
  if (view.noticeVersion !== NOTICE_VERSION) return <Notice message={M_C.noticeVersion} />;
  if (email === null) return <Notice message={M_C.failed} />;

  const provider = PROVIDER_LABELS[view.provider];
  return (
    <Shell>
      <p className="text-base font-semibold text-gray-900">
        {view.canChangeTodos ? CONSENT.write.lead(provider) : CONSENT.lead(provider)}
      </p>
      <p data-testid="consent-name-host">
        {CONSENT.nameLabel}
        &ldquo;<bdi>{view.clientName}</bdi>&rdquo;{CONSENT.nameHost(view.redirectHost)}
      </p>
      {view.replacesExisting && (
        <p role="note" className="font-semibold text-gray-900">
          {CONSENT.replaces(provider)}
        </p>
      )}
      <p>{CONSENT.onlyIf(provider)}</p>
      {view.ageSeconds !== undefined && <p className="text-gray-600">{CONSENT.startedAgo(view.ageSeconds)}</p>}
      <p>{view.canChangeTodos ? CONSENT.write.scope : CONSENT.scope}</p>
      {view.canChangeTodos && <p>{CONSENT.write.changes}</p>}
      <p>{CONSENT.agreement(provider)}</p>
      <p>{CONSENT.disconnect}</p>
      <p>{CONSENT.whatDisconnects}</p>
      <p className="pt-2 text-gray-600">{CONSENT.signedInAs(email)}</p>
      <ConsentForm requestId={requestId} nonce={view.nonce} />
    </Shell>
  );
}
