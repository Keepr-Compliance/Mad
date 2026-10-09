/**
 * @jest-environment node
 *
 * BACKLOG-3834: maps-proxy Edge Function handler.
 *
 * Lives under tests/ because jest's CI testMatch runs <rootDir>/tests/** and
 * not supabase/functions/**. fetch is injected and fully mocked: no network.
 */

import {
  handleRequest,
  buildGoogleRequest,
  trimGoogleResponse,
  RATE_LIMITS,
  type HandlerDeps,
} from '../../supabase/functions/maps-proxy/handler';
import { checkRateLimit, resetRateLimitState } from '../../supabase/functions/_shared/rateLimiter';

// Invented values, built at runtime so no key-shaped literal sits in the repo.
const SERVER_KEY = ['server', 'test', 'value'].join('-');
const USER_ID = 'user-abc';
const ENV: Record<string, string> = {
  GOOGLE_MAPS_SERVER_KEY: SERVER_KEY,
  SUPABASE_URL: 'https://proj.supabase.test',
  SUPABASE_ANON_KEY: 'anon-key',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const AUTOCOMPLETE_OK = {
  status: 'OK',
  predictions: [
    {
      place_id: 'ChIJabcdefghij',
      description: '1 Main St, Springfield, IL, USA',
      structured_formatting: { main_text: '1 Main St', secondary_text: 'Springfield, IL, USA' },
      matched_substrings: [{ length: 3, offset: 0 }],
      terms: [{ offset: 0, value: '1' }],
    },
  ],
};

const DETAILS_OK = {
  status: 'OK',
  html_attributions: [],
  result: {
    formatted_address: '1 Main St, Springfield, IL 62701, USA',
    address_components: [
      { long_name: '1', short_name: '1', types: ['street_number'] },
      { long_name: 'Main Street', short_name: 'Main St', types: ['route'] },
    ],
    geometry: { location: { lat: 39.8, lng: -89.6 }, viewport: { northeast: {}, southwest: {} } },
    adr_address: '<span>extra</span>',
  },
};

function makeDeps(opts: { user?: { id: string } | null; google?: unknown; googleStatus?: number; limiter?: HandlerDeps['checkRateLimit'] } = {}) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: init?.headers as Record<string, string> | undefined });
    if (url.endsWith('/auth/v1/user')) {
      const user = opts.user === undefined ? { id: USER_ID } : opts.user;
      return user ? jsonResponse(user) : jsonResponse({ message: 'invalid' }, 401);
    }
    return jsonResponse(opts.google ?? AUTOCOMPLETE_OK, opts.googleStatus ?? 200);
  });
  const deps: HandlerDeps = {
    getEnv: (n) => ENV[n],
    fetch: fetchMock as unknown as typeof fetch,
    checkRateLimit: opts.limiter ?? checkRateLimit,
  };
  const googleCalls = () => calls.filter((c) => c.url.startsWith('https://maps.googleapis.com/'));
  return { deps, calls, googleCalls };
}

function post(body: unknown, auth: string | null = 'Bearer user-jwt'): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth !== null) headers.Authorization = auth;
  return new Request('https://proj.supabase.test/functions/v1/maps-proxy', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => resetRateLimitState());

describe('maps-proxy authentication', () => {
  it('A1 rejects a request with no Authorization header and never calls Google', async () => {
    const { deps, googleCalls } = makeDeps();
    const res = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }, null), deps);
    expect(res.status).toBe(401);
    expect(googleCalls()).toHaveLength(0);
  });

  it('A2 rejects a token with no user behind it (e.g. the anon key)', async () => {
    const { deps, googleCalls } = makeDeps({ user: null });
    const res = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }, 'Bearer anon-key'), deps);
    expect(res.status).toBe(401);
    expect(googleCalls()).toHaveLength(0);
  });

  it('A3 forwards the caller token to the auth user endpoint', async () => {
    const { deps, calls } = makeDeps();
    await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
    const auth = calls.find((c) => c.url === 'https://proj.supabase.test/auth/v1/user');
    expect(auth?.headers?.Authorization).toBe('Bearer user-jwt');
  });

  it('A4 rejects non-POST', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(new Request('https://x.test/', { method: 'GET' }), deps);
    expect(res.status).toBe(405);
  });

  it('A5 returns 503 and calls nothing when the server key is not configured', async () => {
    const { deps, calls } = makeDeps();
    deps.getEnv = (n) => (n === 'GOOGLE_MAPS_SERVER_KEY' ? undefined : ENV[n]);
    const res = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe('maps-proxy allow-list', () => {
  it.each([
    ['unknown op', { op: 'directions', origin: 'a', destination: 'b' }],
    ['client-supplied key', { op: 'autocomplete', input: '1 Main', key: 'x' }],
    ['client-supplied fields', { op: 'details', place_id: 'ChIJabcdefghij', fields: 'reviews' }],
    ['client-supplied types', { op: 'autocomplete', input: '1 Main', types: 'establishment' }],
    ['client-supplied components', { op: 'autocomplete', input: '1 Main', components: 'country:fr' }],
    ['url path injection', { op: 'autocomplete', input: '1 Main', path: 'staticmap' }],
    ['geocode with a sessiontoken', { op: 'geocode', address: '1 Main St', sessiontoken: 'abc' }],
    ['input too short', { op: 'autocomplete', input: 'ab' }],
    ['input too long', { op: 'autocomplete', input: 'a'.repeat(201) }],
    ['malformed place_id', { op: 'details', place_id: '../../x?y=1' }],
    ['malformed sessiontoken', { op: 'autocomplete', input: '1 Main', sessiontoken: 'a&key=b' }],
    ['array body', [{ op: 'autocomplete', input: '1 Main' }]],
    ['non-JSON body', 'not json'],
  ])('B rejects %s with 400 and never calls Google', async (_name, body) => {
    const { deps, googleCalls } = makeDeps();
    const res = await handleRequest(post(body), deps);
    expect(res.status).toBe(400);
    expect(googleCalls()).toHaveLength(0);
  });

  it('B2 builds the autocomplete URL with server-fixed params only', () => {
    const r = buildGoogleRequest({ op: 'autocomplete', input: '1 Main', sessiontoken: 'session_1.2_3' }, SERVER_KEY);
    const url = new URL(r!.url);
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/place/autocomplete/json');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      input: '1 Main',
      types: 'address',
      components: 'country:us',
      sessiontoken: 'session_1.2_3',
      key: SERVER_KEY,
    });
  });

  it('B3 builds the details URL with the fixed field mask', () => {
    const r = buildGoogleRequest({ op: 'details', place_id: 'ChIJabcdefghij' }, SERVER_KEY);
    const url = new URL(r!.url);
    expect(url.pathname).toBe('/maps/api/place/details/json');
    expect(url.searchParams.get('fields')).toBe('address_components,formatted_address,geometry');
  });

  it('B4 builds the geocode URL', () => {
    const r = buildGoogleRequest({ op: 'geocode', address: '1 Main St' }, SERVER_KEY);
    const url = new URL(r!.url);
    expect(url.pathname).toBe('/maps/api/geocode/json');
    expect(Object.keys(Object.fromEntries(url.searchParams)).sort()).toEqual(['address', 'key']);
  });

  it('B5 an allowed request reaches Google exactly once', async () => {
    const { deps, googleCalls } = makeDeps();
    const res = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
    expect(res.status).toBe(200);
    expect(googleCalls()).toHaveLength(1);
  });
});

describe('maps-proxy response trimming', () => {
  it('C1 autocomplete passes only the fields the app reads', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
    expect(await res.json()).toEqual({
      status: 'OK',
      predictions: [
        {
          place_id: 'ChIJabcdefghij',
          description: '1 Main St, Springfield, IL, USA',
          structured_formatting: { main_text: '1 Main St', secondary_text: 'Springfield, IL, USA' },
        },
      ],
    });
  });

  it('C2 details drops extra fields', () => {
    expect(trimGoogleResponse('details', DETAILS_OK)).toEqual({
      status: 'OK',
      result: {
        formatted_address: '1 Main St, Springfield, IL 62701, USA',
        address_components: DETAILS_OK.result.address_components,
        geometry: { location: { lat: 39.8, lng: -89.6 } },
      },
    });
  });

  it('C3 never passes Google error_message through', async () => {
    const { deps } = makeDeps({ google: { status: 'REQUEST_DENIED', error_message: 'detail', predictions: [] } });
    const res = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
    const body = await res.json();
    expect(body).toEqual({ status: 'REQUEST_DENIED', predictions: [] });
  });

  it('C4 upstream HTTP failure is 502', async () => {
    const { deps } = makeDeps({ googleStatus: 500 });
    const res = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
    expect(res.status).toBe(502);
  });

  it('C5 never logs the address text', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const { deps } = makeDeps({ google: { status: 'OVER_QUERY_LIMIT' } });
      await handleRequest(post({ op: 'autocomplete', input: '742 Evergreen Terrace' }), deps);
      const all = [...warn.mock.calls, ...log.mock.calls, ...info.mock.calls].flat().join(' ');
      expect(warn).toHaveBeenCalled();
      expect(all).not.toContain('Evergreen');
    } finally {
      warn.mockRestore();
      log.mockRestore();
      info.mockRestore();
    }
  });
});

describe('maps-proxy rate limit', () => {
  it('D1 the minute window blocks the request after the cap and does not call Google', async () => {
    const minute = RATE_LIMITS[0];
    const { deps, googleCalls } = makeDeps();
    for (let i = 0; i < minute.max; i++) {
      const ok = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
      expect(ok.status).toBe(200);
    }
    const blocked = await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(googleCalls()).toHaveLength(minute.max);
  });

  it('D2 limits are per user', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({ limiter: (key) => { seen.push(key); return { allowed: true }; } });
    await handleRequest(post({ op: 'autocomplete', input: '1 Main' }), deps);
    expect(seen).toEqual([`maps-proxy:minute:${USER_ID}`, `maps-proxy:day:${USER_ID}`]);
  });
});
