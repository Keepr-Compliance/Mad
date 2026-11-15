/**
 * BACKLOG-4259 — browser session replay on the OAuth and AI apps pages:
 * the path rule, the real client config (init mocked), and the component the
 * excluded pages render.
 */

const mockInit = jest.fn();
const mockReplayIntegration = jest.fn((opts: unknown) => ({ name: 'Replay', opts }));
const mockStop = jest.fn(async (_o?: unknown) => undefined);
const mockGetReplay = jest.fn(() => ({ stop: mockStop }));
jest.mock('@sentry/nextjs', () => ({
  init: (...a: unknown[]) => mockInit(...a),
  replayIntegration: (opts: unknown) => mockReplayIntegration(opts),
  getReplay: () => mockGetReplay(),
}));

import { render } from '@testing-library/react';
import { ReplayOff } from '@/components/sentry/ReplayOff';
import { clientReplayIntegrations, isReplayExcludedPath, replayRecordingFilter } from '@/lib/sentry/replayRoutes';

type Init = { integrations: Array<{ name: string; opts: { beforeAddRecordingEvent: (_e: unknown) => unknown } }> };

function loadClientConfig(path: string): Init {
  window.history.pushState({}, '', path);
  mockInit.mockReset();
  mockReplayIntegration.mockClear();
  jest.isolateModules(() => {
    require('../../../sentry.client.config');
  });
  expect(mockInit).toHaveBeenCalledTimes(1);
  return mockInit.mock.calls[0][0] as Init;
}

afterEach(() => window.history.pushState({}, '', '/'));

describe('the path rule', () => {
  it.each([
    ['/oauth', true],
    ['/oauth/authorize', true],
    ['/oauth/register', true],
    ['/dashboard/account/ai-apps', true],
    ['/dashboard/account/ai-apps/', true],
    ['/dashboard/account/ai-apps/connect/AAAAAAAAAAAAAAAAAAAAAA', true],
    ['/oauthx', false],
    ['/oauth-help', false],
    ['/dashboard/account', false],
    ['/dashboard/account/ai-appsx', false],
    ['/dashboard', false],
    ['/', false],
    ['/login', false],
  ])('%s → %s', (path, excluded) => {
    expect(isReplayExcludedPath(path)).toBe(excluded);
  });
});

describe('clientReplayIntegrations', () => {
  it('no integration when the first page is excluded; one, with the recording filter, otherwise', () => {
    const make = jest.fn((o: unknown) => o);
    expect(clientReplayIntegrations(make, '/dashboard/account/ai-apps/connect/x')).toEqual([]);
    expect(make).not.toHaveBeenCalled();
    expect(clientReplayIntegrations(make, '/dashboard')).toEqual([{ beforeAddRecordingEvent: replayRecordingFilter }]);
  });

  it('the recording filter drops events while the current page is excluded and keeps them elsewhere', () => {
    const ev = { type: 5, data: { tag: 'breadcrumb' } };
    window.history.pushState({}, '', '/dashboard/account/ai-apps');
    expect(replayRecordingFilter(ev)).toBeNull();
    window.history.pushState({}, '', '/dashboard/deals');
    expect(replayRecordingFilter(ev)).toBe(ev);
  });
});

describe('sentry.client.config', () => {
  it.each(['/oauth/authorize', '/dashboard/account/ai-apps', '/dashboard/account/ai-apps/connect/AAAAAAAAAAAAAAAAAAAAAA'])(
    'loaded on %s → no replay integration',
    (path) => {
      const cfg = loadClientConfig(path);
      expect(cfg.integrations).toEqual([]);
      expect(mockReplayIntegration).not.toHaveBeenCalled();
    }
  );

  it('loaded on /dashboard → the replay integration with the recording filter, which drops events after navigating onto an excluded page', () => {
    const cfg = loadClientConfig('/dashboard');
    expect(cfg.integrations).toHaveLength(1);
    const filter = cfg.integrations[0].opts.beforeAddRecordingEvent;
    const ev = { type: 5 };
    expect(filter(ev)).toBe(ev);
    window.history.pushState({}, '', '/dashboard/account/ai-apps');
    expect(filter(ev)).toBeNull();
  });
});

describe('ReplayOff', () => {
  beforeEach(() => {
    mockStop.mockClear();
    mockGetReplay.mockClear();
  });

  it('stops replay on mount without sending what it buffered', () => {
    render(<ReplayOff />);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledWith({ flush: false });
  });

  it('renders nothing and does not throw when replay is not set up', () => {
    mockGetReplay.mockReturnValueOnce(undefined as never);
    const { container } = render(<ReplayOff />);
    expect(container.innerHTML).toBe('');
  });
});
