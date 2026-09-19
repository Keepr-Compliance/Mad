/**
 * BACKLOG-3128 — the queue item must carry the producer's real counts, and must
 * be able to say it has no honest percentage.
 *
 * WHY THIS FILE EXISTS, AND WHY THE PANEL TEST WAS NOT ENOUGH.
 *
 * The first attempt at control (c) — "drop `current`/`total` from the
 * orchestrator's plumbing and watch the Settings panel test go red" — ran
 * GREEN. It could not have gone red: the panel suite injects a fake
 * orchestrator and sets `current`/`total` directly on the queue item, so the
 * plumbing under test is the one thing that suite never executes. It asserted
 * the panel RENDERS counts it was handed, which is a real and separate claim,
 * but it proved nothing about them arriving.
 *
 * That is the same shape as the defect this whole item is about: a check whose
 * inputs cannot distinguish pass from fail. So the plumbing is pinned here
 * instead, against the REAL `syncOrchestrator` — `registerSyncFunction` +
 * `requestSync` drive the actual `updateQueueItem` call, and deleting the two
 * lines that forward `current`/`total` turns these red.
 *
 * The rule being held: the producer has always sent real per-phase counts. They
 * had nowhere to ride, so the panel hard-coded `current: 0, total: 0` and
 * rendered them — every import displayed "0 / 0 messages", a value presented as
 * known that never was (BACKLOG-2886).
 */

import type { SyncItem } from '../SyncOrchestratorService';

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: jest.fn(),
}));

jest.mock('../../utils/platform', () => ({
  isMacOS: jest.fn(() => false),
}));

Object.defineProperty(global, 'window', {
  value: {
    api: {
      preferences: { get: jest.fn() },
      contacts: { syncExternal: jest.fn(), syncOutlookContacts: jest.fn(), forceReimport: jest.fn() },
      transactions: { scan: jest.fn(), precacheEmails: jest.fn().mockResolvedValue({ success: true }) },
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

/** Every queue snapshot the run published, so we can read mid-run state. */
function captureQueues(): { snapshots: SyncItem[][]; stop: () => void } {
  const snapshots: SyncItem[][] = [];
  const stop = syncOrchestrator.subscribe((state: { queue: SyncItem[] }) => {
    snapshots.push(state.queue.map((item) => ({ ...item })));
  });
  return { snapshots, stop };
}

/** The contacts item as it looked at each published state. */
const contactsFrames = (snapshots: SyncItem[][]) =>
  snapshots.map((q) => q.find((i) => i.type === 'contacts')).filter(Boolean) as SyncItem[];

beforeEach(() => {
  syncOrchestrator.reset();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (syncOrchestrator as any).syncFunctions = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (syncOrchestrator as any).initialized = false;
});

describe('BACKLOG-3128 — progress detail reaches the queue item', () => {
  it('carries current/total from the sync function onto the item', async () => {
    // CONTROL (c): delete `current: detail?.current` / `total: detail?.total`
    // from the updateQueueItem call and this goes red.
    syncOrchestrator.registerSyncFunction('contacts', async (_userId, onProgress) => {
      onProgress(0, 'querying', { current: 4120, total: 33637, indeterminate: true });
    });

    const { snapshots, stop } = captureQueues();
    syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    const withCounts = contactsFrames(snapshots).find((i) => i.current !== undefined);
    expect(withCounts).toBeDefined();
    expect(withCounts!.current).toBe(4120);
    expect(withCounts!.total).toBe(33637);
    expect(withCounts!.phase).toBe('querying');
  });

  it('carries the indeterminate flag, so surfaces can refuse to show a number', async () => {
    syncOrchestrator.registerSyncFunction('contacts', async (_userId, onProgress) => {
      onProgress(0, 'querying', { indeterminate: true });
    });

    const { snapshots, stop } = captureQueues();
    syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    const flagged = contactsFrames(snapshots).find((i) => i.indeterminate === true);
    expect(flagged).toBeDefined();
    // The trap this flag exists for: `progress` is 0, and `0 ?? null` is `0`, so
    // a consumer gating on the NUMBER would render "0%". Gating on the flag is
    // the only thing that works. Pinned on the surface by
    // SyncStatusIndicator.honestProgress-3128.
    expect(flagged!.progress).toBe(0);
  });

  it('leaves a source that reports no detail exactly as it was', async () => {
    // The distinguishing input. Every other sync (contacts, emails, reindex,
    // backup, ccpa-export) calls onProgress with one or two arguments and must
    // be untouched by this change — no stray `indeterminate`, no phantom counts
    // that would make an honest percentage vanish from the dashboard.
    syncOrchestrator.registerSyncFunction('contacts', async (_userId, onProgress) => {
      onProgress(50);
    });

    const { snapshots, stop } = captureQueues();
    syncOrchestrator.requestSync({ types: ['contacts'], userId: 'test-user' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    const atFifty = contactsFrames(snapshots).find((i) => i.progress === 50);
    expect(atFifty).toBeDefined();
    expect(atFifty!.current).toBeUndefined();
    expect(atFifty!.total).toBeUndefined();
    expect(atFifty!.indeterminate).toBeUndefined();
  });
});
