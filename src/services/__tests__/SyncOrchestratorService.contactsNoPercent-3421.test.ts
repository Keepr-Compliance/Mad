/**
 * BACKLOG-3421 — the contacts leg reports no percentage at all.
 *
 * The founder, after the dashboard was already showing 50 whenever he looked at
 * it: "i honestly thing we we even don't do a % for the contacts its fine since
 * they are alwasy so fast". Measured on his own runs: 334ms, and 321-577ms
 * across runs — about 0.6% of a first sync.
 *
 * The three numbers the leg used to emit (0, then 50 after the macOS phase,
 * then 100) were positions in a phase LIST rather than measurements of
 * anything. Two of the three phases are skipped outright when a source is
 * unticked, and the 50 landed within a few hundred milliseconds of the start
 * and stayed there for the whole run — which is why the dashboard was at 50
 * before he had finished looking at it.
 *
 * THIS SUITE DRIVES THE REAL CONTACTS FUNCTION. The claim is about that leg's
 * own calls, so a synthetic source registered over it would test nothing.
 */

import type { SyncItem } from '../SyncOrchestratorService';

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: jest.fn(),
}));

// Windows: the macOS address-book phase is skipped, so the leg runs its two
// cloud phases. The percentages under test were never platform-dependent.
jest.mock('../../utils/platform', () => ({
  isMacOS: jest.fn(() => false),
}));

const syncOutlookContacts = jest.fn();
const syncGoogleContacts = jest.fn();

Object.defineProperty(global, 'window', {
  value: {
    api: {
      preferences: { get: jest.fn().mockResolvedValue({ success: false }) },
      contacts: {
        syncExternal: jest.fn().mockResolvedValue({ success: true }),
        syncOutlookContacts,
        syncGoogleContacts,
        forceReimport: jest.fn().mockResolvedValue({ success: true, cleared: 0 }),
      },
      transactions: {
        scan: jest.fn().mockResolvedValue({ success: true }),
        precacheEmails: jest.fn().mockResolvedValue({ success: true }),
        onPrecacheProgress: jest.fn(() => () => {}),
      },
      featureGate: { check: jest.fn().mockResolvedValue({ allowed: false }) },
      messages: { importMacOSMessages: jest.fn(), onImportProgress: jest.fn() },
      notification: { send: jest.fn() },
      system: { reindexDatabase: jest.fn() },
      databaseBackup: { backup: jest.fn(), restore: jest.fn() },
      privacy: { exportData: jest.fn(), onExportProgress: jest.fn() },
    },
  },
  writable: true,
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { syncOrchestrator } =
  require('../SyncOrchestratorService') as typeof import('../SyncOrchestratorService');

function captureQueues(): { snapshots: SyncItem[][]; stop: () => void } {
  const snapshots: SyncItem[][] = [];
  const stop = syncOrchestrator.subscribe((state: { queue: SyncItem[] }) => {
    snapshots.push(state.queue.map((item) => ({ ...item })));
  });
  return { snapshots, stop };
}

const contactsFrames = (snapshots: SyncItem[][]) =>
  snapshots.map((q) => q.find((i) => i.type === 'contacts')).filter(Boolean) as SyncItem[];

/**
 * The frames a surface would render a NUMBER from — the dashboard's own gate
 * (`SyncStatusIndicator.tsx`: `running && !indeterminate`), restated so these
 * assertions are about what the user sees.
 */
const numberedFrames = (snapshots: SyncItem[][]) =>
  contactsFrames(snapshots).filter((i) => i.status === 'running' && !i.indeterminate);

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  syncOutlookContacts.mockResolvedValue({ success: true, count: 12 });
  syncGoogleContacts.mockResolvedValue({ success: true, count: 3 });
  syncOrchestrator.reset();
});

describe('BACKLOG-3421 — contacts reports no percentage', () => {
  it('renders no number at any point in a successful run', async () => {
    // MUTATION: drop `{ indeterminate: true }` from either `onProgress` call in
    // the contacts leg, or from the leg-start seed in `startSync` -> red, with
    // the offending number in the failure output.
    const { snapshots, stop } = captureQueues();
    await syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
    await flush();
    stop();

    // The leg really ran — otherwise "no numbers" would be vacuously true.
    expect(syncOutlookContacts).toHaveBeenCalledTimes(1);
    expect(syncGoogleContacts).toHaveBeenCalledTimes(1);
    expect(contactsFrames(snapshots).length).toBeGreaterThan(2);

    expect(numberedFrames(snapshots).map((i) => i.progress)).toEqual([]);
  });

  it('invents no phase label either', async () => {
    // The pill reads "Contacts". There is no honest per-phase vocabulary for
    // this leg, and `renderPill` falls through to `?? phase` for every type but
    // messages and emails — so a phase set here would put a raw identifier on
    // the dashboard.
    const { snapshots, stop } = captureQueues();
    await syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
    await flush();
    stop();

    contactsFrames(snapshots)
      .filter((i) => i.status === 'running')
      .forEach((i) => expect(i.phase).toBeUndefined());
  });

  it('renders no number on the reconnect path, where the leg ends by throwing', async () => {
    // The end-of-leg report is the last frame this path ever renders: the throw
    // below lands the item in 'error' without the completion write. A bare
    // `onProgress(100)` there would clear the flag and leave a determinate
    // "100%" as the final state of a leg that failed.
    //
    // MUTATION: `onProgress(100)` in place of `onProgress(100, undefined, {
    // indeterminate: true })` -> red.
    syncOutlookContacts.mockResolvedValue({ success: false, tokenExpired: true });

    const { snapshots, stop } = captureQueues();
    await syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
    await flush();
    stop();

    expect(numberedFrames(snapshots).map((i) => i.progress)).toEqual([]);
    const final = contactsFrames(snapshots).pop()!;
    expect(final.status).toBe('error');
    expect(final.reconnectProvider).toBe('microsoft');
  });

  it('still reaches a clean terminal state', async () => {
    // No number is not the same as no outcome: the green tick, and the 100 the
    // orchestrator's own completion writes, are untouched.
    await syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
    await flush();

    const item = syncOrchestrator.getState().queue.find((i) => i.type === 'contacts')!;
    expect(item.status).toBe('complete');
    expect(item.progress).toBe(100);
  });

  it('CONTROL: the orchestrator still carries a number for a source that has one', async () => {
    // The distinguishing input. Without it, every assertion above would pass on
    // an orchestrator that had simply stopped forwarding percentages.
    syncOrchestrator.registerSyncFunction('reindex', async (_userId, onProgress) => {
      onProgress(42, 'optimizing');
    });

    const { snapshots, stop } = captureQueues();
    await syncOrchestrator.requestSync({ types: ['reindex'], userId: 'test-user' });
    await flush();
    stop();

    const numbered = snapshots
      .map((q) => q.find((i) => i.type === 'reindex'))
      .filter((i): i is SyncItem => !!i && i.status === 'running' && !i.indeterminate);
    expect(numbered.map((i) => i.progress)).toContain(42);
  });
});
