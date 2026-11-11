/**
 * @jest-environment node
 *
 * BACKLOG-4237 A6 wiring — the /oauth/consent page and the decideConsent action
 * call the allowlist, the session check and the id check.
 *
 * Response shapes: OAuthAuthorizationDetails from the installed @supabase/auth-js
 * (dist/module/lib/types.d.ts). Field values are placeholders.
 */

const mockGetUser = jest.fn();
const mockGetDetails = jest.fn();
const mockApprove = jest.fn();
const mockDeny = jest.fn();
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: () => mockGetUser(),
      oauth: {
        getAuthorizationDetails: (id: string) => mockGetDetails(id),
        approveAuthorization: (...a: unknown[]) => mockApprove(...a),
        denyAuthorization: (...a: unknown[]) => mockDeny(...a),
      },
    },
  }),
}));

let mockCookie: string | undefined;
const mockCookieSet = jest.fn();
jest.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'keepr_mcp_consent' && mockCookie ? { value: mockCookie } : undefined),
    set: (...a: unknown[]) => mockCookieSet(...a),
  }),
}));

jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { to });
  },
}));

import ConsentPage from '@/app/oauth/consent/page';
import { decideConsent } from '@/app/oauth/consent/actions';
import { ZERO_UUID } from './fixtures';

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const ID = 'authz_000000000000';
const USER = { id: ZERO_UUID };

function details(redirectUri: string) {
  return {
    data: {
      authorization_id: ID,
      redirect_uri: redirectUri,
      client: { id: ZERO_UUID, name: 'Claude', uri: 'https://claude.ai', logo_uri: '' },
      user: { id: ZERO_UUID, email: 'person@example.com' },
      scope: 'email',
    },
    error: null,
  };
}

/** The props of the ConsentClient element the page renders, or null. */
function consentProps(tree: unknown): Record<string, unknown> | null {
  const t = tree as { props?: { children?: unknown; mode?: string } };
  if (!t || typeof t !== 'object' || !t.props) return null;
  if (t.props.mode) return t.props as Record<string, unknown>;
  return consentProps(t.props.children);
}

async function render(query: Record<string, string>) {
  try {
    return { tree: await ConsentPage({ searchParams: Promise.resolve(query) }) };
  } catch (e) {
    return { redirect: (e as { to?: string }).to };
  }
}

beforeEach(() => {
  mockCookie = undefined;
  [mockGetUser, mockGetDetails, mockApprove, mockDeny, mockCookieSet].forEach((m) => m.mockReset());
  mockGetUser.mockResolvedValue({ data: { user: USER } });
});

describe('/oauth/consent page', () => {
  it('positive: an allow-listed authorization renders the consent screen', async () => {
    mockGetDetails.mockResolvedValue(details(CLAUDE));
    const { tree } = await render({ authorization_id: ID });
    expect(consentProps(tree)).toMatchObject({ mode: 'consent', authorizationId: ID, redirectHost: 'claude.ai' });
  });

  it('a refused authorization renders no consent screen', async () => {
    mockGetDetails.mockResolvedValue(details('https://claude.ai.evil.example/api/mcp/auth_callback'));
    const { tree } = await render({ authorization_id: ID });
    expect(consentProps(tree)).toBeNull();
    expect(JSON.stringify(tree)).toContain('does not support connecting this app');
  });

  it('signed out: redirects to /oauth/consent/start with the id and reads nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const out = await render({ authorization_id: ID });
    expect(out.redirect).toBe(`/oauth/consent/start?authorization_id=${ID}`);
    expect(mockGetDetails).not.toHaveBeenCalled();
  });

  it('no query: the cookie supplies the id', async () => {
    mockCookie = ID;
    mockGetDetails.mockResolvedValue(details(CLAUDE));
    const { tree } = await render({});
    expect(mockGetDetails).toHaveBeenCalledWith(ID);
    expect(consentProps(tree)).toMatchObject({ mode: 'consent' });
  });

  it('an invalid id reads nothing', async () => {
    const { tree } = await render({ authorization_id: 'bad id' });
    expect(mockGetDetails).not.toHaveBeenCalled();
    expect(JSON.stringify(tree)).toContain('no AI app connection waiting');
  });
});

describe('decideConsent action', () => {
  it('positive: approve returns the URL and clears the cookie', async () => {
    mockGetDetails.mockResolvedValue(details(CLAUDE));
    mockApprove.mockResolvedValue({ data: { redirect_url: `${CLAUDE}?code=c` }, error: null });
    expect(await decideConsent(ID, 'approve')).toEqual({ ok: true, url: `${CLAUDE}?code=c` });
    expect(mockCookieSet).toHaveBeenCalledWith(expect.objectContaining({ name: 'keepr_mcp_consent', maxAge: 0, path: '/oauth' }));
  });

  it('signed out: refuses and calls nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect(await decideConsent(ID, 'approve')).toEqual({ ok: false, reason: 'error' });
    expect(mockGetDetails).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it.each(['bad id', '../x', ''])('an invalid id %p is refused before any call', async (id) => {
    expect(await decideConsent(id, 'approve')).toEqual({ ok: false, reason: 'error' });
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockGetDetails).not.toHaveBeenCalled();
  });

  it('an unknown decision is refused before any call', async () => {
    expect(await decideConsent(ID, 'maybe' as 'approve')).toEqual({ ok: false, reason: 'error' });
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockDeny).not.toHaveBeenCalled();
  });
});
