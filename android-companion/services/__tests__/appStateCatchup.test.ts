/**
 * AppState catch-up sync (BACKLOG-2204).
 *
 * The reliable safety net for Doze/OEM-killed background sync: foregrounding
 * the app runs an immediate catch-up. These pin:
 *   - a background/inactive -> active transition triggers exactly one catch-up;
 *   - active -> active (and initial mount) never trigger;
 *   - a catch-up never STACKS on one already in flight (2200 mutex respected);
 *   - rapid toggles are throttled;
 *   - an unexpected performSync throw is swallowed (never crashes foreground).
 */

import { performSync, type SyncOperationResult } from '../backgroundSync';
import {
  runCatchupSync,
  createCatchupHandler,
  isForegroundTransition,
  __resetCatchupState,
  CATCHUP_MIN_INTERVAL_MS,
} from '../appStateCatchup';

// performSync is the only real dependency — mock it so we observe invocations
// without touching the SMS/queue/network layer. This also skips backgroundSync's
// module-load TaskManager.defineTask side effect.
jest.mock('../backgroundSync', () => ({ performSync: jest.fn() }));
jest.mock('@sentry/react-native', () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

import * as Sentry from '@sentry/react-native';

const mockPerformSync = performSync as jest.MockedFunction<typeof performSync>;

const benign: SyncOperationResult = {
  newMessages: 0,
  sentMessages: 0,
  contactsSynced: 0,
  newContacts: 0,
  desktopReachable: true,
  queueSize: 0,
};

/** Let queued microtasks (the fire-and-forget void runCatchupSync) settle. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  __resetCatchupState();
  mockPerformSync.mockResolvedValue(benign);
});

describe('isForegroundTransition', () => {
  it('is true only when becoming active from a non-active state', () => {
    expect(isForegroundTransition('background', 'active')).toBe(true);
    expect(isForegroundTransition('inactive', 'active')).toBe(true);
    expect(isForegroundTransition('active', 'active')).toBe(false);
    expect(isForegroundTransition('active', 'background')).toBe(false);
    expect(isForegroundTransition('background', 'background')).toBe(false);
  });
});

describe('createCatchupHandler', () => {
  it('fires exactly one catch-up on a background -> foreground transition', async () => {
    const handler = createCatchupHandler('active');

    handler('background'); // leaving the foreground — no sync
    await flush();
    expect(mockPerformSync).not.toHaveBeenCalled();

    handler('active'); // returning to the foreground — one catch-up
    await flush();
    expect(mockPerformSync).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on active -> active (no real transition)', async () => {
    const handler = createCatchupHandler('active');
    handler('active');
    await flush();
    expect(mockPerformSync).not.toHaveBeenCalled();
  });
});

describe('runCatchupSync guards', () => {
  it('does not stack a second catch-up while one is already in flight', async () => {
    // Make performSync hang so the first run stays in flight.
    let resolveSync!: (v: SyncOperationResult) => void;
    mockPerformSync.mockImplementation(
      () =>
        new Promise<SyncOperationResult>((res) => {
          resolveSync = res;
        }),
    );

    const p1 = runCatchupSync(1_000);
    const p2 = runCatchupSync(1_000); // in-flight -> must be ignored
    await flush();
    expect(mockPerformSync).toHaveBeenCalledTimes(1);

    resolveSync(benign);
    await Promise.all([p1, p2]);

    // Once the first finished, a later (post-throttle) call runs again.
    mockPerformSync.mockResolvedValue(benign);
    await runCatchupSync(1_000 + CATCHUP_MIN_INTERVAL_MS);
    expect(mockPerformSync).toHaveBeenCalledTimes(2);
  });

  it('throttles catch-ups within CATCHUP_MIN_INTERVAL_MS', async () => {
    await runCatchupSync(1_000);
    expect(mockPerformSync).toHaveBeenCalledTimes(1);

    // Within the window -> skipped.
    await runCatchupSync(1_000 + CATCHUP_MIN_INTERVAL_MS - 1);
    expect(mockPerformSync).toHaveBeenCalledTimes(1);

    // At the window boundary -> runs.
    await runCatchupSync(1_000 + CATCHUP_MIN_INTERVAL_MS);
    expect(mockPerformSync).toHaveBeenCalledTimes(2);
  });

  it('swallows an unexpected performSync throw and reports it', async () => {
    mockPerformSync.mockRejectedValueOnce(new Error('boom'));
    await expect(runCatchupSync(5_000)).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });
});
