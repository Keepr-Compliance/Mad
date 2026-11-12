/**
 * AI apps — BACKLOG-4238. The AI apps this person allowed, with Disconnect and
 * Disconnect all. Exists only while MCP is on.
 */

import { notFound, redirect } from 'next/navigation';
// PageHeader / Card are Tier-2 (no @keepr/ui equivalent yet).
import { Card, CardContent, PageHeader } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/server';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';
import { mcpEnabled } from '@/lib/mcp/config';
import { AI_APPS, CONSENT, M_A, PROVIDER_LABELS } from '@/lib/mcp/account/messages';
import { logAccount } from '@/lib/mcp/account/logging';
import { readAccountRequest } from '@/lib/mcp/account/request';
import { listMyConnections } from '@/lib/mcp/account/rpc';
import { AiAppsList, type AiAppRow } from './AiAppsList';

export const dynamic = 'force-dynamic';

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

function formatDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso));
}

function Shell({ email, children }: { email: string | null; children: React.ReactNode }) {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <PageHeader phoneHideTitle title={PAGE_TITLES.aiApps} subtitle={AI_APPS.intro} />
      {email !== null && <p className="text-sm text-gray-600">{CONSENT.signedInAs(email)}</p>}
      <Card>
        <CardContent className="space-y-4 text-sm text-gray-800">{children}</CardContent>
      </Card>
    </div>
  );
}

export default async function AiAppsPage() {
  if (!mcpEnabled()) notFound();
  const started = Date.now();

  const req = await readAccountRequest();
  if (req.impersonating) {
    return (
      <Shell email={null}>
        <p role="alert">{M_A.supportSession}</p>
      </Shell>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  const email = typeof user.email === 'string' && user.email.length > 0 ? user.email : null;

  const list = await listMyConnections();
  if (list.kind === 'refused') {
    logAccount('ai-apps', `list_${list.error}`, 200, started);
    redirect('/login');
  }
  if (list.kind === 'transport') {
    logAccount('ai-apps', 'list_transport', 503, started, list);
    return (
      <Shell email={email}>
        <p role="alert">{M_A.loadFailed}</p>
      </Shell>
    );
  }
  if (list.connections.length === 0) {
    return (
      <Shell email={email}>
        <p>{M_A.empty}</p>
      </Shell>
    );
  }

  const rows: AiAppRow[] = list.connections.map((c) => ({
    id: c.id,
    providerLabel: PROVIDER_LABELS[c.provider],
    clientName: c.clientName,
    sendsBackTo: AI_APPS.sendsBackTo(c.redirectHost),
    connected: AI_APPS.connected(formatDate(c.consentedAt)),
    lastUsed: c.lastUsedAt === null ? AI_APPS.notUsed : AI_APPS.lastUsed(formatDate(c.lastUsedAt)),
  }));
  return (
    <Shell email={email}>
      <AiAppsList rows={rows} />
    </Shell>
  );
}
