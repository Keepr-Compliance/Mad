/**
 * BACKLOG-2794 — cancelling a sync that has not started yet.
 *
 * ---------------------------------------------------------------------------
 * THE GAP
 * ---------------------------------------------------------------------------
 * A dashboard sync of ['contacts', 'emails', 'messages'] seeds all three as
 * `pending` and runs them in order, so the messages leg sits queued for the
 * whole of the two ahead of it — minutes on a real library. Cancel was gated on
 * `status === 'running'` at BOTH ends (the settings panel's `cancelAvailable`
 * and the orchestrator's `markCancelRequested`), so for those minutes the user
 * had an import they could watch and could not stop.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THIS SUITE EXISTS TO PIN
 * ---------------------------------------------------------------------------
 * The sequential runner iterates **`validTypes`**, not `this.state.queue`. The
 * queue is a PROJECTION built from that array at the top of `startSync`. So the
 * obvious reading of "a pending cancel = remove it from the queue" produces a
 * button that removes its own evidence and runs the import anyway: the pill
 * disappears, chat.db is read, messages are stored.
 *
 * Hence the assertion that carries this file: **`importMacOSMessages` is never
 * called.** A queue-only removal passes "the row is gone" and fails this.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT MOCKED
 * ---------------------------------------------------------------------------
 * The REAL registered sync functions run through the REAL `startSync`. Timing
 * is controlled at the IPC boundary only: `contacts.syncExternal` blocks on a
 * gate this suite releases, which is what holds the messages leg in `pending`
 * exactly as a slow contacts sync does in production.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: jest.fn(),
}));

jest.mock('../../utils/platform', () => ({
  isMacOS: jest.fn(() => true),
}));

/** What `messages:import-macos` resolves to, when it is reached at all. */
let importResult: Record<string, any> = { success: true, messagesImported: 5 };

const mockImportMacOSMessages = jest.fn(() => Promise.resolve(importResult));

/** Held open to keep the contacts leg running and the messages leg pending. */
let releaseContacts: () => void = () => {};
const mockSyncExternal = jest.fn(() => Promise.resolve({ success: true }));

Object.defineProperty(global, 'window', {
  value: {
    api: {
      preferences: {
        get: jest.fn(() =>
          Promise.resolve({ success: true, preferences: { messages: { source: 'macos-native' } } })
        ),
      },
      messages: {
        importMacOSMessages: mockImportMacOSMessages,
        onImportProgress: jest.fn(() => jest.fn()),
      },
      contacts: {
        syncExternal: mockSyncExternal,
        syncOutlookContacts: jest.fn(() => Promise.resolve({ success: true, count: 0 })),
        syncGoogleContacts: jest.fn(() => Promise.resolve({ success: true, count: 0 })),
        forceReimport: jest.fn(),
      },
      transactions: { scan: jest.fn(), precacheEmails: jest.fn().mockResolvedValue({ success: true }) },
      notification: { send: jest.fn() },
      system: { reindexDatabase: jest.fn() },
      databaseBackup: { backup: jest.fn(), restore: jest.fn() },
      privacy: { exportData: jest.fn(), onExportProgress: jest.fn() },
    },
  },
  writable: true,
});

const { syncOrchestrator } =
  require('../SyncOrchestratorService') as typeof import('../SyncOrchestratorService');
import type { SyncItem, SyncType } from '../SyncOrchestratorService';

const USER = '550e8400-e29b-41d4-a716-446655440000';

function itemFor(type: SyncType): SyncItem | undefined {
  return syncOrchestrator.getState().queue.find((item) => item.type === type);
}

/** Let queued microtasks drain, so the loop advances to where it is going. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Hold the contacts leg open; returns a starter for the run. */
function gateContacts(): void {
  mockSyncExternal.mockImplementation(
    () =>
      new Promise((resolve) => {
        releaseContacts = () => resolve({ success: true });
      })
  );
}

beforeEach(() => {
  syncOrchestrator.reset();
  (syncOrchestrator as any).syncFunctions = new Map();
  (syncOrchestrator as any).initialized = false;
  importResult = { success: true, messagesImported: 5 };
  releaseContacts = () => {};
  jest.clearAllMocks();
  mockImportMacOSMessages.mockImplementation(() => Promise.resolve(importResult));
  mockSyncExternal.mockImplementation(() => Promise.resolve({ success: true }));
  require('../../utils/platform').isMacOS.mockReturnValue(true);
  syncOrchestrator.initializeSyncFunctions();
});

afterEach(() => {
  releaseContacts();
  syncOrchestrator.reset();
});

describe('BACKLOG-2794 — cancelling a PENDING sync', () => {
  it('never invokes the sync: the import IPC is not called at all', async () => {
    gateContacts();
    const run = (syncOrchestrator as any).startSync({
      types: ['contacts', 'messages'],
      userId: USER,
    });
    await settle();

    // The state the founder was stuck looking at.
    expect(itemFor('contacts')?.status).toBe('running');
    expect(itemFor('messages')?.status).toBe('pending');

    expect(syncOrchestrator.markCancelRequested('messages')).toBe('skipped');

    releaseContacts();
    await run;

    // THE assertion. The runner walks `validTypes`, so a fix that only edited
    // the queue would let the import run with its row already off the screen.
    expect(mockImportMacOSMessages).not.toHaveBeenCalled();
    expect(itemFor('messages')?.status).toBe('skipped');
    expect(itemFor('messages')?.cancelled).toBe(true);
    expect(itemFor('messages')?.status).not.toBe('error');
  });

  it('leaves the rest of the run alone', async () => {
    gateContacts();
    const run = (syncOrchestrator as any).startSync({
      types: ['contacts', 'messages'],
      userId: USER,
    });
    await settle();
    syncOrchestrator.markCancelRequested('messages');
    releaseContacts();
    await run;

    // Cancelling one leg is not cancelling the sync.
    expect(mockSyncExternal).toHaveBeenCalledTimes(1);
    expect(itemFor('contacts')?.status).toBe('complete');
  });

  it('clears cancelRequested, so the item is not left mid-cancel forever', async () => {
    gateContacts();
    const run = (syncOrchestrator as any).startSync({
      types: ['contacts', 'messages'],
      userId: USER,
    });
    await settle();
    syncOrchestrator.markCancelRequested('messages');

    // Between the press and the loop reaching it, the flag is what relabels
    // every surface reading this item (BACKLOG-2776).
    expect(itemFor('messages')?.cancelRequested).toBe(true);

    releaseContacts();
    await run;

    // Once served it must go, or the NEXT run renders already-cancelling.
    expect(itemFor('messages')?.cancelRequested).toBeUndefined();
  });

  it('is idempotent — a second press changes nothing', async () => {
    gateContacts();
    const run = (syncOrchestrator as any).startSync({
      types: ['contacts', 'messages'],
      userId: USER,
    });
    await settle();

    expect(syncOrchestrator.markCancelRequested('messages')).toBe('skipped');
    expect(syncOrchestrator.markCancelRequested('messages')).toBe('none');

    releaseContacts();
    await run;
    expect(mockImportMacOSMessages).not.toHaveBeenCalled();
  });

  it('reports what it did, so the caller knows whether to send the IPC', async () => {
    // The panel sends `messages:cancel` ONLY for a running import: on a pending
    // leg there is nothing to cancel, and `requestCancellation()` would ARM one
    // for the next import to start (BACKLOG-2776) — a press that stops a run
    // the user never asked it to stop.
    gateContacts();
    const run = (syncOrchestrator as any).startSync({
      types: ['contacts', 'messages'],
      userId: USER,
    });
    await settle();

    expect(syncOrchestrator.markCancelRequested('messages')).toBe('skipped');
    expect(syncOrchestrator.markCancelRequested('emails')).toBe('none'); // not in this run

    releaseContacts();
    await run;
  });
});

describe('BACKLOG-2794 — the pending→running boundary', () => {
  it('takes the RUNNING path when the leg has already started', async () => {
    // The other ordering: the press lands after the loop moved on. The leg is
    // running, so it is acknowledged and the caller owes the IPC — the import
    // returns its own cancelled result, exactly as BACKLOG-2748 established.
    let releaseImport: (value: any) => void = () => {};
    mockImportMacOSMessages.mockImplementation(
      () => new Promise((resolve) => { releaseImport = resolve; })
    );

    const run = (syncOrchestrator as any).startSync({ types: ['messages'], userId: USER });
    await settle();

    expect(itemFor('messages')?.status).toBe('running');
    expect(syncOrchestrator.markCancelRequested('messages')).toBe('running');
    expect(itemFor('messages')?.cancelRequested).toBe(true);

    releaseImport({ success: true, messagesImported: 812, cancelled: true });
    await run;

    // The run really did happen and really was cancelled — not skipped.
    expect(mockImportMacOSMessages).toHaveBeenCalledTimes(1);
    expect(itemFor('messages')?.status).toBe('complete');
    expect(itemFor('messages')?.cancelled).toBe(true);
    expect(itemFor('messages')?.importedCount).toBe(812);
  });
});

describe('BACKLOG-2794 — a skip belongs to one run', () => {
  it('does not suppress the NEXT sync of the same type', async () => {
    gateContacts();
    const first = (syncOrchestrator as any).startSync({
      types: ['contacts', 'messages'],
      userId: USER,
    });
    await settle();
    syncOrchestrator.markCancelRequested('messages');
    releaseContacts();
    await first;
    expect(mockImportMacOSMessages).not.toHaveBeenCalled();

    // The user asks again. A skip that outlived its run would drop this leg
    // silently — the failure `cancelRequested` had before the orchestrator
    // began clearing it (BACKLOG-2776).
    await (syncOrchestrator as any).startSync({ types: ['messages'], userId: USER });

    expect(mockImportMacOSMessages).toHaveBeenCalledTimes(1);
    expect(itemFor('messages')?.status).toBe('complete');
  });

  it('does not survive a run that was abandoned before reaching the leg', async () => {
    // Reds only when BOTH clears are gone (`startSync` seeds empty, `cancel()`
    // drops the run's skips) — either alone closes this hole, and both are
    // cheap. Stated rather than implied, so nobody reads one green as proof of
    // two guards.
    gateContacts();
    const run = (syncOrchestrator as any).startSync({
      types: ['contacts', 'messages'],
      userId: USER,
    });
    await settle();
    syncOrchestrator.markCancelRequested('messages');

    syncOrchestrator.cancel();
    releaseContacts();
    await run;

    await (syncOrchestrator as any).startSync({ types: ['messages'], userId: USER });

    expect(mockImportMacOSMessages).toHaveBeenCalledTimes(1);
  });
});
