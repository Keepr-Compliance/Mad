/**
 * @jest-environment node
 *
 * BACKLOG-4263 PR-10.8: GET /api/cron/ai-app-notices and the drain behind it.
 * The service client and sendEmail are mocked at the module boundary; nothing reaches a network.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ADDRESS_A,
  ADDRESS_B,
  MISSING_CLAIM_FUNCTION,
  NOTICE_A,
  NOTICE_B,
  UNDEFINED_FUNCTION_42883,
  USER_A,
  USER_B,
  USER_NOT_FOUND,
  claimRow,
  type ClaimRow,
} from './fixtures';

type Answer = { data: unknown; error: unknown };

interface Db {
  claim: Answer;
  done: Answer | ((args: Record<string, unknown>) => Answer);
  users: Record<string, Answer | (() => never)>;
  log: Answer | (() => never);
  rpcCalls: Array<[string, Record<string, unknown>]>;
  logFilters: unknown[][];
  getUserCalls: string[];
}

let db: Db;
const mockSend = jest.fn();

function freshDb(): Db {
  return {
    claim: { data: [], error: null },
    done: { data: true, error: null },
    users: {},
    log: { data: [], error: null },
    rpcCalls: [],
    logFilters: [],
    getUserCalls: [],
  };
}

const mockService = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    db.rpcCalls.push([fn, args]);
    if (fn === 'ai_app_notice_claim') return db.claim;
    if (fn === 'ai_app_notice_done') return typeof db.done === 'function' ? db.done(args) : db.done;
    return { data: null, error: { code: 'PGRST202' } };
  },
  from: (table: string) => {
    const filters: unknown[][] = [['from', table]];
    db.logFilters.push(filters);
    const chain = {
      select: (...a: unknown[]) => (filters.push(['select', ...a]), chain),
      eq: (...a: unknown[]) => (filters.push(['eq', ...a]), chain),
      in: (...a: unknown[]) => (filters.push(['in', ...a]), chain),
      limit: async (...a: unknown[]) => {
        filters.push(['limit', ...a]);
        if (typeof db.log === 'function') return db.log();
        return db.log;
      },
    };
    return chain;
  },
  auth: {
    admin: {
      getUserById: async (id: string) => {
        db.getUserCalls.push(id);
        const u = db.users[id];
        if (typeof u === 'function') return u();
        return u ?? { data: { user: null }, error: USER_NOT_FOUND };
      },
    },
  },
};

jest.mock('@/lib/supabase/service', () => ({ createServiceClient: () => mockService }));
jest.mock('@/lib/email/send-email', () => ({ sendEmail: (...a: unknown[]) => mockSend(...a) }));

import { GET } from '@/app/api/cron/ai-app-notices/route';

const SECRET = 'cron-secret-value';
const ORIGINAL_SECRET = process.env.CRON_SECRET;
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function req(auth: string | null = `Bearer ${SECRET}`, headers: Record<string, string> = {}): Request {
  return new Request('https://x/api/cron/ai-app-notices', {
    method: 'GET',
    headers: { ...(auth !== null ? { authorization: auth } : {}), ...headers },
  });
}

function user(email: string | null | undefined, extra: Record<string, unknown> = {}): Answer {
  return { data: { user: { id: 'u', email, ...extra } }, error: null };
}

function claim(rows: unknown) {
  db.claim = { data: rows, error: null };
}

function doneCalls() {
  return db.rpcCalls.filter(([fn]) => fn === 'ai_app_notice_done').map(([, a]) => a);
}

async function run(r: Request = req()) {
  const res = await GET(r);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

let logs: unknown[][];

beforeEach(() => {
  db = freshDb();
  mockSend.mockReset();
  mockSend.mockResolvedValue({ success: true, outcome: 'sent' });
  process.env.CRON_SECRET = SECRET;
  process.env.NEXT_PUBLIC_APP_URL = 'https://portal.example.test';
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    jest.spyOn(console, level).mockImplementation((...a: unknown[]) => void logs.push(a));
  }
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
});

describe('authorization', () => {
  it.each([
    ['no header', null],
    ['wrong secret', 'Bearer wrong'],
    ['bare secret', SECRET],
  ])('%s -> 401, no database call, nothing sent', async (_l, auth) => {
    claim([claimRow()]);
    db.users[USER_A] = user(ADDRESS_A);
    const { res, body } = await run(req(auth));
    expect(res.status).toBe(401);
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(db.rpcCalls).toHaveLength(0);
    expect(db.getUserCalls).toHaveLength(0);
    expect(db.logFilters).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('no CRON_SECRET configured -> 401 even with "Bearer undefined"', async () => {
    delete process.env.CRON_SECRET;
    claim([claimRow()]);
    const { res } = await run(req('Bearer undefined'));
    expect(res.status).toBe(401);
    expect(db.rpcCalls).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('claim', () => {
  it('claims 20 with ai_app_notice_claim; an empty answer is 200 with zero counts', async () => {
    const { res, body } = await run();
    expect(res.status).toBe(200);
    expect(db.rpcCalls).toEqual([['ai_app_notice_claim', { p_limit: 20 }]]);
    expect(body).toEqual({ claimed: 0, sent: 0, queued: 0, skipped: 0, failed: 0 });
  });

  it.each([
    ['PGRST202 (PostgREST, function not in the schema cache)', MISSING_CLAIM_FUNCTION],
    ['42883 (undefined function)', UNDEFINED_FUNCTION_42883],
    ['any other error', { code: 'P0001', message: 'Unauthorized' }],
  ])('%s -> 200, nothing sent, done never called', async (_l, error) => {
    db.claim = { data: null, error };
    const { res, body } = await run();
    expect(res.status).toBe(200);
    expect(body).toEqual({ claimed: 0, sent: 0, queued: 0, skipped: 0, failed: 0 });
    expect(mockSend).not.toHaveBeenCalled();
    expect(doneCalls()).toHaveLength(0);
    expect(db.getUserCalls).toHaveLength(0);
  });

  it('a missing function is logged with its own code', async () => {
    db.claim = { data: null, error: MISSING_CLAIM_FUNCTION };
    await run();
    expect(logs.flat()).toContain('[cron/ai-app-notices] claim_missing_function');
  });

  const { id: _drop, ...noId } = claimRow();
  const malformed: Array<[string, unknown]> = [
    ['null', null],
    ['an object, not an array', claimRow()],
    ['an extra key', [{ ...claimRow(), email: ADDRESS_A }]],
    ['a missing key', [noId]],
    ['an unknown provider', [claimRow({ provider: 'google' as never })]],
    ['replaced as a string', [{ ...claimRow(), replaced: 'false' }]],
    ['attempts as a string', [{ ...claimRow(), attempts: '1' }]],
    ['attempts 0', [claimRow({ attempts: 0 })]],
    ['attempts not an integer', [claimRow({ attempts: 1.5 })]],
    ['an id that is not a uuid', [claimRow({ id: 'not-a-uuid' })]],
    ['a user_id that is not a uuid', [claimRow({ user_id: '../admin' })]],
    ['connected_at not a time', [claimRow({ connected_at: 'yesterday' })]],
    ['connected_at a number', [{ ...claimRow(), connected_at: 1 }]],
    ['an element that is an array', [[NOTICE_A]]],
    ['one bad element among good ones', [claimRow(), { ...claimRow({ id: NOTICE_B }), provider: 'x' }]],
    ['more rows than asked for', Array.from({ length: 21 }, () => claimRow())],
  ];
  it.each(malformed)('malformed answer (%s) -> nothing sent, done never called', async (_l, data) => {
    claim(data);
    db.users[USER_A] = user(ADDRESS_A);
    const { res, body } = await run();
    expect(res.status).toBe(200);
    expect(body).toEqual({ claimed: 0, sent: 0, queued: 0, skipped: 0, failed: 0 });
    expect(mockSend).not.toHaveBeenCalled();
    expect(doneCalls()).toHaveLength(0);
    expect(db.getUserCalls).toHaveLength(0);
    expect(logs.flat()).toContain('[cron/ai-app-notices] claim_answer_invalid');
  });
});

describe('one notice', () => {
  it('sends to the address of getUserById(row.user_id), with the notice id in the log metadata only', async () => {
    claim([claimRow({ provider: 'openai', replaced: true })]);
    db.users[USER_A] = user(ADDRESS_A, { new_email: ADDRESS_B, user_metadata: { email: ADDRESS_B } });
    const { body } = await run();
    expect(db.getUserCalls).toEqual([USER_A]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0];
    expect(arg.to).toBe(ADDRESS_A);
    expect(arg.emailType).toBe('other');
    expect(arg.logMetadata).toEqual({ kind: 'ai_app_connected', notice_id: NOTICE_A });
    expect(arg.subject).toBe('ChatGPT was connected to your Keepr account');
    expect(arg.text).toContain('This replaces your earlier ChatGPT connection.');
    expect(arg.text).toContain('Open AI apps: https://portal.example.test/dashboard/account/ai-apps');
    for (const part of [arg.subject, arg.html, arg.text]) {
      expect(part).not.toContain(NOTICE_A);
      expect(part).not.toContain(USER_A);
    }
    expect(body).toEqual({ claimed: 1, sent: 1, queued: 0, skipped: 0, failed: 0 });
  });

  it('the button origin is NEXT_PUBLIC_APP_URL, never the request host', async () => {
    claim([claimRow()]);
    db.users[USER_A] = user(ADDRESS_A);
    await run(req(`Bearer ${SECRET}`, { host: 'evil.example', 'x-forwarded-host': 'evil.example' }));
    expect(mockSend.mock.calls[0][0].text).toContain('Open AI apps: https://portal.example.test/dashboard/account/ai-apps');
    expect(mockSend.mock.calls[0][0].html).not.toContain('evil.example');
  });

  it('without NEXT_PUBLIC_APP_URL the button uses the production portal', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    claim([claimRow()]);
    db.users[USER_A] = user(ADDRESS_A);
    await run();
    expect(mockSend.mock.calls[0][0].text).toContain('Open AI apps: https://app.keeprcompliance.com/dashboard/account/ai-apps');
  });

  it.each([
    ['sent', { success: true, outcome: 'sent' }, 'sent', null, 'sent'],
    ['queued', { success: false, outcome: 'queued' }, 'queued', null, 'queued'],
    ['failed', { success: false, outcome: 'failed', error: 'Graph said: mailbox x@y full' }, 'due', 'send_failed', 'failed'],
    ['skipped (mail not configured)', { success: false, outcome: 'skipped' }, 'skipped', 'email_not_configured', 'skipped'],
    ['no outcome, success', { success: true }, 'sent', null, 'sent'],
    ['no outcome, failure', { success: false }, 'due', 'send_failed', 'failed'],
  ])('send %s -> done(%s)', async (_l, result, status, code, count) => {
    claim([claimRow({ attempts: 3 })]);
    db.users[USER_A] = user(ADDRESS_A);
    mockSend.mockResolvedValue(result);
    const { body } = await run();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(doneCalls()).toEqual([{ p_id: NOTICE_A, p_attempts: 3, p_status: status, p_error: code }]);
    expect(body).toEqual({ claimed: 1, sent: 0, queued: 0, skipped: 0, failed: 0, [count as string]: 1 });
  });

  it.each([
    ['no user (null user, no error)', { data: { user: null }, error: null }],
    ['no user (404 user_not_found)', { data: { user: null }, error: USER_NOT_FOUND }],
    ['an empty address', user('')],
    ['a blank address', user('   ')],
    ['no address field', user(undefined)],
    ['a null address', user(null)],
  ])('%s -> skipped no_address, nothing sent', async (_l, answer) => {
    claim([claimRow({ attempts: 2 })]);
    db.users[USER_A] = answer;
    const { body } = await run();
    expect(mockSend).not.toHaveBeenCalled();
    expect(db.logFilters).toHaveLength(0);
    expect(doneCalls()).toEqual([{ p_id: NOTICE_A, p_attempts: 2, p_status: 'skipped', p_error: 'no_address' }]);
    expect(body).toEqual({ claimed: 1, sent: 0, queued: 0, skipped: 1, failed: 0 });
  });

  it('a user lookup error (not a missing user) -> due user_lookup_failed, nothing sent', async () => {
    claim([claimRow()]);
    db.users[USER_A] = { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 503, message: 'x' } };
    const { body } = await run();
    expect(mockSend).not.toHaveBeenCalled();
    expect(doneCalls()).toEqual([{ p_id: NOTICE_A, p_attempts: 1, p_status: 'due', p_error: 'user_lookup_failed' }]);
    expect(body).toEqual({ claimed: 1, sent: 0, queued: 0, skipped: 0, failed: 1 });
  });

  it('every last_error code is at most 40 characters', async () => {
    const { CODES } = await import('@/lib/aiApps/connectNotices');
    for (const c of Object.values(CODES)) expect(c.length).toBeLessThanOrEqual(40);
  });
});

describe('at-least-once: the delivery log is checked before sending', () => {
  it('reads email_delivery_log for this notice id and kind, sent or queued', async () => {
    claim([claimRow()]);
    db.users[USER_A] = user(ADDRESS_A);
    await run();
    expect(db.logFilters).toEqual([
      [
        ['from', 'email_delivery_log'],
        ['select', 'status'],
        ['eq', 'metadata->>kind', 'ai_app_connected'],
        ['eq', 'metadata->>notice_id', NOTICE_A],
        ['in', 'status', ['sent', 'queued']],
        ['limit', 10],
      ],
    ]);
  });

  it.each([
    ['a sent row', [{ status: 'sent' }], 'sent'],
    ['a queued row', [{ status: 'queued' }], 'queued'],
    ['queued then sent', [{ status: 'queued' }, { status: 'sent' }], 'sent'],
  ])('%s already logged -> no second send, done(%s)', async (_l, rows, status) => {
    claim([claimRow({ attempts: 2 })]);
    db.users[USER_A] = user(ADDRESS_A);
    db.log = { data: rows, error: null };
    const { body } = await run();
    expect(mockSend).not.toHaveBeenCalled();
    expect(doneCalls()).toEqual([{ p_id: NOTICE_A, p_attempts: 2, p_status: status, p_error: null }]);
    expect(body).toEqual({ claimed: 1, sent: 0, queued: 0, skipped: 0, failed: 0, [status]: 1 });
  });

  it.each([
    ['an error answer', { data: null, error: { code: '57014' } }],
    ['a throw', () => { throw new Error('network'); }],
  ])('a delivery-log read failure (%s) -> nothing sent, due delivery_log_read_failed', async (_l, answer) => {
    claim([claimRow()]);
    db.users[USER_A] = user(ADDRESS_A);
    db.log = answer as Db['log'];
    const { body } = await run();
    expect(mockSend).not.toHaveBeenCalled();
    expect(doneCalls()).toEqual([{ p_id: NOTICE_A, p_attempts: 1, p_status: 'due', p_error: 'delivery_log_read_failed' }]);
    expect(body).toEqual({ claimed: 1, sent: 0, queued: 0, skipped: 0, failed: 1 });
  });
});

describe('done', () => {
  it('done answering false -> logged as not updated, never a second send', async () => {
    claim([claimRow()]);
    db.users[USER_A] = user(ADDRESS_A);
    db.done = { data: false, error: null };
    const { body } = await run();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(doneCalls()).toHaveLength(1);
    expect(logs).toContainEqual(['[cron/ai-app-notices] status_not_updated', 'sent']);
    expect(body).toEqual({ claimed: 1, sent: 1, queued: 0, skipped: 0, failed: 0 });
  });

  it('done answering an error -> logged by code, never a second send', async () => {
    claim([claimRow()]);
    db.users[USER_A] = user(ADDRESS_A);
    db.done = { data: null, error: { code: '22023', message: 'ai_app_notice_done: unknown status' } };
    await run();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(logs).toContainEqual(['[cron/ai-app-notices] done_error', '22023']);
  });
});

describe('several notices', () => {
  const two = () => [claimRow(), claimRow({ id: NOTICE_B, user_id: USER_B, provider: 'openai', attempts: 4 })];

  it('a user lookup that throws on the first does not stop the second', async () => {
    claim(two());
    db.users[USER_A] = () => {
      throw new Error('socket hang up');
    };
    db.users[USER_B] = user(ADDRESS_B);
    const { res, body } = await run();
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].to).toBe(ADDRESS_B);
    expect(doneCalls()).toEqual([
      { p_id: NOTICE_A, p_attempts: 1, p_status: 'due', p_error: 'user_lookup_failed' },
      { p_id: NOTICE_B, p_attempts: 4, p_status: 'sent', p_error: null },
    ]);
    expect(body).toEqual({ claimed: 2, sent: 1, queued: 0, skipped: 0, failed: 1 });
  });

  it('a send that throws on the first does not stop the second', async () => {
    claim(two());
    db.users[USER_A] = user(ADDRESS_A);
    db.users[USER_B] = user(ADDRESS_B);
    mockSend.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ success: true, outcome: 'sent' });
    const { body } = await run();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(doneCalls()).toEqual([
      { p_id: NOTICE_A, p_attempts: 1, p_status: 'due', p_error: 'send_threw' },
      { p_id: NOTICE_B, p_attempts: 4, p_status: 'sent', p_error: null },
    ]);
    expect(body).toEqual({ claimed: 2, sent: 1, queued: 0, skipped: 0, failed: 1 });
  });

  it('the answer and the logs carry counts and codes only: no address, no id', async () => {
    claim(two());
    db.users[USER_A] = user(ADDRESS_A);
    db.users[USER_B] = user(ADDRESS_B);
    db.done = { data: false, error: null };
    mockSend.mockResolvedValueOnce({ success: false, outcome: 'failed', error: `Graph refused ${ADDRESS_A}` });
    const { body } = await run();
    const text = JSON.stringify(body);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['claimed', 'failed', 'queued', 'sent', 'skipped']);
    const logged = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [ADDRESS_A, ADDRESS_B, NOTICE_A, NOTICE_B, USER_A, USER_B, 'Graph refused']) {
      expect(text).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
  });
});

describe('vercel.json', () => {
  it('has the four existing crons unchanged and one new cron every 5 minutes', () => {
    const cfg = JSON.parse(readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8')) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(cfg.crons).toEqual([
      { path: '/api/cron/payment-reconcile', schedule: '0 3 * * *' },
      { path: '/api/cron/email-retry', schedule: '0 4 * * *' },
      { path: '/api/cron/domain-recheck', schedule: '0 5 * * *' },
      { path: '/api/cron/domain-capture-switch', schedule: '15 * * * *' },
      { path: '/api/cron/ai-app-notices', schedule: '*/5 * * * *' },
    ]);
  });
});
