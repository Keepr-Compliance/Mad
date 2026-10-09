/**
 * BACKLOG-3796 — the service worker caches nothing and serves no account data
 * offline.
 *
 * Loads the REAL public/sw.js into a vm context with a fake `self`, `caches`
 * and `fetch`, fires install + activate, browses online, then goes offline.
 *
 * The most likely wrong implementation is "network-first with cache fallback"
 * for pages: it looks like a normal PWA and serves the last signed-in page to
 * whoever opens the phone offline, including after sign-out. The zero-writes
 * and offline-navigation assertions both go red on it.
 *
 * Hostnames are invented placeholders.
 *
 * @jest-environment node
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SW_PATH = path.resolve(__dirname, '../../public/sw.js');

type FakeRequest = { url: string; mode: string; method: string; headers: Map<string, string> };
type Outcome = { ok: true; status: number; body: string; headers: Headers } | { ok: false; error: string };

const PRE_EXISTING_CACHES = ['legacy-shell', 'pages-v1'];

function loadWorker(src: string) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const writes: string[] = [];
  const deleted: string[] = [];
  const store = new Map<string, Response>();
  const cacheNames = new Set<string>(PRE_EXISTING_CACHES);
  let online = true;
  let claimed = false;
  let skipWaitingCalls = 0;

  const key = (r: FakeRequest | string) => (typeof r === 'string' ? r : r.url);
  const cache = {
    put: async (r: FakeRequest | string, res: Response) => {
      writes.push(`put ${key(r)}`);
      store.set(key(r), res);
    },
    add: async (r: FakeRequest | string) => {
      writes.push(`add ${key(r)}`);
    },
    addAll: async (rs: Array<FakeRequest | string>) => {
      rs.forEach((r) => writes.push(`addAll ${key(r)}`));
    },
    match: async (r: FakeRequest | string) => store.get(key(r)),
  };

  const ctx = {
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        listeners[type] = fn;
      },
      skipWaiting: async () => {
        skipWaitingCalls += 1;
      },
      clients: {
        claim: async () => {
          claimed = true;
        },
      },
    },
    caches: {
      open: async (name: string) => {
        cacheNames.add(name);
        return cache;
      },
      keys: async () => Array.from(cacheNames),
      delete: async (name: string) => {
        deleted.push(name);
        return cacheNames.delete(name);
      },
      match: async (r: FakeRequest | string) => store.get(key(r)),
    },
    fetch: async (r: FakeRequest) => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Response(`SIGNED-IN PAGE ${r.url}`, { status: 200 });
    },
    Response,
    Promise,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  return {
    listeners,
    writes,
    deleted,
    cacheNames,
    claimed: () => claimed,
    skipWaitingCalls: () => skipWaitingCalls,
    setOnline: (v: boolean) => {
      online = v;
    },
    async lifecycle() {
      for (const type of ['install', 'activate']) {
        const pending: Promise<unknown>[] = [];
        listeners[type]?.({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
        await Promise.all(pending);
      }
    },
    async go(request: FakeRequest): Promise<Outcome> {
      let responded: Promise<Response> | null = null;
      listeners.fetch?.({
        request,
        respondWith: (p: Promise<Response>) => {
          responded = p;
        },
        waitUntil: () => undefined,
      });
      try {
        // Not intercepted -> the browser's own network fetch.
        const res = await (responded ?? ctx.fetch(request));
        return { ok: true, status: res.status, body: await res.text(), headers: res.headers };
      } catch (e) {
        return { ok: false, error: (e as Error).name };
      }
    },
  };
}

const req = (url: string, o: { mode?: string; method?: string; headers?: Record<string, string> } = {}): FakeRequest => ({
  url,
  mode: o.mode ?? 'cors',
  method: o.method ?? 'GET',
  headers: new Map(Object.entries(o.headers ?? {})),
});

const NON_NAVIGATIONS: FakeRequest[] = [
  req('https://portal.example.test/api/submissions'),
  req('https://project.supabase.example.test/rest/v1/transactions'),
  req('https://portal.example.test/dashboard?_rsc=abc', { headers: { RSC: '1' } }),
  req('https://ingest.sentry.example.test/api/1/envelope/', { method: 'POST' }),
  req('https://portal.example.test/_next/static/chunks/app.js', { mode: 'no-cors' }),
];
const PAGE = req('https://portal.example.test/dashboard/submissions/sub-1', { mode: 'navigate' });

describe('BACKLOG-3796 service worker', () => {
  let worker: ReturnType<typeof loadWorker>;

  beforeEach(async () => {
    worker = loadWorker(fs.readFileSync(SW_PATH, 'utf8'));
    await worker.lifecycle();
    // Browse while online, signed in.
    for (const r of NON_NAVIGATIONS) await worker.go(r);
    const online = await worker.go(PAGE);
    expect(online.ok && online.body).toContain('SIGNED-IN PAGE');
  });

  it('activate deletes every pre-existing cache, whatever its name, and claims pages', () => {
    expect(worker.deleted.sort()).toEqual([...PRE_EXISTING_CACHES].sort());
    expect(Array.from(worker.cacheNames)).toEqual([]);
    expect(worker.claimed()).toBe(true);
  });

  it('install calls skipWaiting once, so a new sw.js replaces a waiting old one immediately', () => {
    expect(worker.skipWaitingCalls()).toBe(1);
  });

  it('writes nothing to Cache Storage across install, activate and browsing', () => {
    expect(worker.writes).toEqual([]);
  });

  it.each(NON_NAVIGATIONS.map((r) => [r.method, r.url, r] as const))(
    'offline, %s %s is not intercepted: it fails as a network error',
    async (_m, _u, r) => {
      worker.setOnline(false);
      const out = await worker.go(r);
      expect(out).toEqual({ ok: false, error: 'TypeError' });
    }
  );

  it('offline, a page navigation gets the offline screen, never the earlier signed-in page', async () => {
    worker.setOnline(false);
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.status).toBe(503);
    expect(out.body).toContain("You're offline");
    expect(out.body).not.toContain('SIGNED-IN PAGE');
    expect(out.headers.get('cache-control')).toBe('no-store');
    expect(out.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(worker.writes).toEqual([]);
  });

  it('offline screen: Retry is a same-URL link, no script, and no claim about stored data', async () => {
    worker.setOnline(false);
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.body).toContain('<a href="">Retry</a>');
    expect(out.body).not.toMatch(/<script|onclick|javascript:/i);
    expect(out.body).not.toMatch(/stored on this device/i);
  });
});
