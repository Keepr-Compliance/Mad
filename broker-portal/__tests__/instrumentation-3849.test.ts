/**
 * @jest-environment node
 *
 * BACKLOG-3849 — server-side Sentry is loaded from instrumentation.ts and sends
 * only when SENTRY_DSN is set. NEXT_PUBLIC_SENTRY_DSN (the browser SDK's
 * variable) must not switch server reporting on by itself.
 */

const mockInit = jest.fn();
const mockCaptureRequestError = jest.fn();
jest.mock('@sentry/nextjs', () => ({
  init: (...a: unknown[]) => mockInit(...a),
  captureRequestError: mockCaptureRequestError,
}));

const ENV = { ...process.env };

async function register(env: Record<string, string | undefined>) {
  process.env = { ...ENV };
  delete process.env.SENTRY_DSN;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // register() imports the config lazily, so the module registry is reset
  // (not isolated) for each case: the config must be evaluated again.
  jest.resetModules();
  const mod: typeof import('../instrumentation') = require('../instrumentation');
  await mod.register();
  return mod;
}

beforeEach(() => mockInit.mockReset());
afterAll(() => {
  process.env = ENV;
});

describe('instrumentation.ts', () => {
  it('nodejs runtime loads the server config; no DSN -> initialised disabled', async () => {
    await register({ NEXT_RUNTIME: 'nodejs' });
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0][0]).toMatchObject({ enabled: false, dsn: undefined });
    expect(typeof mockInit.mock.calls[0][0].beforeSend).toBe('function');
  });

  it('nodejs runtime with SENTRY_DSN -> enabled with that DSN', async () => {
    await register({ NEXT_RUNTIME: 'nodejs', SENTRY_DSN: 'https://k@o1.ingest.sentry.io/2' });
    expect(mockInit.mock.calls[0][0]).toMatchObject({ enabled: true, dsn: 'https://k@o1.ingest.sentry.io/2' });
  });

  it('the browser DSN alone does not turn on server reporting', async () => {
    await register({ NEXT_RUNTIME: 'nodejs', NEXT_PUBLIC_SENTRY_DSN: 'https://k@o1.ingest.sentry.io/2' });
    expect(mockInit.mock.calls[0][0]).toMatchObject({ enabled: false });
  });

  it('edge runtime loads the edge config', async () => {
    await register({ NEXT_RUNTIME: 'edge', SENTRY_DSN: 'https://k@o1.ingest.sentry.io/2' });
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit.mock.calls[0][0]).toMatchObject({ enabled: true });
    expect(mockInit.mock.calls[0][0].beforeSend).toBeUndefined();
  });

  it('no runtime (build step) initialises nothing', async () => {
    await register({ NEXT_RUNTIME: undefined });
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('request errors go to Sentry', async () => {
    const mod = await register({ NEXT_RUNTIME: 'nodejs' });
    expect(mod.onRequestError).toBe(mockCaptureRequestError);
  });

  it('the server config scrubs emails before sending', async () => {
    await register({ NEXT_RUNTIME: 'nodejs' });
    const beforeSend = mockInit.mock.calls[0][0].beforeSend;
    const out = beforeSend({ message: 'failed for jane@example.com', extra: { who: 'jane@example.com' } });
    expect(JSON.stringify(out)).not.toContain('jane@example.com');
  });
});
