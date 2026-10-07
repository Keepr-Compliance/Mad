/**
 * API route for sending ticket confirmation emails.
 *
 * Two callers, two contracts:
 * 1. Server callers with `x-api-secret` (the send-ticket-confirmation Edge
 *    Function and the admin portal's /api/support/notify proxy). They build
 *    the email fields server-side from the ticket row and send
 *    `{ ticketNumber, ticketSubject, requesterEmail, ticketLink }`.
 * 2. Signed-in broker portal users right after submitting a ticket. They send
 *    `{ ticketId }` only. The recipient, subject, number and link are read
 *    from the ticket row the caller can see (RLS), never from the body.
 *
 * BACKLOG-1565, BACKLOG-1567, BACKLOG-3712
 */

import * as Sentry from '@sentry/nextjs';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendTicketConfirmationEmail } from '@/lib/email';

/** A session caller may only trigger the confirmation for a just-created ticket. */
const SESSION_CONFIRMATION_WINDOW_MS = 15 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConfirmationFields {
  ticketNumber: string;
  ticketSubject: string;
  requesterEmail: string;
  ticketLink: string;
}

function formatTicketNumber(n: number): string {
  return `TKT-${String(n).padStart(4, '0')}`;
}

function brokerBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'https://app.keeprcompliance.com';
}

type Resolved = { fields: ConfirmationFields } | { response: NextResponse };

/** Session caller: derive every field from the ticket row visible to the caller. */
async function resolveFromSession(body: unknown): Promise<Resolved> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const ticketId = (body as { ticketId?: unknown } | null)?.ticketId;
  if (typeof ticketId !== 'string' || !UUID_RE.test(ticketId)) {
    return { response: NextResponse.json({ error: 'Missing required fields' }, { status: 400 }) };
  }

  // RLS on support_tickets limits a non-staff caller to their own tickets.
  const { data: ticket } = await supabase
    .from('support_tickets')
    .select('id, ticket_number, subject, requester_email, created_at')
    .eq('id', ticketId)
    .maybeSingle();

  if (!ticket || !ticket.requester_email || !ticket.subject) {
    return { response: NextResponse.json({ error: 'Ticket not found' }, { status: 404 }) };
  }

  const createdAt = Date.parse(ticket.created_at);
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > SESSION_CONFIRMATION_WINDOW_MS) {
    return {
      response: NextResponse.json({ error: 'Confirmation window has passed' }, { status: 409 }),
    };
  }

  return {
    fields: {
      ticketNumber: formatTicketNumber(ticket.ticket_number),
      ticketSubject: ticket.subject,
      requesterEmail: ticket.requester_email,
      ticketLink: `${brokerBaseUrl()}/support/${ticket.id}`,
    },
  };
}

/** Secret caller: trusted server that already derived the fields from the row. */
function resolveFromSecretCaller(body: unknown): Resolved {
  const b = (body ?? {}) as Partial<Record<keyof ConfirmationFields, unknown>>;
  const { ticketNumber, ticketSubject, requesterEmail, ticketLink } = b;
  if (
    typeof ticketNumber !== 'string' || !ticketNumber ||
    typeof ticketSubject !== 'string' || !ticketSubject ||
    typeof requesterEmail !== 'string' || !requesterEmail ||
    typeof ticketLink !== 'string' || !ticketLink
  ) {
    return { response: NextResponse.json({ error: 'Missing required fields' }, { status: 400 }) };
  }
  return { fields: { ticketNumber, ticketSubject, requesterEmail, ticketLink } };
}

export async function POST(request: NextRequest) {
  try {
    const apiSecret = request.headers.get('x-api-secret');
    const hasValidApiSecret =
      !!process.env.INTERNAL_API_SECRET && apiSecret === process.env.INTERNAL_API_SECRET;

    const body = await request.json().catch(() => null);

    const resolved = hasValidApiSecret
      ? resolveFromSecretCaller(body)
      : await resolveFromSession(body);
    if ('response' in resolved) return resolved.response;

    const { ticketNumber, ticketSubject, requesterEmail, ticketLink } = resolved.fields;

    Sentry.addBreadcrumb({
      category: 'email.route',
      message: 'Processing ticket-confirmation request',
      level: 'info',
      data: { ticketNumber, caller: hasValidApiSecret ? 'server' : 'session' },
    });

    const result = await sendTicketConfirmationEmail({
      recipientEmail: requesterEmail,
      ticketSubject,
      ticketNumber,
      ticketLink,
    });

    if (!result.success) {
      Sentry.captureMessage(`Ticket confirmation email failed for ${ticketNumber}`, {
        level: 'warning',
        extra: { error: result.error, ticketNumber },
      });
    }

    return NextResponse.json({ success: result.success, error: result.error });
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'email/ticket-confirmation' } });
    console.error('[TicketConfirmation] Error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
