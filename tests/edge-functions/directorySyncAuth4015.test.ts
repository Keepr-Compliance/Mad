/**
 * @jest-environment node
 *
 * BACKLOG-4015: who may call directory-sync. Drives the real Deno.serve handler from index.ts
 * with a real Request.
 *
 * Bearer shapes transcribed from the 2026-11-04 keepr-test calls: legacy keys are HS256 JWTs,
 * header {"alg":"HS256","typ":"JWT"}, payload keys exactly exp, iat, iss, ref, role with iss
 * "supabase"; the service_role payload segment length mod 4 is 2. The function-side injected
 * SUPABASE_SERVICE_ROLE_KEY is not that JWT. All key values below are invented test strings.
 *
 * index.ts is Deno source that calls Deno.serve at load: the Deno global is stubbed and the
 * jsr: modules are virtual. The fake client returns zero organisations, so an accepted call is
 * 200 "No organizations ..." (as keepr-test answers today).
 */
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('jsr:@supabase/functions-js/edge-runtime.d.ts', () => ({}), { virtual: true });
const createClient = jest.fn();
jest.mock(
  'jsr:@supabase/supabase-js@2',
  () => ({ createClient: (...a: unknown[]) => createClient(...a) }),
  { virtual: true },
);

const REF = 'testprojectref0000ab';
const SECRET_A = 'sb_secret_TESTONLYsecretkeysvalueA0000';
const SECRET_B = 'sb_secret_TESTONLYsecretkeysvalueB0000';
const ENV_DEFAULTS: Record<string, string> = {
  SUPABASE_URL: `https://${REF}.supabase.co`,
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_TESTONLYnotarealkey000000000',
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_A }),
};
const ENV: Record<string, string | undefined> = { ...ENV_DEFAULTS };

let handler: (req: Request) => Promise<Response>;
(globalThis as unknown as { Deno: unknown }).Deno = {
  serve: (h: typeof handler) => {
    handler = h;
  },
  env: { get: (k: string) => ENV[k] },
};

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url');
function jwt(payload: Record<string, unknown>): string {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = createHmac('sha256', 'test-secret').update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
const claims = (role: string, extra: Record<string, unknown> = {}) => ({
  iss: 'supabase',
  ref: REF,
  role,
  iat: 1700000000,
  exp: 2000000000,
  ...extra,
});

/** A service_role JWT whose payload segment contains '-' and '_' and is not a multiple of 4. */
function awkwardServiceJwt(): string {
  for (let i = 0; i < 5000; i++) {
    const t = jwt(claims('service_role', { n: '￿' + String(i) }));
    const p = t.split('.')[1];
    if (p.includes('-') && p.includes('_') && p.length % 4 !== 0) return t;
  }
  throw new Error('no awkward fixture found');
}

function okClient() {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.then = (r: (v: unknown) => unknown) => r({ data: [], error: null });
  return { from: () => q };
}

async function call(auth?: string): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth !== undefined) headers.Authorization = auth;
  const res = await handler(
    new Request(
      'https://example.test/functions/v1/directory-sync?org_id=00000000-0000-0000-0000-000000000000',
      { method: 'POST', headers },
    ),
  );
  return res.status;
}

beforeAll(() => {
  createClient.mockImplementation(() => okClient());
  // require, not import(): tsc would otherwise type-check the Deno source (BACKLOG-4015 R1).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../supabase/functions/directory-sync/index');
  expect(typeof handler).toBe('function');
});

afterEach(() => {
  for (const k of Object.keys(ENV)) delete ENV[k];
  Object.assign(ENV, ENV_DEFAULTS);
});

describe('directory-sync caller auth (BACKLOG-4015)', () => {
  it('C1 the legacy service_role JWT the admin portal sends is accepted', async () => {
    expect(await call(`Bearer ${jwt(claims('service_role'))}`)).toBe(200);
  });
  it('C2 an anon JWT is refused 403', async () => {
    expect(await call(`Bearer ${jwt(claims('anon'))}`)).toBe(403);
  });
  it('C2b a signed-in user JWT (role authenticated) is refused 403', async () => {
    expect(await call(`Bearer ${jwt(claims('authenticated', { sub: 'u' }))}`)).toBe(403);
  });
  it('C3 a service_role JWT for another project is refused 403', async () => {
    expect(
      await call(`Bearer ${jwt(claims('service_role', { ref: 'otherprojectref00000' }))}`),
    ).toBe(403);
  });
  it('C4 a publishable key (non-JWT) is refused 403', async () => {
    expect(await call('Bearer sb_publishable_TESTONLY0000000000000000000')).toBe(403);
  });
  it('C5 the function-side SUPABASE_SERVICE_ROLE_KEY itself is accepted', async () => {
    expect(await call(`Bearer ${ENV_DEFAULTS.SUPABASE_SERVICE_ROLE_KEY}`)).toBe(200);
  });
  it('C6 base64url payload with - and _ and no padding decodes', async () => {
    expect(await call(`Bearer ${awkwardServiceJwt()}`)).toBe(200);
  });
  it('C6a the real payload length (mod 4 = 2) decodes', async () => {
    const t = jwt(claims('service_role'));
    expect(t.split('.')[1].length % 4).toBe(2);
    expect(await call(`Bearer ${t}`)).toBe(200);
  });
  it('C7 no Authorization header, or a non-Bearer one, is 401', async () => {
    expect(await call()).toBe(401);
    expect(await call('Basic abc')).toBe(401);
  });
});

describe('fail closed when the project ref cannot be read (BACKLOG-4015 R2)', () => {
  it('C9 unparseable SUPABASE_URL: a service_role JWT is refused 403', async () => {
    ENV.SUPABASE_URL = 'not a url';
    expect(await call(`Bearer ${jwt(claims('service_role'))}`)).toBe(403);
  });
  it('C9b SUPABASE_URL with an empty host: a service_role JWT is refused 403', async () => {
    ENV.SUPABASE_URL = 'file:///nohost';
    expect(await call(`Bearer ${jwt(claims('service_role'))}`)).toBe(403);
  });
});

describe('SUPABASE_SECRET_KEYS values are accepted (BACKLOG-4015 R3)', () => {
  it('C10 a value from the JSON-object form is accepted', async () => {
    expect(await call(`Bearer ${SECRET_A}`)).toBe(200);
  });
  it('C10b every value is a candidate (JSON array, second element)', async () => {
    ENV.SUPABASE_SECRET_KEYS = JSON.stringify([SECRET_A, SECRET_B]);
    expect(await call(`Bearer ${SECRET_B}`)).toBe(200);
  });
  it('C10c a comma/whitespace-separated list is accepted', async () => {
    ENV.SUPABASE_SECRET_KEYS = `${SECRET_A}, ${SECRET_B}`;
    expect(await call(`Bearer ${SECRET_B}`)).toBe(200);
  });
  it('C10d non-string values and an unset variable accept nothing', async () => {
    ENV.SUPABASE_SECRET_KEYS = JSON.stringify({ a: '', b: 7, c: null });
    expect(await call('Bearer 7')).toBe(403);
    delete ENV.SUPABASE_SECRET_KEYS;
    expect(await call(`Bearer ${SECRET_A}`)).toBe(403);
  });
});

describe('gateway dependency (BACKLOG-4015)', () => {
  it('C8 config.toml keeps verify_jwt on for directory-sync (the role claim is trusted only because the gateway verified it)', () => {
    const toml = fs.readFileSync(path.join(__dirname, '../../supabase/config.toml'), 'utf8');
    const m = toml.match(/\[functions\.directory-sync\]([\s\S]*?)(?=\n\[|$)/);
    expect(m === null || !/verify_jwt\s*=\s*false/.test(m[1])).toBe(true);
  });
});
