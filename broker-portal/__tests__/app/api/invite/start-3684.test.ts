/**
 * BACKLOG-3684 — POST /api/invite/start sets the invite cookie only for a
 * same-origin request carrying a valid token; GET /api/invite/validate stays
 * read-only and never sets it.
 *
 * @jest-environment node
 */

const mockRpc = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: jest.fn(async () => ({ rpc: mockRpc })),
}));

import { POST } from '@/app/api/invite/start/route';
import { GET as VALIDATE } from '@/app/api/invite/validate/route';

const ORIGIN = 'http://localhost:3000';
const TOKEN = 'abc123def456';

function post(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return POST(
    new Request(`${ORIGIN}/api/invite/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRpc.mockResolvedValue({ data: { valid: true, email: 'x@fixture.example.test', role: 'agent' }, error: null });
});

describe('POST /api/invite/start', () => {
  it('same origin + valid token -> 204 and the cookie, scoped as specified', async () => {
    const res = await post({ token: TOKEN, purpose: 'invite' });
    expect(res.status).toBe(204);
    expect(mockRpc).toHaveBeenCalledWith('public_validate_invitation_token', { p_token: TOKEN });
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const c = cookies[0];
    expect(c.startsWith(`keepr_invite=invite.${TOKEN};`)).toBe(true);
    expect(c).toMatch(/Path=\/auth(;|$)/);
    expect(c).toMatch(/Max-Age=1800/);
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/Secure/i);
    expect(c).toMatch(/SameSite=lax/i);
  });

  it('purpose setup is carried in the value', async () => {
    const res = await post({ token: TOKEN, purpose: 'setup' });
    expect(res.headers.getSetCookie()[0].startsWith(`keepr_invite=setup.${TOKEN};`)).toBe(true);
  });

  // J-origin (wrong build 10)
  it.each<[string, Record<string, string>]>([
    ['another origin', { origin: 'https://attacker.example.test' }],
    ['no Origin header', {}],
    ['same host, other scheme', { origin: 'https://localhost:3000' }],
  ])('%s -> 403, no cookie, no lookup', async (_n, headers) => {
    const res = await post({ token: TOKEN, purpose: 'invite' }, headers);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['no token', { purpose: 'invite' }],
    ['unknown purpose', { token: TOKEN, purpose: 'admin' }],
    ['token with a separator', { token: 'a;b', purpose: 'invite' }],
    ['not JSON', 'not json'],
  ])('%s -> 400, no cookie', async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('an invalid or unknown token -> 400, no cookie', async () => {
    mockRpc.mockResolvedValue({ data: { valid: false, error: 'Invitation not found' }, error: null });
    const res = await post({ token: TOKEN, purpose: 'invite' });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('an RPC error -> 400, no cookie', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'fixture' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ token: TOKEN, purpose: 'invite' });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
    errorSpy.mockRestore();
  });
});

// J-validate (wrong build 7)
describe('GET /api/invite/validate', () => {
  it('a valid token: returns the invite and sets no cookie', async () => {
    const res = await VALIDATE(new Request(`${ORIGIN}/api/invite/validate?token=${TOKEN}`));
    expect((await res.json()).valid).toBe(true);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
