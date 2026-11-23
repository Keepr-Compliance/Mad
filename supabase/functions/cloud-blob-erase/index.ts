/**
 * Supabase Edge Function: cloud-blob-erase (BACKLOG-4263, sync plan P3)
 *
 * Erases stored Keepr Cloud file bytes that no cloud row needs, and scrubs message and file rows of computers that
 * are not an account's active computer. Called hourly by the cron job `cloud-blob-erase` through
 * public.cloud_blob_erase_invoke(), which authenticates with the `x-webhook-secret` header. All logic lives in
 * `handler.ts` (unit tested with Jest).
 *
 * Environment variables:
 *   CLOUD_BLOB_ERASE_MODE     - "live" for a live run; anything else = dry run
 *   SENTRY_DSN                - optional; failures and cron check-ins
 *   SUPABASE_URL              - auto-injected
 *   SUPABASE_SERVICE_ROLE_KEY - auto-injected
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleRequest } from "./handler.ts";

Deno.serve((req: Request) =>
  handleRequest(req, {
    getEnv: (name: string) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    uuid: () => crypto.randomUUID(),
    now: () => Date.now(),
    log: (line: string) => console.log(line),
  })
);
