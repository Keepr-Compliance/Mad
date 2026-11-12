/**
 * @jest-environment node
 *
 * BACKLOG-4238 — the consent and AI apps server actions: order of checks,
 * exact arguments, the code and its digest, the return address, refusal texts,
 * log lines, disconnect and disconnect all.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockRpc = jest.fn();
let mockCookieHeader: string | null = null;
const mockRevalidatePath = jest.fn();

jest.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name.toLowerCase() === 'cookie' ? mockCookieHeader : null) }),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }),
}));
jest.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidatePath(...a) }));

import { approveAiApp, denyAiApp, disconnectAiApp, disconnectAllAiApps } from '@/lib/mcp/account/actions';
import { M_A, M_C } from '@/lib/mcp/account/messages';
import { bindingDigest, digest } from '@/lib/mcp/oauth/crypto';
import {
  BIND_COOKIE,
  BINDING,
  CONNECTION_ID,
  NONCE,
  ORIGIN,
  PEPPER_BYTES,
  REDIRECT_URI,
  REQUEST_ID,
  clearMcpEnv,
  decisionOk,
  refused,
  setMcpEnv,
} from './fixtures';
import { captureConsole } from '../oauth/fixtures';

let restoreEnv: () => void;
let logs: ReturnType<typeof captureConsole>;
beforeEach(() => {
  restoreEnv = setMcpEnv();
  mockRpc.mockReset();
  mockRevalidatePath.mockReset();
  mockCookieHeader = BIND_COOKIE;
  logs = captureConsole();
});
afterEach(() => {
  logs.restore();
  restoreEnv();
});

const mcpCalls = () => mockRpc.mock.calls.filter(([fn]) => String(fn).startsWith('mcp_'));

function locationOf(r: unknown): URL {
  expect(r).toMatchObject({ kind: 'redirect' });
  return new URL((r as { location: string }).location);
}

describe('approveAiApp', () => {
  it('sends the request id, the binding digest, the nonce and the digest of the code it puts in the Location', async () => {
    mockRpc.mockResolvedValue({ data: decisionOk('state-4238'), error: null });
    const r = await approveAiApp(REQUEST_ID, NONCE);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('mcp_authorize_approve');
    expect(args.p_request_id).toBe(REQUEST_ID);
    expect(args.p_nonce).toBe(NONCE);
    expect(args.p_browser_binding_sha256).toBe(bindingDigest(BINDING));
    const loc = locationOf(r);
    const code = loc.searchParams.get('code')!;
    expect(code).toMatch(/^kpr_ac_[A-Za-z0-9_-]{43}$/);
    expect(args.p_code_digest).toBe(digest(PEPPER_BYTES, code));
  });

  it('the Location base is the redirect_uri of the approve result; code, state, then iss', async () => {
    mockRpc.mockResolvedValue({ data: decisionOk('state-4238', 'https://callback.example.test/cb'), error: null });
    const r = await approveAiApp(REQUEST_ID, NONCE);
    const loc = locationOf(r);
    expect(`${loc.origin}${loc.pathname}`).toBe('https://callback.example.test/cb');
    expect([...loc.searchParams.keys()]).toEqual(['code', 'state', 'iss']);
    expect(loc.searchParams.get('state')).toBe('state-4238');
  });

  it('iss is MCP_PUBLIC_ORIGIN byte for byte', async () => {
    mockRpc.mockResolvedValue({ data: decisionOk(), error: null });
    const loc = locationOf(await approveAiApp(REQUEST_ID, NONCE));
    expect(loc.searchParams.get('iss')).toBe(ORIGIN);
  });

  it('a null state sends no state parameter', async () => {
    mockRpc.mockResolvedValue({ data: decisionOk(null), error: null });
    const loc = locationOf(await approveAiApp(REQUEST_ID, NONCE));
    expect(loc.searchParams.has('state')).toBe(false);
    expect([...loc.searchParams.keys()]).toEqual(['code', 'iss']);
  });

  it.each([
    'https://callback.example.test/cb?x=1',
    'https://callback.example.test/cb?',
    'https://callback.example.test/cb#f',
    'https://user@callback.example.test/cb',
    'http://callback.example.test/cb',
  ])('a stored redirect_uri %s gives no Location', async (uri) => {
    mockRpc.mockResolvedValue({ data: decisionOk('s', uri), error: null });
    const r = await approveAiApp(REQUEST_ID, NONCE);
    expect(r).toEqual({ kind: 'refused', message: expect.any(String) });
    expect(JSON.stringify(r)).not.toContain('kpr_ac_');
  });
});

describe('denyAiApp', () => {
  it('sends request id, binding digest and nonce; Location has error=access_denied, state and iss, no code', async () => {
    mockRpc.mockResolvedValue({ data: decisionOk('state-4238'), error: null });
    const r = await denyAiApp(REQUEST_ID, NONCE);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe('mcp_authorize_deny');
    expect(args).toEqual({
      p_request_id: REQUEST_ID,
      p_browser_binding_sha256: bindingDigest(BINDING),
      p_nonce: NONCE,
    });
    const loc = locationOf(r);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT_URI);
    expect([...loc.searchParams.entries()]).toEqual([
      ['error', 'access_denied'],
      ['state', 'state-4238'],
      ['iss', ORIGIN],
    ]);
  });

  it('a null state sends no state parameter', async () => {
    mockRpc.mockResolvedValue({ data: decisionOk(null), error: null });
    const loc = locationOf(await denyAiApp(REQUEST_ID, NONCE));
    expect([...loc.searchParams.keys()]).toEqual(['error', 'iss']);
  });

  it.each(['https://callback.example.test/cb?x=1', 'http://callback.example.test/cb'])(
    'a stored redirect_uri %s gives no Location',
    async (uri) => {
      mockRpc.mockResolvedValue({ data: decisionOk('s', uri), error: null });
      expect(await denyAiApp(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: expect.any(String) });
    }
  );
});

describe.each([
  ['approveAiApp', approveAiApp],
  ['denyAiApp', denyAiApp],
] as const)('%s checks before any database call', (_name, action) => {
  it('MCP off → turned-off message, no rpc, no header read', async () => {
    clearMcpEnv();
    expect(await action(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: M_C.disabled });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['support-session cookie', `impersonation_session=x; ${BIND_COOKIE}`],
    ['support-session cookie with an empty value', `impersonation_session=; ${BIND_COOKIE}`],
  ])('%s → support-session message, no rpc', async (_label, header) => {
    mockCookieHeader = header;
    expect(await action(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: M_C.supportSession });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['no binding cookie', 'other=1'],
    ['no cookie header', null],
    ['two binding cookies', `${BIND_COOKIE}; ${BIND_COOKIE}`],
    ['a malformed binding cookie', '__Host-kpr_mcp_bind=kpr_bd_short'],
  ])('%s → different-browser message, no rpc', async (_label, header) => {
    mockCookieHeader = header;
    expect(await action(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: M_C.noBinding });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['a number request id', [42, NONCE]],
    ['a short request id', ['A'.repeat(21), NONCE]],
    ['a number nonce', [REQUEST_ID, 7]],
    ['a 42-character nonce', [REQUEST_ID, 'N'.repeat(42)]],
    ['a nonce with a character outside base64url', [REQUEST_ID, `${'N'.repeat(42)}=`]],
    ['an object nonce', [REQUEST_ID, { nonce: NONCE }]],
    ['one argument', [REQUEST_ID]],
    ['a third argument', [REQUEST_ID, NONCE, 'https://callback.example.test/other']],
  ])('%s → refused, no rpc', async (_label, args) => {
    const r = await (action as (...a: unknown[]) => Promise<unknown>)(...(args as unknown[]));
    expect(r).toEqual({ kind: 'refused', message: M_C.failed });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('pepper missing → not-available message, no rpc', async () => {
    delete process.env.MCP_TOKEN_PEPPER;
    expect(await action(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: M_C.misconfigured });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('transport failure → fixed message', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { name: 'PostgrestError', code: 'PGRST202', message: 'x' } });
    expect(await action(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: M_C.failed });
  });

  it.each([
    ['an extra key', { ...decisionOk(), extra: 1 }],
    ['ok as a string', { ...decisionOk(), ok: 'true' }],
    ['a number state', { ...decisionOk(), state: 5 }],
    ['an unknown refusal code', refused('something_else')],
    ['a refusal with an extra key', { ok: false, error: 'request_invalid', detail: 'x' }],
  ])('a malformed answer (%s) → fixed message', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null });
    expect(await action(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: M_C.failed });
  });
});

describe('refusal codes map to fixed messages; no database text is returned', () => {
  it.each([
    ['request_invalid', M_C.requestInvalid],
    ['not_signed_in', M_C.sessionEnded],
    ['impersonating', M_C.supportSession],
    ['disabled', M_C.disabled],
    ['not_entitled', M_C.notEntitled],
    ['invalid_request', M_C.failed],
  ])('approve %s', async (code, message) => {
    mockRpc.mockResolvedValue({ data: refused(code), error: null });
    const r = await approveAiApp(REQUEST_ID, NONCE);
    expect(r).toEqual({ kind: 'refused', message });
    expect(JSON.stringify(r)).not.toContain(code);
  });

  it.each([
    ['request_invalid', M_C.requestInvalid],
    ['not_signed_in', M_C.sessionEnded],
    ['impersonating', M_C.supportSession],
  ])('deny %s', async (code, message) => {
    mockRpc.mockResolvedValue({ data: refused(code), error: null });
    expect(await denyAiApp(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message });
  });

  it.each(['disabled', 'not_entitled'])('deny does not accept the approve-only code %s', async (code) => {
    mockRpc.mockResolvedValue({ data: refused(code), error: null });
    expect(await denyAiApp(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: M_C.failed });
  });

  it('a second approve after an ok one gets the expired-or-used message', async () => {
    mockRpc.mockResolvedValueOnce({ data: decisionOk(), error: null });
    mockRpc.mockResolvedValueOnce({ data: refused('request_invalid'), error: null });
    expect(await approveAiApp(REQUEST_ID, NONCE)).toMatchObject({ kind: 'redirect' });
    expect(await approveAiApp(REQUEST_ID, NONCE)).toEqual({ kind: 'refused', message: M_C.requestInvalid });
  });
});

describe('log lines', () => {
  it('no line from approve, deny or a refusal carries the code, nonce, request id, binding, redirect or state', async () => {
    mockRpc.mockResolvedValueOnce({ data: decisionOk('state-4238'), error: null });
    const ok = await approveAiApp(REQUEST_ID, NONCE);
    const code = locationOf(ok).searchParams.get('code')!;
    mockRpc.mockResolvedValueOnce({ data: decisionOk('state-4238'), error: null });
    await denyAiApp(REQUEST_ID, NONCE);
    mockRpc.mockResolvedValueOnce({ data: refused('not_entitled'), error: null });
    await approveAiApp(REQUEST_ID, NONCE);
    const lines = logs.lines();
    expect(lines.length).toBe(3);
    for (const needle of [code, NONCE, REQUEST_ID, BINDING, REDIRECT_URI, 'callback.example', 'state-4238']) {
      expect(lines.filter((l) => l.includes(needle))).toEqual([]);
    }
    expect(lines[0]).toContain('"route":"consent"');
  });
});

describe('the consent actions write no cookie and revalidate nothing', () => {
  const src = readFileSync(path.resolve(__dirname, '../../../lib/mcp/account/actions.ts'), 'utf8');
  const decide = src.slice(src.indexOf('async function decide('), src.indexOf('export async function approveAiApp'));

  it('positive: the section read is the shared approve/deny body', () => {
    expect(decide).toContain('approveRequest(');
    expect(decide).toContain('denyRequest(');
  });

  it.each(['cookies(', '.set(', '.delete(', 'revalidatePath', 'revalidateTag'])('contains no %s', (needle) => {
    expect(decide).not.toContain(needle);
  });

  it('approve and deny revalidate nothing at run time', async () => {
    mockRpc.mockResolvedValue({ data: decisionOk(), error: null });
    await approveAiApp(REQUEST_ID, NONCE);
    await denyAiApp(REQUEST_ID, NONCE);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe('disconnectAiApp', () => {
  it('sends p_connection_id and revalidates the AI apps page', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true }, error: null });
    expect(await disconnectAiApp(CONNECTION_ID)).toEqual({ ok: true });
    expect(mockRpc.mock.calls).toEqual([['mcp_disconnect', { p_connection_id: CONNECTION_ID }]]);
    expect(mockRevalidatePath).toHaveBeenCalledWith('/dashboard/account/ai-apps');
  });

  it.each([
    ['a non-uuid', ['not-a-uuid']],
    ['a uuid with a trailing space', [`${CONNECTION_ID} `]],
    ['a number', [5]],
    ['no argument', []],
    ['two arguments', [CONNECTION_ID, CONNECTION_ID]],
  ])('%s → refused, no rpc', async (_label, args) => {
    const r = await (disconnectAiApp as (...a: unknown[]) => Promise<unknown>)(...(args as unknown[]));
    expect(r).toEqual({ ok: false, message: M_A.disconnectFailed });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('support-session cookie → refused, no rpc', async () => {
    mockCookieHeader = 'impersonation_session=x';
    expect(await disconnectAiApp(CONNECTION_ID)).toEqual({ ok: false, message: M_A.supportSession });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('MCP off → refused, no rpc', async () => {
    clearMcpEnv();
    expect(await disconnectAiApp(CONNECTION_ID)).toEqual({ ok: false, message: M_C.disabled });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['transport', { data: null, error: { name: 'PostgrestError' } }],
    ['an extra key', { data: { ok: true, n: 1 }, error: null }],
    ['not_signed_in', { data: refused('not_signed_in'), error: null }],
  ])('%s → failure message, no revalidate', async (_label, res) => {
    mockRpc.mockResolvedValue(res);
    expect(await disconnectAiApp(CONNECTION_ID)).toEqual({ ok: false, message: M_A.disconnectFailed });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});

describe('disconnectAllAiApps', () => {
  it('calls mcp_disconnect_all_mine with no arguments and revalidates', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, disconnected: 2 }, error: null });
    expect(await disconnectAllAiApps()).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0]).toEqual(['mcp_disconnect_all_mine']);
    expect(mockRevalidatePath).toHaveBeenCalledWith('/dashboard/account/ai-apps');
  });

  it('support-session cookie → refused, no rpc', async () => {
    mockCookieHeader = 'impersonation_session=x';
    expect(await disconnectAllAiApps()).toEqual({ ok: false, message: M_A.supportSession });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('MCP off → refused, no rpc', async () => {
    clearMcpEnv();
    expect(await disconnectAllAiApps()).toEqual({ ok: false, message: M_C.disabled });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('an argument → refused, no rpc', async () => {
    expect(await (disconnectAllAiApps as (...a: unknown[]) => Promise<unknown>)('x')).toEqual({
      ok: false,
      message: M_A.disconnectFailed,
    });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['impersonating', refused('impersonating'), M_A.supportSession],
    ['not_signed_in', refused('not_signed_in'), M_A.disconnectFailed],
    ['a missing count', { ok: true }, M_A.disconnectFailed],
  ])('%s → fixed message', async (_label, data, message) => {
    mockRpc.mockResolvedValue({ data, error: null });
    expect(await disconnectAllAiApps()).toEqual({ ok: false, message });
  });
});

describe('MCP off: no action reaches the database', () => {
  it('all four', async () => {
    clearMcpEnv();
    await approveAiApp(REQUEST_ID, NONCE);
    await denyAiApp(REQUEST_ID, NONCE);
    await disconnectAiApp(CONNECTION_ID);
    await disconnectAllAiApps();
    expect(mcpCalls()).toEqual([]);
  });
});
