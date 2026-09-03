/**
 * BACKLOG-2748 — a user cancel must survive the trip from the main process to
 * the settings panel, and must not be mistaken for either a failure or a
 * clean finish.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS
 * ---------------------------------------------------------------------------
 * The import reports a cancel in TWO different shapes, because it can be
 * cancelled in two places (`macOSMessagesImportService.ts`):
 *
 *   - during the QUERY phase, before anything is stored:
 *       { success: false, error: "Import cancelled", cancelled: true }
 *   - after it, once messages are already written:
 *       { success: true, messagesImported: <partial>, cancelled: true }
 *
 * The orchestrator's messages sync function throws on any non-success result.
 * So without a cancel branch placed BEFORE that throw, pressing Cancel early
 * paints a red "Import failed" card, and pressing it late paints a green
 * "Successfully imported N new messages" — two wrong answers for one action,
 * neither of them "cancelled".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT MOCKED
 * ---------------------------------------------------------------------------
 * The REAL registered `messages` sync function runs, driven through the REAL
 * `startSync`, so the queue item the settings panel actually reads is what gets
 * asserted — not the sync function's return value in isolation. The only mocks
 * are at the IPC boundary: `window.api.messages.importMacOSMessages` (whose
 * result shapes are transcribed above from the service's own returns) and
 * `window.api.preferences.get`, which must say `macos-native` or the sync
 * early-returns without importing anything.
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

/** What `messages:import-macos` resolves to on the run being measured. */
let importResult: Record<string, any> = {};

/** The progress callback the messages sync registers on the IPC bridge. */
let progressHandler: ((data: any) => void) | null = null;

const mockImportMacOSMessages = jest.fn(() => Promise.resolve(importResult));

Object.defineProperty(global, 'window', {
  value: {
    api: {
      preferences: {
        // macOS must be the active source or the messages sync skips the import.
        get: jest.fn(() =>
          Promise.resolve({ success: true, preferences: { messages: { source: 'macos-native' } } })
        ),
      },
      messages: {
        importMacOSMessages: mockImportMacOSMessages,
        // BACKLOG-2776: the sync function owns this listener, so capturing what
        // it registers is how a test drives real progress through the real
        // orchestrator path rather than poking `progress` onto the item.
        onImportProgress: jest.fn((handler: (data: any) => void) => {
          progressHandler = handler;
          return jest.fn();
        }),
      },
      contacts: {
        syncExternal: jest.fn(),
        syncOutlookContacts: jest.fn(),
        syncGoogleContacts: jest.fn(),
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
import type { SyncItem } from '../SyncOrchestratorService';

const USER = '550e8400-e29b-41d4-a716-446655440000';

/**
 * The messages queue item as the settings panel would read it, after a full
 * real `startSync` run.
 */
async function runMessagesSync(): Promise<SyncItem | undefined> {
  syncOrchestrator.initializeSyncFunctions();
  await (syncOrchestrator as any).startSync({ types: ['messages'], userId: USER });
  return syncOrchestrator.getState().queue.find((item) => item.type === 'messages');
}

beforeEach(() => {
  syncOrchestrator.reset();
  (syncOrchestrator as any).syncFunctions = new Map();
  (syncOrchestrator as any).initialized = false;
  importResult = {};
  progressHandler = null;
  mockImportMacOSMessages.mockImplementation(() => Promise.resolve(importResult));
  jest.clearAllMocks();
  require('../../utils/platform').isMacOS.mockReturnValue(true);
});

afterEach(() => {
  syncOrchestrator.reset();
});

describe('BACKLOG-2748 — a cancelled import reaches the UI as a cancel', () => {
  it('carries the cancel and the PARTIAL count when messages were already stored', async () => {
    // The late shape: the batch loop broke, what was written is kept.
    importResult = { success: true, messagesImported: 12_431, cancelled: true };

    const item = await runMessagesSync();

    expect(item?.status).toBe('complete');
    expect(item?.cancelled).toBe(true);
    // The real count from the main process, not the number the run was aiming at.
    expect(item?.importedCount).toBe(12_431);
    expect(item?.error).toBeUndefined();
  });

  it('does NOT become an error when the cancel landed during the query phase', async () => {
    // The early shape. `success: false` here is the pre-existing contract, and
    // the throw it would otherwise trigger is exactly what turned the user's own
    // Cancel press into a red "Import failed" card.
    importResult = {
      success: false,
      messagesImported: 0,
      error: 'Import cancelled',
      cancelled: true,
    };

    const item = await runMessagesSync();

    expect(item?.status).toBe('complete');
    expect(item?.status).not.toBe('error');
    expect(item?.cancelled).toBe(true);
    expect(item?.importedCount).toBe(0);
  });

  it('CONTROL: a genuine failure is still an error, not swallowed as a cancel', async () => {
    // The cancel branch is placed before the throw, so it could plausibly eat
    // real failures. It must key on the flag alone, never on the error text.
    importResult = {
      success: false,
      messagesImported: 0,
      error: 'database is locked',
    };

    const item = await runMessagesSync();

    expect(item?.status).toBe('error');
    expect(item?.error).toBe('database is locked');
    expect(item?.cancelled).toBeFalsy();
  });

  it('CONTROL: an uncancelled import completes without the cancel flag', async () => {
    // The distinguishing input for the first test: if `cancelled` were pinned
    // true anywhere on the path, this row would red.
    importResult = { success: true, messagesImported: 500 };

    const item = await runMessagesSync();

    expect(item?.status).toBe('complete');
    expect(item?.cancelled).toBeFalsy();
    expect(item?.importedCount).toBe(500);
  });
});

describe('BACKLOG-2775 — a rolled back force re-import reaches the UI as "nothing changed"', () => {
  it('carries rolledBack alongside the cancel', async () => {
    // The shape a cancelled FORCE re-import returns: the clear and the
    // re-import shared a transaction that rolled back, so the counts are 0 and
    // the store is untouched. The panel needs the flag to say so — with only
    // `cancelled` it would render "Import cancelled." over a run that, as far
    // as the user can tell, may or may not have eaten their messages.
    importResult = {
      success: false,
      messagesImported: 0,
      error: 'Import cancelled',
      cancelled: true,
      rolledBack: true,
    };

    const item = await runMessagesSync();

    expect(item?.status).toBe('complete');
    expect(item?.cancelled).toBe(true);
    expect(item?.rolledBack).toBe(true);
    expect(item?.importedCount).toBe(0);
  });

  it('CONTROL: a cancelled DELTA import carries no rolledBack and keeps its partial count', async () => {
    // The distinguishing input. A `rolledBack` pinned true anywhere on this
    // path would tell a user who cancelled a long delta import that nothing
    // changed, when in fact 12,431 messages had been imported and kept.
    importResult = { success: true, messagesImported: 12_431, cancelled: true };

    const item = await runMessagesSync();

    expect(item?.cancelled).toBe(true);
    expect(item?.rolledBack).toBeFalsy();
    expect(item?.importedCount).toBe(12_431);
  });
});

describe('BACKLOG-2776 — the reported progress freezes when the user asks to cancel', () => {
  /** Start a run that stays in flight until the returned `finish` is called. */
  async function startPausedRun(): Promise<{ finish: () => Promise<void> }> {
    let release: (value: Record<string, any>) => void = () => {};
    mockImportMacOSMessages.mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; })
    );

    syncOrchestrator.initializeSyncFunctions();
    const run = (syncOrchestrator as any).startSync({ types: ['messages'], userId: USER });

    // Let the sync function get as far as registering its progress listener.
    while (!progressHandler) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return {
      finish: async () => {
        release({ success: true, messagesImported: 0, cancelled: true, rolledBack: true });
        await run;
      },
    };
  }

  const messagesProgress = () =>
    syncOrchestrator.getState().queue.find((item) => item.type === 'messages')?.progress;

  const emit = async (phase: string, percent: number) => {
    progressHandler?.({ phase, percent });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('stops advancing the percentage after markCancelRequested', async () => {
    // The founder watched the percentage climb 34% -> 35% through a cancel he
    // had already pressed twice, while the service was inside an
    // uninterruptible 35-second delete. The work genuinely continues until the
    // run can stop; reporting it as progress is what made the cancel look
    // ignored.
    //
    // BACKLOG-2793: these emissions used to name the `deleting` phase. That
    // phase no longer exists, and an unknown phase takes the `indexOf` === -1
    // fallback — which would have left this suite green while exercising none
    // of the weighting. Driven with a phase the importer actually emits.
    const { finish } = await startPausedRun();

    await emit('querying', 34);
    const atCancel = messagesProgress();
    expect(atCancel).toBeGreaterThan(0);

    syncOrchestrator.markCancelRequested('messages');
    expect(
      syncOrchestrator.getState().queue.find((item) => item.type === 'messages')?.cancelRequested
    ).toBe(true);

    // The import keeps running and keeps reporting. The UI must not.
    await emit('querying', 99);
    await emit('importing', 50);

    expect(messagesProgress()).toBe(atCancel);

    await finish();
  });

  it('CONTROL: without the cancel the same events DO advance the percentage', async () => {
    // The distinguishing input: if progress had simply stopped flowing — a
    // detached listener, a dropped event shape — the test above would be green
    // for a reason that has nothing to do with cancelling.
    const { finish } = await startPausedRun();

    await emit('querying', 34);
    const first = messagesProgress();

    await emit('querying', 99);
    await emit('importing', 50);

    expect(messagesProgress()).not.toBe(first);

    await finish();
  });

  it('clears the flag when the run ends, so the next import is not born frozen', async () => {
    const { finish } = await startPausedRun();

    syncOrchestrator.markCancelRequested('messages');
    await finish();

    const item = syncOrchestrator.getState().queue.find((queued) => queued.type === 'messages');
    expect(item?.status).toBe('complete');
    expect(item?.cancelRequested).toBeFalsy();
  });

  it('ignores a cancel mark for a sync that is not running', async () => {
    // The acknowledgement must describe something real: there is no run to
    // freeze, so there is nothing to say.
    syncOrchestrator.markCancelRequested('messages');

    expect(
      syncOrchestrator.getState().queue.find((item) => item.type === 'messages')
    ).toBeUndefined();
  });

  it('BACKLOG-2793: weights each phase against a FIXED three-phase divisor', async () => {
    // Until BACKLOG-2793 this divisor switched between 3 and 4 at runtime,
    // latching to 4 the first time a `deleting` event arrived. Stage-and-swap
    // removed that phase, so the branch was dead and the divisor is now a
    // constant — but nothing asserted the constant, and a deletion that quietly
    // shifts the progress math is exactly the failure this item must not ship.
    //
    // EXACT values, not ranges: with the old n=4 the same inputs give 25 and 75
    // rather than 33 and 66, so leaving the divisor at 4 turns this red. Ranges
    // or `toBeGreaterThan` would not distinguish them, and the test would be
    // green for a reason unrelated to what it claims.
    const { finish } = await startPausedRun();

    await emit('querying', 99);
    expect(messagesProgress()).toBe(33); // n=4 would give 25

    await emit('importing', 99);
    expect(messagesProgress()).toBe(66); // n=4 would give 75

    await emit('attachments', 99);
    expect(messagesProgress()).toBe(100);

    await finish();
  });
});
