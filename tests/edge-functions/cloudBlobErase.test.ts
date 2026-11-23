/**
 * @jest-environment node
 *
 * BACKLOG-4263 (sync plan P3): cloud-blob-erase Edge Function handler.
 *
 * Lives under tests/ (not supabase/functions/**) because jest's CI testMatch runs <rootDir>/tests/** and does not
 * run supabase/functions/**. fetch is injected and fully mocked: no network.
 *
 * The claim / finish / scrub answer shapes are taken from the RETURN statements of
 * supabase/migrations/20261123110000_backlog_4263_cloud_blob_erase.sql. They are NOT yet transcribed from a database
 * run: the harness in supabase/tests/backlog-4263-sync2-erase prints the real answers, and these fixtures are to be
 * replaced by those prints once it has run.
 */

import {
  handleRequest,
  parseDsn,
  resetWebhookSecretCache,
  timingSafeEqual,
  SCRUB_BUDGET_MS,
  WEBHOOK_SECRET_HEADER,
  type HandlerDeps,
} from '../../supabase/functions/cloud-blob-erase/handler';

const SECRET = 'e'.repeat(64);
// Ids are opaque to the handler: plain invented strings, not UUIDs.
const RUN_ID = 'run-fixture-1';
const OWNER_A = 'owner-fixture-a';
const OWNER_B = 'owner-fixture-b';
const blob = (n: number) => ({ id: `blob-fixture-${n}`, path: `${OWNER_A}/blob-fixture-${n}` });
const ROWLESS = `${OWNER_B}/object-fixture-1`;

const CLAIM = {
  run_id: RUN_ID,
  dry_run: false,
  counts: { messages_hard_deleted: 0, files_hard_deleted: 0, files_removed_with_message: 0, blobs_fenced_by_delete: 0,
            orphans_fenced: 0, blobs_listed: 2, rowless_listed: 1, scrub_owners: 2 },
  blobs: [blob(1), blob(2)],
  rowless: [ROWLESS],
  scrub_owners: [OWNER_A, OWNER_B],
};

type Call = { url: string; method: string; body: string };

function makeDeps(opts: {
  env?: Record<string, string | undefined>;
  claim?: unknown;
  claimStatus?: number;
  finishStatus?: number;
  failRemoveFor?: string;
  scrub?: (owner: string, call: number) => unknown;
  scrubStatusFor?: string;
  clockStep?: number;
  secret?: () => Response;
} = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  let clock = 0;
  const scrubCalls = new Map<string, number>();
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: 'https://proj.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    SENTRY_DSN: 'https://pubkey@o1.ingest.sentry.test/42',
    ...opts.env,
  };
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, method: init?.method ?? 'GET', body });
    const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (url.endsWith('/rpc/cloud_blob_erase_secret')) return opts.secret ? opts.secret() : ok(SECRET);
    if (url.endsWith('/rpc/cloud_blob_erase_claim')) {
      if (opts.claimStatus) return ok({ message: `BODYMARKER ${blob(1).path}` }, opts.claimStatus);
      return ok(opts.claim ?? CLAIM);
    }
    if (url.endsWith('/rpc/cloud_blob_erase_finish')) {
      if (opts.finishStatus) return ok({ message: `BODYMARKER ${blob(1).path}` }, opts.finishStatus);
      const ids = JSON.parse(body).p_blob_ids as string[];
      return ok({ blob_rows_deleted: ids.length, blob_rows_kept: 0 });
    }
    if (url.endsWith('/rpc/cloud_blob_erase_scrub')) {
      const a = JSON.parse(body);
      const n = (scrubCalls.get(a.p_owner) ?? 0) + 1;
      scrubCalls.set(a.p_owner, n);
      clock += opts.clockStep ?? 0;
      if (opts.scrubStatusFor === a.p_owner) return ok({ message: `BODYMARKER ${a.p_owner}` }, 500);
      if (opts.scrub) return ok(opts.scrub(a.p_owner, n));
      return a.p_dry_run
        ? ok({ state: 'dry_run', scrubbed: 0, would_scrub: 7, more: false })
        : ok({ state: 'scrubbed', scrubbed: 3, files: 1, messages: 2, fenced: 1, more: false });
    }
    if (url.includes('/storage/v1/object/cloud-deal-files')) {
      const names = JSON.parse(body).prefixes as string[];
      if (opts.failRemoveFor && names.some((x) => x.includes(opts.failRemoveFor!))) {
        return ok({ error: `STORAGEMARKER ${names[0]}` }, 500);
      }
      return ok(names.map((name) => ({ name, bucket_id: 'cloud-deal-files' })));
    }
    if (url.includes('sentry.test')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  });
  const deps: HandlerDeps = {
    getEnv: (n) => env[n],
    fetch: fetchMock as unknown as typeof fetch,
    uuid: () => 'check-in-fixture',
    now: () => clock,
    log: (l) => logs.push(l),
  };
  return { deps, calls, logs, scrubCalls };
}

function post(body: unknown = {}, secret: string | null = SECRET): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers[WEBHOOK_SECRET_HEADER] = secret;
  return new Request('https://fn.test/cloud-blob-erase', { method: 'POST', headers, body: JSON.stringify(body) });
}

const rpcArgs = (calls: Call[], fn: string) => calls.filter((c) => c.url.endsWith(`/rpc/${fn}`)).map((c) => JSON.parse(c.body));
const removes = (calls: Call[]) => calls.filter((c) => c.url.includes('/storage/v1/object/'));
const sentry = (calls: Call[]) => calls.filter((c) => c.url.includes('sentry.test')).map((c) => c.body);
const order = (calls: Call[]) =>
  calls.filter((c) => !c.url.includes('sentry.test')).map((c) => (c.url.includes('/storage/') ? 'remove' : c.url.split('/rpc/')[1]));
const SENSITIVE = [OWNER_A, OWNER_B, blob(1).id, blob(1).path, blob(2).path, ROWLESS, 'BODYMARKER', 'STORAGEMARKER'];

beforeEach(() => resetWebhookSecretCache());

describe('authentication', () => {
  it('rejects a missing or wrong secret with 401 and never claims', async () => {
    for (const secret of [null, 'f'.repeat(64), SECRET.slice(0, 63)]) {
      const { deps, calls } = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: 'live' } });
      const res = await handleRequest(post({}, secret), deps);
      expect(res.status).toBe(401);
      expect(calls.some((c) => c.url.includes('cloud_blob_erase_claim'))).toBe(false);
    }
  });
  it('refuses (401, no claim) when the secret cannot be loaded: lookup error, null, empty or under 32 characters', async () => {
    const cases: Array<[string, () => Response]> = [
      ['lookup 500', () => new Response(JSON.stringify({ message: 'x' }), { status: 500 })],
      ['null', () => new Response('null', { status: 200 })],
      ['empty', () => new Response(JSON.stringify(''), { status: 200 })],
      ['31 characters', () => new Response(JSON.stringify('e'.repeat(31)), { status: 200 })],
    ];
    for (const [label, secret] of cases) {
      for (const presented of [SECRET, 'e'.repeat(31), 'anything']) {
        resetWebhookSecretCache();
        const { deps, calls } = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: 'live' }, secret });
        const res = await handleRequest(post({}, presented), deps);
        expect(`${label} ${presented.length}: ${res.status}`).toBe(`${label} ${presented.length}: 401`);
        expect(calls.some((c) => c.url.includes('cloud_blob_erase_claim'))).toBe(false);
      }
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

describe('dry run (the mode the schedule is first applied in)', () => {
  it('is a dry run when CLOUD_BLOB_ERASE_MODE is unset: claims dry, removes nothing, finishes no id, scrubs dry once', async () => {
    const { deps, calls } = makeDeps();
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(200);
    expect(rpcArgs(calls, 'cloud_blob_erase_claim')).toEqual([{ p_dry_run: true }]);
    expect(removes(calls)).toHaveLength(0);
    expect(rpcArgs(calls, 'cloud_blob_erase_finish')[0].p_blob_ids).toEqual([]);
    const scrubs = rpcArgs(calls, 'cloud_blob_erase_scrub');
    expect(scrubs.map((a) => a.p_owner)).toEqual([OWNER_A, OWNER_B]);
    expect(scrubs.every((a) => a.p_dry_run === true)).toBe(true);
    const out = await res.json();
    expect(out).toMatchObject({ outcome: 'ok', mode: 'dry_run', rows_would_scrub: 14, rows_scrubbed: 0, scrub_rounds: 1 });
  });
  it('ignores blob and object lists a dry claim might return', async () => {
    const { deps, calls } = makeDeps({ claim: { ...CLAIM, dry_run: true } });
    await handleRequest(post(), deps);
    expect(removes(calls)).toHaveLength(0);
    expect(rpcArgs(calls, 'cloud_blob_erase_finish')[0].p_blob_ids).toEqual([]);
  });
  it('is a dry run for any value other than exactly "live"', async () => {
    for (const v of ['LIVE', 'true', 'live ', '1', 'dry_run']) {
      const { deps, calls } = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: v } });
      await handleRequest(post(), deps);
      expect(rpcArgs(calls, 'cloud_blob_erase_claim')).toEqual([{ p_dry_run: true }]);
      expect(removes(calls)).toHaveLength(0);
    }
  });
  it('a request body cannot make a run live, but can downgrade a live environment', async () => {
    const a = makeDeps();
    await handleRequest(post({ dry_run: false, mode: 'live' }), a.deps);
    expect(rpcArgs(a.calls, 'cloud_blob_erase_claim')).toEqual([{ p_dry_run: true }]);
    const b = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: 'live' } });
    await handleRequest(post({ dry_run: true }), b.deps);
    expect(rpcArgs(b.calls, 'cloud_blob_erase_claim')).toEqual([{ p_dry_run: true }]);
    expect(removes(b.calls)).toHaveLength(0);
  });
});

describe('live run', () => {
  it('erases bytes first: remove, then finish with the removed ids, then scrub', async () => {
    const { deps, calls } = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: 'live' } });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(200);
    expect(order(calls)).toEqual([
      'cloud_blob_erase_secret', 'cloud_blob_erase_claim', 'remove', 'remove', 'cloud_blob_erase_finish',
      'cloud_blob_erase_scrub', 'cloud_blob_erase_scrub',
    ]);
    expect(removes(calls).map((c) => JSON.parse(c.body).prefixes)).toEqual([[blob(1).path, blob(2).path], [ROWLESS]]);
    expect(rpcArgs(calls, 'cloud_blob_erase_finish')[0]).toMatchObject({
      p_run_id: RUN_ID, p_blob_ids: [blob(1).id, blob(2).id], p_outcome: 'ok',
    });
    expect(await res.json()).toMatchObject({ outcome: 'ok', objects_removed: 2, rowless_removed: 1, rows_scrubbed: 6 });
  });
  it('a failed remove keeps that chunk out of finish and marks the run partial', async () => {
    const many = Array.from({ length: 150 }, (_, i) => blob(i + 1));
    const { deps, calls } = makeDeps({
      env: { CLOUD_BLOB_ERASE_MODE: 'live' }, claim: { ...CLAIM, blobs: many, rowless: [] }, failRemoveFor: blob(120).path,
    });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(200);
    expect(removes(calls).map((c) => JSON.parse(c.body).prefixes.length)).toEqual([100, 50]);
    const fin = rpcArgs(calls, 'cloud_blob_erase_finish')[0];
    expect(fin.p_blob_ids).toEqual(many.slice(0, 100).map((b) => b.id));
    expect(fin.p_outcome).toBe('partial');
    expect(fin.p_counts.remove_errors).toBe(1);
    expect(sentry(calls).some((b) => b.includes('"type":"event"'))).toBe(true);
  });
  it('scrubs round-robin, one batch per owner per round, in claim order, until each owner has no more', async () => {
    // A has 3 full batches, B has 1: rounds A,B | A | A
    const left: Record<string, number> = { [OWNER_A]: 3, [OWNER_B]: 1 };
    const { deps, calls } = makeDeps({
      env: { CLOUD_BLOB_ERASE_MODE: 'live' },
      scrub: (owner) => {
        left[owner] -= 1;
        return { state: 'scrubbed', scrubbed: 1000, more: left[owner] > 0 };
      },
    });
    const res = await handleRequest(post(), deps);
    expect(rpcArgs(calls, 'cloud_blob_erase_scrub').map((a) => a.p_owner)).toEqual([OWNER_A, OWNER_B, OWNER_A, OWNER_A]);
    expect(rpcArgs(calls, 'cloud_blob_erase_scrub').every((a) => a.p_limit === 1000 && a.p_dry_run === false)).toBe(true);
    expect(await res.json()).toMatchObject({ scrub_rounds: 3, scrub_batches: 4, rows_scrubbed: 4000, scrub_owners_left: 0 });
  });
  it('an owner that is skipped (settings row locked) or does not apply leaves the round', async () => {
    const { deps, calls } = makeDeps({
      env: { CLOUD_BLOB_ERASE_MODE: 'live' },
      scrub: (owner) => (owner === OWNER_A ? { state: 'skipped', scrubbed: 0, more: false } : { state: 'not_applicable', scrubbed: 0, more: false }),
    });
    const res = await handleRequest(post(), deps);
    expect(rpcArgs(calls, 'cloud_blob_erase_scrub')).toHaveLength(2);
    expect(await res.json()).toMatchObject({ scrub_skipped: 1, scrub_rounds: 1 });
  });
  it('stops scrubbing when the time budget is spent and reports the owners left', async () => {
    const { deps, calls } = makeDeps({
      env: { CLOUD_BLOB_ERASE_MODE: 'live' },
      clockStep: SCRUB_BUDGET_MS / 2,
      scrub: () => ({ state: 'scrubbed', scrubbed: 1000, more: true }),
    });
    const res = await handleRequest(post(), deps);
    expect(rpcArgs(calls, 'cloud_blob_erase_scrub')).toHaveLength(2);
    expect(await res.json()).toMatchObject({ scrub_owners_left: 2 });
  });
  it('a failing scrub batch drops that owner, keeps the others, and marks the run partial', async () => {
    const { deps, calls } = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: 'live' }, scrubStatusFor: OWNER_A });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(200);
    expect(rpcArgs(calls, 'cloud_blob_erase_scrub').map((a) => a.p_owner)).toEqual([OWNER_A, OWNER_B]);
    expect(await res.json()).toMatchObject({ outcome: 'partial', scrub_errors: 1, rows_scrubbed: 3 });
  });
});

describe('counts only', () => {
  it('log line, response, run counts and Sentry payloads never carry an id, path or response body', async () => {
    for (const opts of [
      { env: { CLOUD_BLOB_ERASE_MODE: 'live' } },
      { env: { CLOUD_BLOB_ERASE_MODE: 'live' }, failRemoveFor: blob(1).path },
      { env: { CLOUD_BLOB_ERASE_MODE: 'live' }, claimStatus: 500 },
      { env: { CLOUD_BLOB_ERASE_MODE: 'live' }, finishStatus: 503 },
      { env: { CLOUD_BLOB_ERASE_MODE: 'live' }, scrubStatusFor: OWNER_B },
    ]) {
      const { deps, calls, logs } = makeDeps(opts);
      const res = await handleRequest(post(), deps);
      const text = await res.text();
      const counts = rpcArgs(calls, 'cloud_blob_erase_finish').map((a) => JSON.stringify(a.p_counts));
      const blobs = [text, ...logs, ...sentry(calls), ...counts];
      for (const b of blobs) for (const s of SENSITIVE) expect(b).not.toContain(s);
    }
  });
});

describe('failures', () => {
  it('a claim error returns 500 with stage and status, reports to Sentry, removes and scrubs nothing', async () => {
    const { deps, calls } = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: 'live' }, claimStatus: 500 });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ outcome: 'failed', stage: 'claim', status: 500 });
    expect(removes(calls)).toHaveLength(0);
    expect(rpcArgs(calls, 'cloud_blob_erase_scrub')).toHaveLength(0);
    expect(sentry(calls).find((b) => b.includes('"type":"event"'))).toContain('"stage":"claim"');
  });
  it('a claim answer with no run id fails the run before any remove', async () => {
    const { deps, calls } = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: 'live' }, claim: { ...CLAIM, run_id: null } });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(500);
    expect(removes(calls)).toHaveLength(0);
  });
  it('a finish error fails the run, sends an error check-in and scrubs nothing', async () => {
    const { deps, calls } = makeDeps({ env: { CLOUD_BLOB_ERASE_MODE: 'live' }, finishStatus: 503 });
    const res = await handleRequest(post(), deps);
    expect(res.status).toBe(500);
    expect(rpcArgs(calls, 'cloud_blob_erase_scrub')).toHaveLength(0);
    expect(sentry(calls).some((b) => b.includes('"status":"error"') && b.includes('"monitor_slug":"cloud-blob-erase"'))).toBe(true);
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

describe('parseDsn', () => {
  it('builds the envelope endpoint and rejects anything else', () => {
    expect(parseDsn('https://k@o1.ingest.sentry.io/123')).toEqual({
      endpoint: 'https://o1.ingest.sentry.io/api/123/envelope/',
      auth: 'Sentry sentry_version=7, sentry_key=k, sentry_client=keepr-cloud-blob-erase/1.0',
    });
    expect(parseDsn(undefined)).toBeNull();
    expect(parseDsn('http://k@host/1')).toBeNull();
  });
});
