/**
 * Supabase Edge Function: submission-sweep (BACKLOG-3726)
 *
 * Removes abandoned, stalled and orphaned submission uploads. Called hourly by
 * the cron job `submission-sweep` through public.submission_sweep_invoke(),
 * which authenticates with the `x-webhook-secret` header. All logic lives in
 * `handler.ts` (unit tested with Jest).
 *
 * Environment variables:
 *   SUBMISSION_SWEEP_MODE     - "live" for a live run; anything else = dry run
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
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line: string) => console.log(line),
  })
);
