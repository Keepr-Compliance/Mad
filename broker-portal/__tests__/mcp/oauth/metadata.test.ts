/**
 * @jest-environment node
 *
 * BACKLOG-4238 — authorization server metadata (RFC 8414) and protected
 * resource metadata (RFC 9728). Controls H1, H2, H27a.
 */

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn() }));

import * as metadata from '@/app/oauth/metadata/route';
import * as prm from '@/app/api/mcp/resource-metadata/route';
import { blockNetwork, captureConsole, OAUTH_ENV, ORIGIN } from './fixtures';

const ENV = { ...process.env };
blockNetwork();
let cap: ReturnType<typeof captureConsole>;

beforeEach(() => {
  process.env = { ...ENV, ...OAUTH_ENV };
  mockRpc.mockReset();
  cap = captureConsole();
});
afterEach(() => cap.restore());
afterAll(() => {
  process.env = ENV;
});

const EXPECTED_AS = {
  issuer: ORIGIN,
  authorization_endpoint: `${ORIGIN}/oauth/authorize`,
  token_endpoint: `${ORIGIN}/oauth/token`,
  registration_endpoint: `${ORIGIN}/oauth/register`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['mcp:read'],
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: false,
};

const EXPECTED_PRM = {
  resource: `${ORIGIN}/api/mcp`,
  authorization_servers: [ORIGIN],
  scopes_supported: ['mcp:read'],
  bearer_methods_supported: ['header'],
  resource_name: 'Keepr',
};

describe('H1: authorization server metadata', () => {
  it('is exactly the planned document, with no-store and no database call', async () => {
    const res = await metadata.GET(new Request(`${ORIGIN}/oauth/metadata`));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toEqual(EXPECTED_AS);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('the issuer is MCP_PUBLIC_ORIGIN, whatever the request Host', async () => {
    const res = await metadata.GET(
      new Request('https://other-host.test/.well-known/oauth-authorization-server', {
        headers: { host: 'other-host.test', 'x-forwarded-host': 'other-host.test' },
      })
    );
    const body = await res.json();
    expect(body.issuer).toBe(ORIGIN);
    expect(JSON.stringify(body)).not.toContain('other-host');
  });

  it('a trailing slash on MCP_PUBLIC_ORIGIN still gives the bare origin', async () => {
    process.env.MCP_PUBLIC_ORIGIN = `${ORIGIN}/`;
    const body = await (await metadata.GET(new Request(`${ORIGIN}/oauth/metadata`))).json();
    expect(body.issuer).toBe(ORIGIN);
  });

  it('advertises no offline_access, no revocation, no jwks', async () => {
    const body = await (await metadata.GET(new Request(`${ORIGIN}/oauth/metadata`))).json();
    expect(body.scopes_supported).not.toContain('offline_access');
    expect(body).not.toHaveProperty('revocation_endpoint');
    expect(body).not.toHaveProperty('jwks_uri');
    expect(body.client_id_metadata_document_supported).toBe(false);
  });
});

describe('H2: protected resource metadata', () => {
  it('names this resource and this portal as the only authorization server', async () => {
    const res = await prm.GET(new Request(`${ORIGIN}/api/mcp/resource-metadata`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EXPECTED_PRM);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('the same document is served when reached through the well-known rewrite', async () => {
    const res = await prm.GET(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`));
    expect(await res.json()).toEqual(EXPECTED_PRM);
  });

  it('the issuer in the PRM equals the metadata issuer', async () => {
    const as = await (await metadata.GET(new Request(`${ORIGIN}/oauth/metadata`))).json();
    const pr = await (await prm.GET(new Request(`${ORIGIN}/api/mcp/resource-metadata`))).json();
    expect(pr.authorization_servers).toEqual([as.issuer]);
  });
});

describe('H27a: HEAD and other methods on the metadata routes', () => {
  it.each([
    ['metadata', metadata, `${ORIGIN}/oauth/metadata`],
    ['resource metadata', prm, `${ORIGIN}/api/mcp/resource-metadata`],
  ] as const)('%s exports every method explicitly', (_n, mod, _url) => {
    for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(typeof (mod as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it.each([
    ['metadata', metadata, `${ORIGIN}/oauth/metadata`],
    ['resource metadata', prm, `${ORIGIN}/api/mcp/resource-metadata`],
  ] as const)('%s HEAD → 200 with the GET headers and no body', async (_n, mod, url) => {
    const res = await mod.HEAD(new Request(url, { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)('%s → 405 Allow: GET, HEAD', async (m) => {
    for (const [mod, url] of [
      [metadata, `${ORIGIN}/oauth/metadata`],
      [prm, `${ORIGIN}/api/mcp/resource-metadata`],
    ] as const) {
      const res = await mod[m](new Request(url, { method: m }));
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('GET, HEAD');
    }
  });
});
