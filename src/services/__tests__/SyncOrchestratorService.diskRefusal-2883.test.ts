/**
 * BACKLOG-2883 — a disk-space REFUSAL reaches the queue item typed as one, and
 * BACKLOG-2882 — the attachment refusal warning states the figure compared.
 *
 * The REAL registered `messages` sync function runs through the REAL
 * `startSync`; only the IPC boundary is mocked. Result shapes are transcribed
 * from `macOSMessagesImportService`'s two `refusedForDiskSpace` returns: the
 * pre-flight refusal (`phase: "before"`, nothing written) and the mid-run
 * catch (`phase: "during"`). The `error` string is the sentence the founder's
 * log recorded for the refusal.
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

const USER = 'user-2883';

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
  mockImportMacOSMessages.mockImplementation(() => Promise.resolve(importResult));
  jest.clearAllMocks();
  require('../../utils/platform').isMacOS.mockReturnValue(true);
});

afterEach(() => {
  syncOrchestrator.reset();
});


const GiB = 2 * 1024 * 1024 * 1024;
const FOUNDER_REFUSAL =
  'Keepr needs about 3 GB of free disk space to import your messages, but only 1.2 GB is actually available.';

function refusal(phase: 'before' | 'during', error = FOUNDER_REFUSAL) {
  return {
    success: false,
    messagesImported: 0,
    messagesSkipped: 0,
    attachmentsImported: 0,
    attachmentsUpdated: 0,
    attachmentsSkipped: 0,
    duration: 12,
    error,
    refusedForDiskSpace: {
      requiredBytes: 3221225472,
      availableBytes: 1288490188,
      snapshotCount: null,
      phase,
    },
  };
}

describe('BACKLOG-2883 — the refusal is typed on the queue item', () => {
  it("marks a pre-flight refusal errorKind 'disk_space_refused'", async () => {
    importResult = refusal('before');
    const item = await runMessagesSync();
    expect(item?.status).toBe('error');
    expect(item?.errorKind).toBe('disk_space_refused');
    expect(item?.error).toBe(FOUNDER_REFUSAL);
  });

  it('classifies on the typed phase, not the text: a different message is still a refusal', async () => {
    importResult = refusal('before', 'Completely different words.');
    expect((await runMessagesSync())?.errorKind).toBe('disk_space_refused');
  });

  it('a disk that filled MID-RUN is a failure, not a refusal', async () => {
    importResult = refusal('during');
    const item = await runMessagesSync();
    expect(item?.status).toBe('error');
    expect(item?.errorKind).toBeUndefined();
  });

  it('a genuine failure carries no refusal kind', async () => {
    importResult = { success: false, messagesImported: 0, error: 'database is locked' };
    const item = await runMessagesSync();
    expect(item?.status).toBe('error');
    expect(item?.errorKind).toBeUndefined();
  });
});

describe('BACKLOG-2882 — the attachment refusal warning states the compared figure', () => {
  it('names the attachments, the headroom and their sum', async () => {
    importResult = {
      success: true,
      messagesImported: 12,
      attachmentsRefusedForSpace: {
        estimatedBytes: 39_000_000,
        availableBytes: 1_300_000_000,
        attachmentCount: 40,
        headroomBytes: GiB,
        requiredBytes: 39_000_000 + GiB,
      },
    };
    const warning = (await runMessagesSync())?.warning ?? '';
    expect(warning).toContain('they need 2.2 GB of free space');
    expect(warning).toContain('(39 MB for attachments plus 2.2 GB kept free)');
    expect(warning).toContain('only 1.3 GB is free');
    expect(warning).toContain('Messages imported normally.');
  });
});
