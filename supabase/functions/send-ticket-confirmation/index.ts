/**
 * Supabase Edge Function: Send Ticket Confirmation
 *
 * Sends a confirmation email when a new support ticket is created.
 * Called by the database trigger on support_tickets INSERT, which
 * authenticates with the `x-webhook-secret` header. All logic lives in
 * `handler.ts` (unit tested with Jest).
 *
 * Tasks: BACKLOG-1573, BACKLOG-3711
 *
 * Environment variables:
 *   BROKER_PORTAL_URL         - Broker portal base URL
 *   INTERNAL_API_SECRET       - Shared secret for the broker portal email API
 *   SUPABASE_URL              - auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY - auto-injected; reads the webhook secret and the ticket row
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleRequest } from "./handler.ts";

Deno.serve((req: Request) =>
  handleRequest(req, {
    getEnv: (name: string) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
  })
);
