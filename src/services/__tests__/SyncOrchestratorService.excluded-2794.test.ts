/**
 * BACKLOG-2794 — what the dashboard says the import limit left out, and what it
 * says when an import collides with one already running.
 *
 * ---------------------------------------------------------------------------
 * 1. THE ARITHMETIC
 * ---------------------------------------------------------------------------
 * The founder's restore, 2026-08-22: a 708,400-message window, a 50,000 cap,
 * deals whose audit periods are exempt from it. The run ADMITTED 62,824 and
 * FETCHED 48,781 — a delta import does not re-download the 14,042 it already
 * had. The orchestrator computed `totalAvailable - messagesImported` and told
 * him **659,619 messages excluded by import limit**. The honest figure is
 * `totalAvailable - coveredCount` = 645,576 (`a14b3a82`).
 *
 * Both numbers are asserted in every arithmetic case here, and that is
 * deliberate: the positive alone passes on any formula that happens to land on
 * 645,576 from other inputs, and the negative alone passes on a build that
 * emits no sentence at all. The fixture separates all three quantities
 * (window > admitted > fetched) so no two can be confused for one another.
 *
 * ---------------------------------------------------------------------------
 * 2. THE COLLISION
 * ---------------------------------------------------------------------------
 * `macOSMessagesImportService` serializes to one import at a time and refuses
 * the second caller with `success: false`. The orchestrator threw on that, so a
 * transaction-trigger import running when the user pressed Sync painted a red
 * "Import failed" pill AND escalated the whole run to "Sync Completed with
 * Errors" with a support-ticket link — for a sync in which everything else
 * worked. The refusal now carries `alreadyInProgress` and the leg coalesces.
 *
 * The last case is the anti-vacuity one: a GENUINE failure must still error, or
 * "never paint the messages leg red" would be a passing implementation of this
 * whole file.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT MOCKED
 * ---------------------------------------------------------------------------
 * The REAL registered `messages` sync function runs, driven through the REAL
 * `startSync`, so what gets asserted is the queue item the dashboard actually
 * reads. The arithmetic under test is performed by the code under test — the
 * mock supplies the three counts the main process supplies and nothing else;
 * no expected string is fed in and echoed back.
 *
 * The only mocks are at the IPC boundary. The result shapes are transcribed
 * from `macOSMessagesImportService`'s own returns:
 * `{ success, messagesImported, totalAvailable, wasCapped, coveredCount }` from
 * the success path (`coveredCount: targetMessageCount`), and
 * `{ success: false, error: "Import already in progress", alreadyInProgress: true }`
 * from the concurrency refusal.
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

/** The founder's restore, in the three quantities that must stay separate. */
const WINDOW = 708_400;
const ADMITTED = 62_824;
const FETCHED = 48_781;
/** window − admitted. What the limit actually left out. */
const RIGHT_EXCLUDED = '645,576';
/** window − fetched. What the dashboard said, counting present messages as lost. */
const WRONG_EXCLUDED = '659,619';

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

describe('BACKLOG-2794 — the excluded count is window minus ADMITTED', () => {
  it('reports 645,576 excluded, not the 659,619 the founder was shown', async () => {
    importResult = {
      success: true,
      messagesImported: FETCHED,
      totalAvailable: WINDOW,
      wasCapped: true,
      coveredCount: ADMITTED,
    };

    const item = await runMessagesSync();

    expect(item?.warning).toContain(RIGHT_EXCLUDED);
    // The old formula's answer, named. Without this the positive assertion
    // passes on any build whose arithmetic happens to reach 645,576.
    expect(item?.warning).not.toContain(WRONG_EXCLUDED);
    expect(item?.warning).toBe(
      '645,576 messages excluded by import limit. Adjust in Settings.'
    );
  });

  it('subtracts the admitted count even when nothing new was fetched', async () => {
    // The delta case at its extreme: the store already held everything the plan
    // admits, so the run stored 0. `window - imported` would report the ENTIRE
    // window as excluded — 708,400 messages "left out" of an import that left
    // out 645,576 and had the rest.
    importResult = {
      success: true,
      messagesImported: 0,
      totalAvailable: WINDOW,
      wasCapped: true,
      coveredCount: ADMITTED,
    };

    const item = await runMessagesSync();

    expect(item?.warning).toContain(RIGHT_EXCLUDED);
    expect(item?.warning).not.toContain('708,400');
  });

  it('says nothing when the limit excluded nothing (the zero line)', async () => {
    // A capped run whose admitted set IS the window: the cap was in play and
    // truncated nothing. "0 messages excluded by import limit" is noise about a
    // limit that did not act (`ebc4bcd5`, and 2749's M23 settings-side).
    importResult = {
      success: true,
      messagesImported: 12,
      totalAvailable: 4_000,
      wasCapped: true,
      coveredCount: 4_000,
    };

    const item = await runMessagesSync();

    expect(item?.warning).toBeUndefined();
  });

  it('says nothing rather than something wrong when coveredCount is absent', async () => {
    // Without the admitted count the correct figure cannot be computed, and the
    // wrong one is what this item exists to remove. Silence is the fallback.
    importResult = {
      success: true,
      messagesImported: FETCHED,
      totalAvailable: WINDOW,
      wasCapped: true,
    };

    const item = await runMessagesSync();

    expect(item?.warning).toBeUndefined();
  });

  it('still carries the disk-space clause, which is a different fact', async () => {
    // BACKLOG-2743's clause is the only notice that attachments were skipped.
    // It must survive both the zero-suppression and the cap clause beside it.
    importResult = {
      success: true,
      messagesImported: FETCHED,
      totalAvailable: WINDOW,
      wasCapped: true,
      coveredCount: ADMITTED,
      attachmentsRefusedForSpace: {
        estimatedBytes: 40e9,
        availableBytes: 5e9,
        attachmentCount: 900,
      },
    };

    const item = await runMessagesSync();

    expect(item?.warning).toContain(RIGHT_EXCLUDED);
    expect(item?.warning).toContain('Attachments were not imported');
    expect(item?.warning).not.toContain(WRONG_EXCLUDED);
  });

  it('carries the space clause ALONE when the limit excluded nothing', async () => {
    importResult = {
      success: true,
      messagesImported: 12,
      totalAvailable: 4_000,
      wasCapped: true,
      coveredCount: 4_000,
      attachmentsRefusedForSpace: {
        estimatedBytes: 40e9,
        availableBytes: 5e9,
        attachmentCount: 900,
      },
    };

    const item = await runMessagesSync();

    expect(item?.warning).toContain('Attachments were not imported');
    expect(item?.warning).not.toContain('excluded by import limit');
  });
});

describe('BACKLOG-2794 — a collision coalesces instead of painting an error', () => {
  it('does not error when the import service is already busy', async () => {
    importResult = {
      success: false,
      messagesImported: 0,
      error: 'Import already in progress',
      alreadyInProgress: true,
    };

    const item = await runMessagesSync();

    expect(item?.status).toBe('complete');
    expect(item?.status).not.toBe('error');
    expect(item?.error).toBeUndefined();
    // The typed discriminator the surfaces read, so neither has to decide from
    // the fact that a complete item imported nothing.
    expect(item?.coalesced).toBe(true);
  });

  it('does not silence the run — a collision is not a cancel', async () => {
    // `cancelled` suppresses the dashboard's completion card entirely
    // (BACKLOG-2330/2748). Reusing it here would hide "Sync Complete" for the
    // contacts and emails legs that really did run.
    importResult = {
      success: false,
      messagesImported: 0,
      error: 'Import already in progress',
      alreadyInProgress: true,
    };

    const item = await runMessagesSync();

    expect(item?.cancelled).toBeUndefined();
  });

  it('branches on the FLAG, never on the error text', async () => {
    /*
     * WHAT THIS DOES AND DOES NOT COVER — stated because the earlier version of
     * this test claimed the second one.
     *
     * It used to read "coalesces the force-reimport refusal too", with a fixture
     * restating that refusal's exact wording. That title implies the SERVICE
     * sets `alreadyInProgress` on its force-reimport gate, and this test cannot
     * see the service at all: SR deleted the flag at that site and 12,650 tests
     * stayed green. A fixture repeating what a producer emits cannot fail when
     * the producer stops emitting it — the same defect as the strip guard, one
     * file over. That site is now driven for real in
     * `macOSMessagesImportService.coveredCount-2794.test.ts`
     * ("refuses a delta import while a FORCE re-import holds the service").
     *
     * What is genuinely pinned HERE is the consumer's rule: the orchestrator
     * coalesces on the typed discriminator and never parses the message. So the
     * fixture deliberately carries wording no branch could match, and the flag
     * is the only thing telling it what to do — which is what lets the service
     * add or reword a refusal without this decision going stale.
     */
    importResult = {
      success: false,
      messagesImported: 0,
      error: 'Refused: some future wording nobody has string-matched',
      alreadyInProgress: true,
    };

    const item = await runMessagesSync();

    expect(item?.status).toBe('complete');
    expect(item?.coalesced).toBe(true);
    expect(item?.error).toBeUndefined();
  });

  it('ANTI-VACUITY: a genuine failure still paints the error row', async () => {
    // Without this case, "the messages leg never errors" would pass every
    // assertion above — and a dead chat.db, a permissions refusal or a crashed
    // import would go to the user as a clean sync.
    importResult = {
      success: false,
      messagesImported: 0,
      error: 'Cannot open chat.db: permission denied',
    };

    const item = await runMessagesSync();

    expect(item?.status).toBe('error');
    expect(item?.error).toBe('Cannot open chat.db: permission denied');
    expect(item?.coalesced).toBeUndefined();
  });
});
