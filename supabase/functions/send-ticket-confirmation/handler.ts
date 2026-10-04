/**
 * Request handler for the send-ticket-confirmation Edge Function.
 *
 * Pure TypeScript with no Deno-specific imports, so it can be unit tested
 * with Jest. `index.ts` wires it to `Deno.serve` with the real environment
 * and `fetch`.
 *
 * Caller: the `support_ticket_confirmation_webhook` trigger on
 * `support_tickets` INSERT (see migration
 * 20261004120000_backlog_3711_ticket_webhook_secret.sql). The trigger sends
 * the `x-webhook-secret` header. Every request without the matching value is
 * rejected with 401. The ticket is re-read from the database by id; the
 * payload's email/subject are not used.
 *
 * BACKLOG-1573, BACKLOG-3711
 */

export const WEBHOOK_SECRET_HEADER = "x-webhook-secret";

export interface HandlerDeps {
  /** Reads an environment variable (Deno.env.get in production). */
  getEnv: (name: string) => string | undefined;
  /** fetch implementation (global fetch in production). */
  fetch: typeof fetch;
}

interface TicketRow {
  id: string;
  ticket_number: number;
  subject: string;
  requester_email: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

export function formatTicketNumber(ticketNumber: number): string {
  return `TKT-${String(ticketNumber).padStart(4, "0")}`;
}

/** Length-independent-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// Cached for the life of the isolate. Only a successfully loaded value is
// cached, so a transient failure does not lock the function out.
let cachedSecret: string | null = null;

/** Test-only: clears the cached webhook secret. */
export function resetWebhookSecretCache(): void {
  cachedSecret = null;
}

async function loadWebhookSecret(deps: HandlerDeps): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  const supabaseUrl = deps.getEnv("SUPABASE_URL");
  const serviceKey = deps.getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return null;

  const res = await deps.fetch(`${supabaseUrl}/rest/v1/rpc/ticket_webhook_secret`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: "{}",
  });
  if (!res.ok) return null;
  const value = await res.json();
  if (typeof value !== "string" || value.length < 32) return null;
  cachedSecret = value;
  return value;
}

async function loadTicket(
  deps: HandlerDeps,
  ticketId: string,
): Promise<TicketRow | null> {
  const supabaseUrl = deps.getEnv("SUPABASE_URL");
  const serviceKey = deps.getEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return null;

  const url = `${supabaseUrl}/rest/v1/support_tickets?id=eq.${encodeURIComponent(ticketId)}` +
    `&select=id,ticket_number,subject,requester_email&limit=1`;
  const res = await deps.fetch(url, {
    method: "GET",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] as TicketRow;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleRequest(
  req: Request,
  deps: HandlerDeps,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // ── Authenticate the caller (fail closed) ───────────────────────────
    const presented = req.headers.get(WEBHOOK_SECRET_HEADER);
    if (!presented) {
      return json({ error: "Unauthorized" }, 401);
    }
    const expected = await loadWebhookSecret(deps);
    if (!expected || !timingSafeEqual(presented, expected)) {
      return json({ error: "Unauthorized" }, 401);
    }

    // ── From here on, the caller is the database trigger ────────────────
    // Fire-and-forget: return 200 so pg_net does not record failures that
    // nobody reads; errors go to the function log.
    const payload = await req.json().catch(() => null);
    const ticketId = payload?.record?.id;
    if (typeof ticketId !== "string" || !UUID_RE.test(ticketId)) {
      return json({ skipped: true, reason: "missing ticket id" });
    }

    const brokerPortalUrl = deps.getEnv("BROKER_PORTAL_URL");
    const apiSecret = deps.getEnv("INTERNAL_API_SECRET");
    if (!brokerPortalUrl || !apiSecret) {
      console.error(
        "[send-ticket-confirmation] Missing BROKER_PORTAL_URL or INTERNAL_API_SECRET. Skipping ticket:",
        ticketId,
      );
      return json({ skipped: true, reason: "environment not configured" });
    }

    // Use the stored row, never the payload's email/subject.
    const ticket = await loadTicket(deps, ticketId);
    if (!ticket?.requester_email || !ticket.subject) {
      return json({ skipped: true, reason: "ticket not found" });
    }

    const ticketNumber = formatTicketNumber(ticket.ticket_number);
    const ticketLink = `${brokerPortalUrl}/dashboard/support/${ticket.id}`;

    const response = await deps.fetch(`${brokerPortalUrl}/api/email/ticket-confirmation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-secret": apiSecret },
      body: JSON.stringify({
        ticketId: ticket.id,
        ticketNumber,
        ticketSubject: ticket.subject,
        requesterEmail: ticket.requester_email,
        ticketLink,
      }),
    });

    if (!response.ok) {
      console.error(
        `[send-ticket-confirmation] Email endpoint returned ${response.status} for ${ticketNumber}`,
      );
      return json({ sent: false, ticketNumber, error: `email endpoint returned ${response.status}` });
    }

    console.log(`[send-ticket-confirmation] Confirmation sent for ${ticketNumber}`);
    return json({ sent: true, ticketNumber });
  } catch (error) {
    // Keep detailed error in server logs only (CodeQL: js/stack-trace-exposure)
    console.error("[send-ticket-confirmation] Unexpected error:", error);
    return json({ error: "Internal error" });
  }
}
