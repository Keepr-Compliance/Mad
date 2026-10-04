/**
 * Server-side proxy for support ticket email notifications.
 *
 * Called by the admin portal's support pages (lib/support-queries.ts) after a
 * staff action. Forwards to the broker portal's email API with the shared
 * secret, which stays server-side.
 *
 * Only support staff may call it (`support.view`, the permission the
 * /dashboard/support pages require). The outgoing email is built here from
 * the ticket row: recipient, subject, ticket number and link are never taken
 * from the request body. The body supplies only the ticket id, the type, and
 * staff-written text (reply preview, resolution summary).
 *
 * TASK-2199, BACKLOG-1574, BACKLOG-3703
 */

import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/supabase/server';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLY_PREVIEW_MAX = 203; // 200 chars + '...', as built by the client
const RESOLUTION_SUMMARY_MAX = 300;

const TARGET_PATHS = {
  confirmation: '/api/email/ticket-confirmation',
  reply: '/api/email/ticket-notification',
  assignment: '/api/email/ticket-notification',
  ticket_resolved: '/api/email/ticket-resolved',
} as const;

type NotifyType = keyof typeof TARGET_PATHS;

interface TicketRow {
  id: string;
  ticket_number: number;
  subject: string;
  status: string;
  priority: string;
  requester_email: string | null;
  requester_name: string | null;
  assignee_id: string | null;
}

type SupabaseClient = Awaited<ReturnType<typeof getAuthenticatedUser>>['supabase'];

function formatTicketNumber(n: number): string {
  return `TKT-${String(n).padStart(4, '0')}`;
}

function brokerPortalPublicUrl(): string {
  // Same base the support pages used for these links before BACKLOG-3703.
  return process.env.NEXT_PUBLIC_BROKER_PORTAL_URL || 'https://app.keeprcompliance.com';
}

function optionalText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined;
}

function skipped(reason: string, status = 409) {
  return NextResponse.json({ success: false, skipped: true, reason }, { status });
}

async function findAgentEmail(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await supabase.rpc('support_list_agents');
  const agents = Array.isArray(data) ? (data as Array<{ user_id: string; email: string | null }>) : [];
  return agents.find((a) => a.user_id === userId)?.email ?? null;
}

/** Builds the broker-portal request body from the ticket row. */
async function buildOutgoing(
  type: NotifyType,
  ticket: TicketRow,
  body: Record<string, unknown>,
  ctx: { supabase: SupabaseClient; agentName: string; adminOrigin: string }
): Promise<Record<string, unknown> | NextResponse> {
  const ticketNumber = formatTicketNumber(ticket.ticket_number);
  const base = { ticketId: ticket.id, ticketNumber, ticketSubject: ticket.subject };

  if (type === 'assignment') {
    if (!ticket.assignee_id) return skipped('ticket has no assignee');
    const agentEmail = await findAgentEmail(ctx.supabase, ticket.assignee_id);
    if (!agentEmail) return skipped('assignee is not a support agent');
    return {
      type: 'assignment',
      ...base,
      agentEmail,
      customerName: ticket.requester_name ?? '',
      priority: ticket.priority,
      ticketUrl: `${ctx.adminOrigin}/support/${ticket.id}`,
    };
  }

  if (!ticket.requester_email) return skipped('ticket has no requester email');
  const broker = brokerPortalPublicUrl();

  if (type === 'confirmation') {
    return {
      ticketNumber,
      ticketSubject: ticket.subject,
      requesterEmail: ticket.requester_email,
      ticketLink: `${broker}/dashboard/support/${ticket.id}`,
    };
  }

  if (type === 'reply') {
    return {
      type: 'reply',
      ...base,
      customerEmail: ticket.requester_email,
      agentName: ctx.agentName,
      replyPreview: optionalText(body.replyPreview, REPLY_PREVIEW_MAX) ?? '',
      ticketUrl: `${broker}/dashboard/support/${ticket.id}`,
    };
  }

  // ticket_resolved: the stored status decides, not the body.
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    return skipped('ticket is not resolved or closed');
  }
  return {
    ...base,
    customerEmail: ticket.requester_email,
    resolutionSummary: optionalText(body.resolutionSummary, RESOLUTION_SUMMARY_MAX),
    ticketUrl: `${broker}/support/${ticket.id}`,
    newStatus: ticket.status,
  };
}

export async function POST(request: NextRequest) {
  try {
    // ── 1. Staff only ─────────────────────────────────────────────────
    const { supabase, user } = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { data: hasPerm } = await supabase.rpc('has_permission', {
      check_user_id: user.id,
      required_permission: 'support.view',
    });
    if (hasPerm !== true) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    // ── 2. Validate the request ───────────────────────────────────────
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const type = body?.type;
    if (!body || typeof type !== 'string' || !(type in TARGET_PATHS)) {
      return NextResponse.json({ error: 'Invalid notification type' }, { status: 400 });
    }
    const ticketId = body.ticketId;
    if (typeof ticketId !== 'string' || !UUID_RE.test(ticketId)) {
      return NextResponse.json({ error: 'Missing ticketId' }, { status: 400 });
    }

    const brokerPortalUrl = process.env.BROKER_PORTAL_URL;
    const apiSecret = process.env.INTERNAL_API_SECRET;
    if (!brokerPortalUrl || !apiSecret) {
      console.warn(
        '[Support] Email notification skipped: missing env vars —',
        `BROKER_PORTAL_URL=${brokerPortalUrl ? 'set' : 'MISSING'}`,
        `INTERNAL_API_SECRET=${apiSecret ? 'set' : 'MISSING'}`
      );
      return NextResponse.json({ success: false, skipped: true });
    }

    // ── 3. Load the ticket with the staff session ─────────────────────
    const { data: ticket } = await supabase
      .from('support_tickets')
      .select('id, ticket_number, subject, status, priority, requester_email, requester_name, assignee_id')
      .eq('id', ticketId)
      .maybeSingle();
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const agentName =
      (typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name) ||
      'Support Team';

    const outgoing = await buildOutgoing(type as NotifyType, ticket as TicketRow, body, {
      supabase,
      agentName,
      adminOrigin: request.nextUrl.origin,
    });
    if (outgoing instanceof NextResponse) return outgoing;

    // ── 4. Forward ────────────────────────────────────────────────────
    const targetUrl = `${brokerPortalUrl}${TARGET_PATHS[type as NotifyType]}`;
    const ticketNumber = formatTicketNumber((ticket as TicketRow).ticket_number);

    Sentry.addBreadcrumb({
      category: 'email.proxy',
      message: `Proxying ${type} notification to broker portal`,
      level: 'info',
      data: { type, ticketNumber, targetUrl },
    });

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-secret': apiSecret,
      },
      body: JSON.stringify(outgoing),
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      Sentry.captureMessage('Broker portal notification failed', {
        level: 'warning',
        extra: { status: response.status, result, type, ticketNumber },
      });
    }

    return NextResponse.json(result, { status: response.status });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'support/notify' } });
    console.error('[Support] Notification proxy error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
