/**
 * Supabase Edge Function: maps-proxy (BACKLOG-3834)
 *
 * Proxies the desktop app's address lookups (Places autocomplete, Place
 * details, Geocoding) to Google so the Google key never ships in the app.
 * All logic lives in `handler.ts` (unit tested with Jest).
 *
 * Deploy WITH gateway JWT verification (the default — do not pass
 * --no-verify-jwt):
 *   supabase functions deploy maps-proxy --project-ref <ref>
 *
 * Secrets:
 *   GOOGLE_MAPS_SERVER_KEY - Google key restricted to Places API + Geocoding API
 *   SUPABASE_URL, SUPABASE_ANON_KEY - auto-injected
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { checkRateLimit } from "../_shared/rateLimiter.ts";
import { handleRequest } from "./handler.ts";

Deno.serve((req: Request) =>
  handleRequest(req, {
    getEnv: (name: string) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    checkRateLimit,
  })
);
