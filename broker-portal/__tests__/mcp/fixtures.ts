/**
 * Shared fixtures for the MCP tests (BACKLOG-4237).
 *
 * Claims: the field set is the getClaims() example response in the installed
 * @supabase/auth-js (dist/module/GoTrueClient.d.ts, getClaims JSDoc), with
 * all-zero ids and a placeholder project host. `client_id` is NOT in that
 * example or in the JwtPayload type; its name comes from the Supabase OAuth
 * server docs, so the connected-app fixture is doc-sourced, not transcribed.
 */

export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** A first-party portal/desktop session token's claims (no client_id). */
export const FIRST_PARTY_CLAIMS = {
  aal: 'aal1',
  amr: [{ method: 'email', timestamp: 1715766000 }],
  app_metadata: {},
  aud: 'authenticated',
  email: 'person@example.com',
  exp: 4102444800,
  iat: 1715766000,
  is_anonymous: false,
  iss: 'https://project-ref.supabase.co/auth/v1',
  phone: '',
  role: 'authenticated',
  session_id: ZERO_UUID,
  sub: ZERO_UUID,
  user_metadata: {},
};

/** A connected-app token's claims: first-party claims plus client_id. */
export const CONNECTED_APP_CLAIMS = { ...FIRST_PARTY_CLAIMS, client_id: ZERO_UUID };

export const CONNECTED_APP_TOKEN = 'connected-app-token-fixture';
export const FIRST_PARTY_TOKEN = 'first-party-token-fixture';
