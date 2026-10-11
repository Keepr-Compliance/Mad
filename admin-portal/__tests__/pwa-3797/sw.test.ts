/**
 * BACKLOG-3797 — the admin service worker caches nothing, serves no account
 * data offline, and never replaces a real server answer with the offline
 * screen.
 *
 * Loads the REAL public/sw.js into a vm context with a fake `self`, `caches`
 * and `fetch`, fires install + activate, browses online, then goes offline.
 *
 * Two wrong implementations this suite is built to catch:
 *   - "network-first with cache fallback" for pages: it serves the last
 *     signed-in page to whoever opens the phone offline. The zero-writes and
 *     offline-navigation assertions go red on it.
 *   - "show offline on any bad response" (`r.ok ? r : offline`): it reads as a
 *     robustness fix, but a navigation redirect arrives as an opaqueredirect
 *     (ok false, status 0), so /login?error=not_authorized and every other
 *     auth redirect would become "You're offline". The pass-through cases go
 *     red on it.
 *
 * Hostnames are invented placeholders.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { beforeEach, describe, expect, it } from 'vitest';

const SW_PATH = path.resolve(__dirname, '../../public/sw.js');

type FakeRequest = { url: string; mode: string; method: string; headers: Map<string, string> };
type Outcome = { ok: true; status: number; body: string; headers: Headers } | { ok: false; error: string };
type NetworkAnswer = (r: FakeRequest) => unknown;

const PRE_EXISTING_CACHES = ['legacy-shell', 'pages-v1'];

const signedInPage: NetworkAnswer = (r) => new Response(`SIGNED-IN PAGE ${r.url}`, { status: 200 });

function loadWorker(src: string, opts: { navigationPreload?: boolean } = {}) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const writes: string[] = [];
  const deleted: string[] = [];
  const store = new Map<string, Response>();
  const cacheNames = new Set<string>(PRE_EXISTING_CACHES);
  let online = true;
  let answer: NetworkAnswer = signedInPage;
  let claimed = false;
  let skipWaitingCalls = 0;
  const preloadEnables: number[] = [];
  /** What event.preloadResponse resolves to (undefined = no preload made). */
  let preload: ((r: FakeRequest) => unknown) | null = null;
  const preloadCalls: string[] = [];
  const fetchCalls: string[] = [];

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
      // Browsers without navigation preload (older Safari) have no
      // registration.navigationPreload; the worker must cope with both.
      registration: opts.navigationPreload
        ? {
            navigationPreload: {
              enable: async () => {
                preloadEnables.push(1);
              },
            },
          }
        : {},
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
      fetchCalls.push(r.url);
      if (!online) throw new TypeError('Failed to fetch');
      return answer(r);
    },
    Response,
    Promise,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);

  /** Dispatches a fetch event; resolves to whatever the page would receive. */
  async function dispatch(request: FakeRequest): Promise<unknown> {
    let responded: Promise<unknown> | null = null;
    let preloadResponse: Promise<unknown> | undefined;
    if (preload) {
      const make = preload;
      // A preload is only made for navigations, like the browser does.
      if (request.mode === 'navigate') {
        preloadCalls.push(request.url);
        preloadResponse = (async () => {
          if (!online) throw new TypeError('Failed to fetch');
          return make(request);
        })();
        preloadResponse.catch(() => undefined);
      }
    }
    listeners.fetch?.({
      request,
      preloadResponse,
      respondWith: (p: Promise<unknown>) => {
        responded = p;
      },
      waitUntil: () => undefined,
    });
    // Not intercepted -> the browser's own network fetch.
    return responded ?? ctx.fetch(request);
  }

  return {
    listeners,
    writes,
    deleted,
    cacheNames,
    claimed: () => claimed,
    preloadEnables: () => preloadEnables.length,
    preloadCalls,
    setPreload: (fn: ((r: FakeRequest) => unknown) | null) => {
      preload = fn;
    },
    fetchCalls: () => fetchCalls,
    skipWaitingCalls: () => skipWaitingCalls,
    setOnline: (v: boolean) => {
      online = v;
    },
    setNetworkAnswer: (fn: NetworkAnswer) => {
      answer = fn;
    },
    dispatch,
    async lifecycle() {
      for (const type of ['install', 'activate']) {
        const pending: Promise<unknown>[] = [];
        listeners[type]?.({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
        await Promise.all(pending);
      }
    },
    async go(request: FakeRequest): Promise<Outcome> {
      try {
        const res = (await dispatch(request)) as Response;
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
  req('https://admin.example.test/api/users'),
  req('https://project.supabase.example.test/rest/v1/internal_roles'),
  req('https://admin.example.test/dashboard?_rsc=abc', { headers: { RSC: '1' } }),
  req('https://ingest.sentry.example.test/api/1/envelope/', { method: 'POST' }),
  req('https://admin.example.test/_next/static/chunks/app.js', { mode: 'no-cors' }),
];
const PAGE = req('https://admin.example.test/dashboard/users/user-1', { mode: 'navigate' });

describe('BACKLOG-3797 admin service worker', () => {
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
    expect(worker.writes).toEqual([]);
  });

  it('offline screen names Keepr Admin, not the broker portal', async () => {
    worker.setOnline(false);
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.body).toContain('<title>Keepr Admin - offline</title>');
    expect(out.body).toContain('Keepr Admin needs an internet connection');
  });

  it('offline screen: Retry now is a same-URL link (works without script), one script, no inline handlers, no stored-data claim', async () => {
    worker.setOnline(false);
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.body).toContain('<a id="retry" href="">Retry now</a>');
    expect(out.body).toContain('<p id="status" role="status" aria-live="polite"></p>');
    expect(out.body.match(/<script/gi)).toHaveLength(1);
    expect(out.body).not.toMatch(/<script[^>]+src|\son[a-z]+=|javascript:/i);
    expect(out.body).not.toMatch(/stored on this device/i);
  });

  it("offline screen CSP: only the page's own script runs (by hash), only same-origin connections, no 'unsafe-inline' script", async () => {
    worker.setOnline(false);
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    const script = out.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    const hash = `sha256-${crypto.createHash('sha256').update(script as string, 'utf8').digest('base64')}`;
    const csp = out.headers.get('content-security-policy');
    expect(csp, `OFFLINE_SCRIPT_HASH in public/sw.js should be '${hash}'`).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; script-src '${hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'`
    );
  });

  it('online navigation returns the network response unchanged — opaqueredirect to /login?error=not_authorized', async () => {
    // A navigation follows redirects in 'manual' mode inside a worker, so the
    // redirect reaches the worker as an opaqueredirect: ok false, status 0.
    const redirect = {
      type: 'opaqueredirect',
      status: 0,
      ok: false,
      url: 'https://admin.example.test/login?error=not_authorized',
    };
    worker.setNetworkAnswer(() => redirect);
    const out = await worker.dispatch(req('https://admin.example.test/dashboard', { mode: 'navigate' }));
    expect(out).toBe(redirect);
  });

  it('online navigation passes a same-origin 500 through, not the offline screen', async () => {
    worker.setNetworkAnswer(() => new Response('SERVER ERROR PAGE', { status: 500 }));
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.status).toBe(500);
    expect(out.body).toBe('SERVER ERROR PAGE');
  });
});

describe('BACKLOG-3797 admin service worker — navigation preload', () => {
  it('activate enables navigation preload when the browser has it', async () => {
    const worker = loadWorker(fs.readFileSync(SW_PATH, 'utf8'), { navigationPreload: true });
    await worker.lifecycle();
    expect(worker.preloadEnables()).toBe(1);
    expect(worker.claimed()).toBe(true);
  });

  it('activate still claims pages when the browser has no navigation preload', async () => {
    const worker = loadWorker(fs.readFileSync(SW_PATH, 'utf8'), { navigationPreload: false });
    await worker.lifecycle();
    expect(worker.preloadEnables()).toBe(0);
    expect(worker.claimed()).toBe(true);
  });

  it('preload present: the page is the preload response, and the worker makes no second fetch', async () => {
    const worker = loadWorker(fs.readFileSync(SW_PATH, 'utf8'), { navigationPreload: true });
    await worker.lifecycle();
    worker.setPreload((r) => new Response(`PRELOADED ${r.url}`, { status: 200 }));
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.body).toBe(`PRELOADED ${PAGE.url}`);
    expect(worker.preloadCalls).toEqual([PAGE.url]);
    expect(worker.fetchCalls()).toEqual([]);
  });

  it('preload absent (resolves undefined): the worker fetches the page itself', async () => {
    const worker = loadWorker(fs.readFileSync(SW_PATH, 'utf8'), { navigationPreload: true });
    await worker.lifecycle();
    worker.setPreload(() => undefined);
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.body).toBe(`SIGNED-IN PAGE ${PAGE.url}`);
    expect(worker.fetchCalls()).toEqual([PAGE.url]);
  });

  it('preload present, opaqueredirect to /login?error=not_authorized passes through unchanged', async () => {
    const worker = loadWorker(fs.readFileSync(SW_PATH, 'utf8'), { navigationPreload: true });
    await worker.lifecycle();
    const redirect = { type: 'opaqueredirect', status: 0, ok: false, url: 'https://admin.example.test/login?error=not_authorized' };
    worker.setPreload(() => redirect);
    expect(await worker.dispatch(req('https://admin.example.test/dashboard', { mode: 'navigate' }))).toBe(redirect);
  });

  it('preload present, a same-origin 500 passes through, not the offline screen', async () => {
    const worker = loadWorker(fs.readFileSync(SW_PATH, 'utf8'), { navigationPreload: true });
    await worker.lifecycle();
    worker.setPreload(() => new Response('SERVER ERROR PAGE', { status: 500 }));
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.status).toBe(500);
    expect(out.body).toBe('SERVER ERROR PAGE');
  });

  it('preload present, offline: the preload fails and the page gets the offline screen', async () => {
    const worker = loadWorker(fs.readFileSync(SW_PATH, 'utf8'), { navigationPreload: true });
    await worker.lifecycle();
    worker.setPreload(signedInPage);
    worker.setOnline(false);
    const out = await worker.go(PAGE);
    if (!out.ok) throw new Error(`expected a response, got ${out.error}`);
    expect(out.status).toBe(503);
    expect(out.body).toContain("You're offline");
    expect(out.body).not.toContain('SIGNED-IN PAGE');
    expect(worker.writes).toEqual([]);
  });
});
