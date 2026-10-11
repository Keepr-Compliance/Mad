/**
 * BACKLOG-3893 — the offline screen's own script: a "Retrying in Ns"
 * countdown, a probe of a same-origin URL on 5s/10s/20s/30s backoff, reload
 * as soon as the probe gets any answer, reload on the `online` event, and a
 * "Retry now" button that shows a busy state while it checks.
 *
 * The HTML and script are read from the REAL public/sw.js (the OFFLINE_HTML
 * the worker serves), and the script is run against that markup.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const SW_PATH = path.resolve(__dirname, '../../public/sw.js');

function offlineHtml(): string {
  const ctx: Record<string, unknown> = { self: { addEventListener: () => undefined }, Response: function () {}, caches: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), ctx);
  return ctx.OFFLINE_HTML as string;
}

type Probe = { resolve: () => void; reject: () => void; url: string; init: RequestInit };

function boot() {
  const html = offlineHtml();
  const body = html.match(/<body>([\s\S]*)<\/body>/)?.[1] ?? '';
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script>[\s\S]*?<\/script>/, '');
  const probes: Probe[] = [];
  const reload = jest.fn();
  const win = new EventTarget();
  const fetch = jest.fn((url: string, init: RequestInit) => {
    return new Promise<void>((resolve, reject) => {
      probes.push({ resolve, reject: () => reject(new TypeError('Failed to fetch')), url, init });
    });
  });
  vm.runInNewContext(script, {
    document,
    window: win,
    fetch,
    location: { reload },
    setTimeout,
    clearTimeout,
    Math,
    Date,
  });
  const status = () => document.getElementById('status')?.textContent;
  const button = () => document.getElementById('retry') as HTMLAnchorElement;
  return { probes, reload, win, fetch, status, button };
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  document.body.innerHTML = '';
});

describe('BACKLOG-3893 offline screen script', () => {
  it('counts down "Retrying in Ns" from 5 and probes when it reaches zero', () => {
    const p = boot();
    expect(p.status()).toBe('Retrying in 5s');
    jest.advanceTimersByTime(1000);
    expect(p.status()).toBe('Retrying in 4s');
    jest.advanceTimersByTime(3000);
    expect(p.status()).toBe('Retrying in 1s');
    expect(p.fetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(p.fetch).toHaveBeenCalledTimes(1);
    expect(p.probes[0].url).toMatch(/^\/manifest\.webmanifest\?probe=\d+$/);
    expect(p.probes[0].init).toEqual({ method: 'HEAD', cache: 'no-store' });
  });

  it('a probe that gets any answer reloads the page', async () => {
    const p = boot();
    jest.advanceTimersByTime(5000);
    p.probes[0].resolve();
    await flush();
    expect(p.reload).toHaveBeenCalledTimes(1);
    expect(p.status()).toBe('Back online. Reloading…');
  });

  it('a failed probe backs off: next countdown is 10s, then 20s, then 30s', async () => {
    const p = boot();
    const seen: string[] = [];
    for (const wait of [5000, 10000, 20000, 30000]) {
      jest.advanceTimersByTime(wait);
      expect(p.probes).toHaveLength(seen.length + 1);
      p.probes[p.probes.length - 1].reject();
      await flush();
      seen.push(p.status() as string);
    }
    expect(seen).toEqual(['Retrying in 10s', 'Retrying in 20s', 'Retrying in 30s', 'Retrying in 30s']);
    expect(p.reload).not.toHaveBeenCalled();
  });

  it('Retry now shows a busy "Checking…" state, then returns to "Retry now" if still offline', async () => {
    const p = boot();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    p.button().dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(p.button().textContent).toBe('Checking…');
    expect(p.button().className).toBe('busy');
    expect(p.button().getAttribute('aria-busy')).toBe('true');
    expect(p.status()).toBe('Checking connection…');
    expect(p.fetch).toHaveBeenCalledTimes(1);
    // A second tap while checking does not start a second probe.
    p.button().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(p.fetch).toHaveBeenCalledTimes(1);
    p.probes[0].reject();
    await flush();
    expect(p.button().textContent).toBe('Retry now');
    expect(p.button().className).toBe('');
    expect(p.button().hasAttribute('aria-busy')).toBe(false);
    expect(p.status()).toBe('Retrying in 10s');
  });

  it('the browser "online" event probes straight away and reloads on an answer', async () => {
    const p = boot();
    p.win.dispatchEvent(new Event('online'));
    expect(p.fetch).toHaveBeenCalledTimes(1);
    p.probes[0].resolve();
    await flush();
    expect(p.reload).toHaveBeenCalledTimes(1);
  });
});
