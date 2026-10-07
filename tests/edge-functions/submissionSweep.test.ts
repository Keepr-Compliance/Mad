/**
 * @jest-environment node
 *
 * BACKLOG-3726: submission-sweep Edge Function handler.
 *
 * Lives under tests/ (not supabase/functions/**) because jest's CI testMatch
 * runs <rootDir>/tests/** and does not run supabase/functions/**.
 * fetch is injected and fully mocked: no network.
 *
 * The claim / finish / storage response shapes are transcribed from the local
 * stack run recorded in supabase/tests/backlog-3726/live/ (ids replaced).
 */

import {
  handleRequest,
  parseDsn,
  resetWebhookSecretCache,
  timingSafeEqual,
  WEBHOOK_SECRET_HEADER,
  type HandlerDeps,
} from '../../supabase/functions/submission-sweep/handler';

const SECRET = 'b'.repeat(64);
// pii-allow-uuid: invented test ids, not from any live row
const RUN_ID = '0a0a0a0a-1111-4222-8333-444444444444';
const SUB_A = '5b5b5b5b-1111-4222-8333-000000000001'; // pii-allow-uuid: invented test id
const SUB_B = '5b5b5b5b-1111-4222-8333-000000000002'; // pii-allow-uuid: invented test id
const ORG = '0e0e0e0e-1111-4222-8333-000000000001'; // pii-allow-uuid: invented test id
const PATH_A1 = `${ORG}/${SUB_A}/loc1/contract.pdf`;
const PATH_A2 = `${ORG}/${SUB_A}/loc2/photo.jpg`;
const PATH_B1 = `${ORG}/${SUB_B}/loc1/inspection.pdf`;
const ORPHAN = `${ORG}/5b5b5b5b-1111-4222-8333-0000000000ff/loc/old.pdf`; // pii-allow-uuid: invented test id

// Shape of public.submission_sweep_claim(false) on the local stack (live run L3b).
const CLAIM = {
  run_id: RUN_ID,
  dry_run: false,
  fenced_now: 1,
  would_fence: 0,
  submissions: [
    { id: SUB_A, reason: 'stalled', paths: [PATH_A1, PATH_A2] },
    { id: SUB_B, reason: 'abandoned', paths: [PATH_B1] },
  ],
  orphans: [ORPHAN],
  unreferenced_in_live_submissions: 0,
  referenced_as_parent: 0,
};

type Call = { url: string; method: string; body: string; headers: Record<string, string> };

function makeDeps(opts: {
  env?: Record<string, string | undefined>;
  failRemoveFor?: string;
  claimStatus?: number;
  finishStatus?: number;
  claim?: unknown;
} = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: 'https://proj.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    SENTRY_DSN: 'https://pubkey@o1.ingest.sentry.test/42',
    ...opts.env,
  };
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method: init?.method ?? 'GET', body, headers: (init?.headers ?? {}) as Record<string, string> });
    const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (url.endsWith('/rpc/submission_sweep_secret')) return ok(SECRET);
    if (url.endsWith('/rpc/submission_sweep_claim')) {
      return opts.claimStatus ? ok({ message: `BODYMARKER ${PATH_A1}` }, opts.claimStatus) : ok(opts.claim ?? CLAIM);
    }
    if (url.endsWith('/rpc/submission_sweep_finish')) {
      if (opts.finishStatus) return ok({ message: `BODYMARKER ${PATH_A1}` }, opts.finishStatus);
      const ids = JSON.parse(body).p_submission_ids as string[];
      return ok({ rows_deleted: ids.length, rows_kept: 0 });
    }
    if (url.includes('/storage/v1/object/submission-attachments')) {
      const names = JSON.parse(body).prefixes as string[];
      if (opts.failRemoveFor && names.some((n) => n.includes(opts.failRemoveFor!))) {
        return ok({ error: `STORAGEMARKER ${names[0]}` }, 500);
      }
      return ok(names.map((name) => ({ name, bucket_id: 'submission-attachments' })));
    }
    if (url.includes('sentry.test')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  const deps: HandlerDeps = {
    getEnv: (n) => env[n],
    fetch: fetchMock as unknown as typeof fetch,
    uuid: () => '9c9c9c9c-1111-4222-8333-000000000001', // pii-allow-uuid: invented test id
    sleep: jest.fn(async () => undefined),
    log: (l) => logs.push(l),
  };
  return { deps, calls, logs };
}

function post(body: unknown = {}, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers[WEBHOOK_SECRET_HEADER] = secret;
  return new Request('https://fn.test/submission-sweep', { method: 'POST', headers, body: JSON.stringify(body) });
}

const claimArgs = (calls: Call[]) => JSON.parse(calls.find((c) => c.url.endsWith('/rpc/submission_sweep_claim'))!.body);
const finishArgs = (calls: Call[]) => {
  const c = calls.filter((x) => x.url.endsWith('/rpc/submission_sweep_finish')).pop();
  return c ? JSON.parse(c.body) : undefined;
};
const removes = (calls: Call[]) => calls.filter((c) => c.url.includes('/storage/v1/object/'));
const sentry = (calls: Call[]) => calls.filter((c) => c.url.includes('sentry.test')).map((c) => c.body);
const SENSITIVE = [SUB_A, SUB_B, PATH_A1, PATH_A2, PATH_B1, ORPHAN, 'contract.pdf', 'BODYMARKER', 'STORAGEMARKER'];

beforeEach(() => resetWebhookSecretCache());

describe('authentication', () => {
  it('rejects a missing or wrong secret with 401 and never claims', async () => {
    for (const secret of [null, 'c'.repeat(64), SECRET.slice(0, 63)]) {
      const { deps, calls } = makeDeps({ env: { SUBMISSION_SWEEP_MODE: 'live' } });
      const res = await handleRequest(post({}, secret), deps);
      expect(res.status).toBe(401);
      expect(calls.some((c) => c.url.includes('submission_sweep_claim'))).toBe(false);
    }
  });
  it('rejects non-POST', async () => {
    const { deps } = makeDeps();
    const res = await handleRequest(new Request('https://fn.test/x', { method: 'GET' }), deps);
    expect(res.status).toBe(405);
  });
  it('timingSafeEqual compares whole strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('mode', () => {
  it('is a dry run when SUBMISSION_SWEEP_MODE is unset: claims dry, removes nothing, finishes no id', async () => {
    const { deps, calls } = makeDeps();
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(200);
    expect(claimArgs(calls)).toEqual({ p_dry_run: true });
    expect(removes(calls)).toHaveLength(0);
    expect(finishArgs(calls).p_submission_ids).toEqual([]);
  });
  it('is a dry run for any value other than exactly "live"', async () => {
    for (const v of ['LIVE', 'true', 'live ', '1']) {
      const { deps, calls } = makeDeps({ env: { SUBMISSION_SWEEP_MODE: v } });
      await handleRequest(post(), deps);
      expect(claimArgs(calls)).toEqual({ p_dry_run: true });
    }
  });
  it('a request body cannot make a run live', async () => {
    const { deps, calls } = makeDeps();
    await handleRequest(post({ dry_run: false, mode: 'live' }), deps);
    expect(claimArgs(calls)).toEqual({ p_dry_run: true });
    expect(removes(calls)).toHaveLength(0);
  });
  it('a request body can downgrade a live environment to a dry run', async () => {
    const { deps, calls } = makeDeps({ env: { SUBMISSION_SWEEP_MODE: 'live' } });
    await handleRequest(post({ dry_run: true }), deps);
    expect(claimArgs(calls)).toEqual({ p_dry_run: true });
    expect(removes(calls)).toHaveLength(0);
  });
});

describe('live run', () => {
  it('removes exact names, then finishes only after every remove for that submission resolved', async () => {
    const { deps, calls } = makeDeps({ env: { SUBMISSION_SWEEP_MODE: 'live' } });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(200);
    const rm = removes(calls).map((c) => JSON.parse(c.body).prefixes);
    expect(rm).toEqual([[PATH_A1, PATH_A2], [PATH_B1], [ORPHAN]]);
    const finishIdx = calls.findIndex((c) => c.url.endsWith('/rpc/submission_sweep_finish'));
    const lastRemoveIdx = calls.map((c) => c.url.includes('/storage/v1/object/')).lastIndexOf(true);
    expect(finishIdx).toBeGreaterThan(lastRemoveIdx);
    expect(finishArgs(calls)).toMatchObject({ p_run_id: RUN_ID, p_submission_ids: [SUB_A, SUB_B], p_outcome: 'ok' });
    expect(finishArgs(calls).p_counts).toMatchObject({ objects_removed: 3, orphans_removed: 1, fenced: 1 });
  });
  it('a failed remove leaves that submission out of finish and marks the run partial', async () => {
    const { deps, calls } = makeDeps({ env: { SUBMISSION_SWEEP_MODE: 'live' }, failRemoveFor: 'photo.jpg' });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(200);
    expect(finishArgs(calls).p_submission_ids).toEqual([SUB_B]);
    expect(finishArgs(calls).p_outcome).toBe('partial');
    expect(finishArgs(calls).p_counts.remove_errors).toBe(1);
    expect(sentry(calls).some((b) => b.includes('"type":"event"'))).toBe(true);
  });
  it('splits a submission with more than 100 paths into chunks of 100', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `${ORG}/${SUB_A}/l${i}/f.pdf`);
    const { deps, calls } = makeDeps({
      env: { SUBMISSION_SWEEP_MODE: 'live' },
      claim: { ...CLAIM, submissions: [{ id: SUB_A, reason: 'stalled', paths: many }], orphans: [] },
    });
    await handleRequest(post(), deps);
    expect(removes(calls).map((c) => JSON.parse(c.body).prefixes.length)).toEqual([100, 100, 50]);
  });
});

describe('counts only', () => {
  it('log line, response, run counts and Sentry payloads never carry an id, path, file name or response body', async () => {
    for (const opts of [
      { env: { SUBMISSION_SWEEP_MODE: 'live' } },
      { env: { SUBMISSION_SWEEP_MODE: 'live' }, failRemoveFor: 'photo.jpg' },
      { env: { SUBMISSION_SWEEP_MODE: 'live' }, claimStatus: 500 },
      { env: { SUBMISSION_SWEEP_MODE: 'live' }, finishStatus: 503 },
    ]) {
      const { deps, calls, logs } = makeDeps(opts);
      const res = await handleRequest(post(), deps);
      const text = await res.text();
      const blobs = [text, ...logs, ...sentry(calls), JSON.stringify(finishArgs(calls)?.p_counts ?? {})];
      for (const b of blobs) for (const s of SENSITIVE) expect(b).not.toContain(s);
    }
  });
});

describe('failures', () => {
  it('a claim error returns 500 with stage and status, reports to Sentry, removes nothing', async () => {
    const { deps, calls } = makeDeps({ env: { SUBMISSION_SWEEP_MODE: 'live' }, claimStatus: 500 });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ outcome: 'failed', stage: 'claim', status: 500 });
    expect(removes(calls)).toHaveLength(0);
    const ev = sentry(calls).find((b) => b.includes('"type":"event"'))!;
    expect(ev).toContain('"stage":"claim"');
  });
  it('a finish error closes the run as failed and sends an error check-in', async () => {
    const { deps, calls } = makeDeps({ env: { SUBMISSION_SWEEP_MODE: 'live' }, finishStatus: 503 });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(500);
    expect(finishArgs(calls).p_outcome).toBe('failed');
    expect(sentry(calls).some((b) => b.includes('"status":"error"') && b.includes('"monitor_slug":"submission-sweep"'))).toBe(true);
  });
  it('sends in_progress then ok check-ins on a clean run', async () => {
    const { deps, calls } = makeDeps();
    await handleRequest(post(), deps);
    const statuses = sentry(calls).map((b) => JSON.parse(b.split('\n')[2]).status);
    expect(statuses).toEqual(['in_progress', 'ok']);
  });
  it('runs without Sentry when no DSN is set', async () => {
    const { deps, calls } = makeDeps({ env: { SENTRY_DSN: undefined } });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(200);
    expect(sentry(calls)).toHaveLength(0);
  });
});

describe('local delay hook', () => {
  it('is honoured only against a local stack', async () => {
    const local = makeDeps({ env: { SUPABASE_URL: 'http://kong:8000', SUBMISSION_SWEEP_TEST_DELAY_MS: '8000' } });
    await handleRequest(post(), local.deps);
    expect(local.deps.sleep).toHaveBeenCalledWith(8000);
    const prod = makeDeps({ env: { SUBMISSION_SWEEP_TEST_DELAY_MS: '8000' } });
    await handleRequest(post(), prod.deps);
    expect(prod.deps.sleep).not.toHaveBeenCalled();
  });
});

describe('parseDsn', () => {
  it('builds the envelope endpoint and rejects anything else', () => {
    expect(parseDsn('https://k@o1.ingest.sentry.io/123')).toEqual({
      endpoint: 'https://o1.ingest.sentry.io/api/123/envelope/',
      auth: 'Sentry sentry_version=7, sentry_key=k, sentry_client=keepr-submission-sweep/1.0',
    });
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn('http://k@host/1')).toBeNull();
  });
});
