/**
 * AI apps — BACKLOG-4238. The AI apps this person allowed, with Disconnect and
 * Disconnect all. Exists only while MCP is on.
 *
 * BACKLOG-4263 P11: each row says whether that connection may read the emails and texts attached to the person's
 * deals (mcp_list_my_connection_access; before migration 20261123150000 the labels stay as they were), and the page
 * lists the emails and texts AI apps read (mcp_list_my_message_reads), also when no app is connected.
 */

import { notFound, redirect } from 'next/navigation';
// PageHeader / Card are Tier-2 (no @keepr/ui equivalent yet).
import { Card, CardContent, PageHeader } from '@keepr/design-system';
import { createClient } from '@/lib/supabase/server';
import { PAGE_TITLES } from '@/lib/dashboard-page-titles';
import { mcpEnabled } from '@/lib/mcp/config';
import { AI_APPS, CONSENT, M_A, PROVIDER_LABELS } from '@/lib/mcp/account/messages';
import { readLines } from '@/lib/mcp/account/readLines';
import { logAccount } from '@/lib/mcp/account/logging';
import { readAccountRequest } from '@/lib/mcp/account/request';
import { listMyConnectionAccess, listMyConnections, listMyMessageReads } from '@/lib/mcp/account/rpc';
import { formatDate, formatDateTime } from '@/lib/mcp/account/format';
import { ReplayOff } from '@/components/sentry/ReplayOff';
import { AiAppsList, type AiAppRow } from './AiAppsList';
import { AiReads } from './AiReads';

export const dynamic = 'force-dynamic';

function Shell({ email, children }: { email: string | null; children: React.ReactNode }) {
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <ReplayOff />
      <PageHeader phoneHideTitle title={PAGE_TITLES.aiApps} subtitle={AI_APPS.intro} />
      {email !== null && <p className="text-sm text-gray-600">{CONSENT.signedInAs(email)}</p>}
      <Card>
        <CardContent className="space-y-4 text-sm text-gray-800">{children}</CardContent>
      </Card>
    </div>
  );
}

export default async function AiAppsPage({ searchParams }: { searchParams: Promise<{ reads?: string | string[] }> }) {
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
  const sp = (await searchParams) ?? {};
  const cursor = typeof sp.reads === 'string' ? sp.reads : null;
  const [access, reads] = await Promise.all([
    list.connections.length > 0 ? listMyConnectionAccess() : Promise.resolve(null),
    listMyMessageReads(cursor),
  ]);
  if (access !== null && access.kind === 'unknown' && access.reason !== 'missing') {
    logAccount('ai-apps', `access_${access.reason}`, 200, started);
  }
  if (reads.kind !== 'ok') {
    if (reads.kind === 'refused') logAccount('ai-apps', `reads_${reads.error}`, 200, started);
    else logAccount('ai-apps', 'reads_transport', 503, started, reads);
  }
  const readsBlock = (
    <AiReads
      lines={reads.kind === 'ok' ? readLines(reads.reads) : null}
      nextCursor={reads.kind === 'ok' ? reads.nextCursor : null}
    />
  );

  if (list.connections.length === 0) {
    return (
      <Shell email={email}>
        <p>{M_A.empty}</p>
        {readsBlock}
      </Shell>
    );
  }

  const rows: AiAppRow[] = list.connections.map((c) => {
    // the message permission of this connection, when the database says (after 20261123150000)
    const messages = access !== null && access.kind === 'ok' ? access.messages.get(c.id) : undefined;
    const allowed =
      c.canChangeTodos === null
        ? null
        : messages === true
          ? c.canChangeTodos
            ? AI_APPS.allowedTodosMessages
            : AI_APPS.allowedReadMessages
          : c.canChangeTodos
            ? AI_APPS.allowedTodos
            : AI_APPS.allowedRead;
    return {
      id: c.id,
      providerLabel: PROVIDER_LABELS[c.provider],
      clientName: c.clientName,
      sendsBackTo: AI_APPS.sendsBackTo(c.redirectHost),
      connected: AI_APPS.connected(formatDateTime(c.consentedAt)),
      lastUsed: c.lastUsedAt === null ? AI_APPS.notUsed : AI_APPS.lastUsed(formatDate(c.lastUsedAt)),
      allowed,
      hint: messages === false ? AI_APPS.noMessages : null,
    };
  });
  return (
    <Shell email={email}>
      <p className="text-sm text-gray-600">{AI_APPS.disconnectHere}</p>
      <AiAppsList rows={rows} />
      {readsBlock}
    </Shell>
  );
}
