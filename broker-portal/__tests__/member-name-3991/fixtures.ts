/**
 * BACKLOG-3991 fixtures, TRANSCRIBED (values invented, shapes measured):
 *
 *  - AZURE_METADATA: the key set of keepr-test auth.users.raw_user_meta_data for an
 *    Azure sign-in (custom_claims{email, oid, sid, tid, xms_edov}, email,
 *    email_verified, full_name, iss, phone_verified, preferred_username, provider_id,
 *    sub; read 2026-10-19). given_name / family_name are added inside custom_claims,
 *    exactly where the xms_edov optional claim landed: Supabase Auth's Azure parser
 *    copies unmapped ID-token claims into custom_claims and never to the top level.
 *  - GOOGLE_METADATA: the key set of production auth.identities.identity_data for
 *    Google (avatar_url, custom_claims, email, email_verified, full_name, iss, name,
 *    phone_verified, picture, provider_id, sub). No first or last name.
 *  - GOOGLE_USERINFO: the userinfo v2 body {id, email, verified_email, name,
 *    given_name, family_name, picture}, transcribed from its consumer
 *    (electron/services/googleAuthService.ts), not from a live response.
 */

export const FIXTURE_TOKEN = 'ya29.fixture-provider-token-3991-do-not-log';

export const AZURE_METADATA: Record<string, unknown> = {
  custom_claims: {
    email: 'agent-3991@fixture.example.test',
    oid: 'fixture-oid-3991',
    sid: 'fixture-sid-3991',
    tid: 'fixture-tenant-3991',
    xms_edov: true,
    given_name: 'Avery',
    family_name: 'Stone',
  },
  email: 'agent-3991@fixture.example.test',
  email_verified: true,
  full_name: 'Avery Stone',
  iss: 'https://login.microsoftonline.com/fixture-tenant-3991/v2.0',
  phone_verified: false,
  preferred_username: 'agent-3991@fixture.example.test',
  provider_id: 'fixture-provider-id-3991',
  sub: 'fixture-sub-3991',
};

export const GOOGLE_METADATA: Record<string, unknown> = {
  avatar_url: 'https://fixture.example.test/a.png',
  custom_claims: { hd: 'fixture-workspace.example.test' },
  email: 'agent-3991@fixture-workspace.example.test',
  email_verified: true,
  full_name: 'Blake Rivera',
  iss: 'https://accounts.google.com',
  name: 'Blake Rivera',
  phone_verified: false,
  picture: 'https://fixture.example.test/a.png',
  provider_id: 'fixture-google-id-3991',
  sub: 'fixture-google-id-3991',
};

export const GOOGLE_USERINFO = {
  id: 'fixture-google-id-3991',
  email: 'agent-3991@fixture-workspace.example.test',
  verified_email: true,
  name: 'Blake Rivera',
  given_name: 'Blake',
  family_name: 'Rivera',
  picture: 'https://fixture.example.test/a.png',
};

/** Every console method, spied; returns a check that no call mentions `secret`. */
export function spyConsole(): { calls: () => string[]; restore: () => void } {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const spies = methods.map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  return {
    calls: () => spies.flatMap((s) => s.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}
