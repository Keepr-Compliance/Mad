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
        onImportProgress: jest.fn(() => jest.fn()),
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
