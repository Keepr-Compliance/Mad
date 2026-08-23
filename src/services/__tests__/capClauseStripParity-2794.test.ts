/**
 * BACKLOG-2794 — the coupling between the sentence the orchestrator EMITS and
 * the regex the Settings panel STRIPS.
 *
 * ---------------------------------------------------------------------------
 * THE HAZARD
 * ---------------------------------------------------------------------------
 * `stripStaleCapClause` deletes the cap clause from the Settings completion
 * strip, because the founder removed that sentence from that surface
 * (`fa2112c8`). Its regex is number-agnostic — so correcting the FIGURE, as
 * this item does, is safe — but it is SENTENCE-anchored:
 *
 *     /^[\d,]+ messages excluded by import limit\. Adjust in Settings\.\s*!/
 *
 * Reword the producer into coverage framing and the strip silently stops
 * matching. Nothing throws, no type changes, and an exclusion sentence
 * reappears on the one surface the founder cleared of it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SUITE EXISTS SEPARATELY, AND WHAT IT DOES DIFFERENTLY
 * ---------------------------------------------------------------------------
 * The obvious control — feed the panel a hand-written copy of the current
 * sentence and assert it is stripped — CANNOT catch that reword, and I wrote it
 * that way first. Mutating the orchestrator's string reds nothing there,
 * because the test states the sentence itself: the fixture and the producer
 * drift apart in exactly the case the control was written for.
 *
 * So this suite does not restate the sentence. It RUNS the real orchestrator
 * messages sync, takes the warning it actually produced, and feeds THAT to the
 * real `stripStaleCapClause`. The two modules are pinned to each other by
 * execution rather than by a comment asking the next engineer to remember.
 *
 * Both are renderer modules, so one suite can hold both ends. Mocking is at the
 * IPC boundary only, with the counts transcribed from the founder's restore.
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

import { syncOrchestrator } from '../SyncOrchestratorService';
// The REAL strip, from the panel that owns it.
import { stripStaleCapClause } from '../../components/settings/MacOSMessagesImportSettings';

const USER = '550e8400-e29b-41d4-a716-446655440000';

/** The founder's restore: window > admitted > fetched, all distinct. */
const WINDOW = 708_400;
const ADMITTED = 62_824;
const FETCHED = 48_781;

/**
 * Run the real messages sync and return the warning it produced.
 *
 * `startSync` is private; reaching it by cast is deliberate and is what the
 * other 2794 suites do — the alternative is asserting on the sync function's
 * return value, which is not what any surface reads.
 */
async function producedWarning(result: Record<string, any>): Promise<string | undefined> {
  (window.api.messages.importMacOSMessages as unknown as jest.Mock).mockResolvedValue(result);
  (window.api.preferences.get as unknown as jest.Mock).mockResolvedValue({
    success: true,
    preferences: { messages: { source: 'macos-native' } },
  });

  syncOrchestrator.reset();
  (syncOrchestrator as any).syncFunctions = new Map();
  (syncOrchestrator as any).initialized = false;
  syncOrchestrator.initializeSyncFunctions();
  await (syncOrchestrator as any).startSync({ types: ['messages'], userId: USER });

  return syncOrchestrator.getState().queue.find((item) => item.type === 'messages')?.warning;
}

afterEach(() => {
  syncOrchestrator.reset();
});

describe('BACKLOG-2794 — producer and strip stay coupled', () => {
  it('the Settings strip removes the clause the orchestrator actually emits', async () => {
    const warning = await producedWarning({
      success: true,
      messagesImported: FETCHED,
      totalAvailable: WINDOW,
      wasCapped: true,
      coveredCount: ADMITTED,
    });

    // The producer really did emit a cap clause — otherwise the strip below
    // would have nothing to remove and would pass vacuously.
    expect(warning).toContain('645,576');
    expect(warning).toMatch(/excluded by import limit/);

    // And the strip takes ALL of it: no clause, no remnant, nothing left to
    // render on a surface the founder cleared.
    expect(stripStaleCapClause(warning)).toBeUndefined();
  });

  it('takes only the cap clause, leaving the disk-space one intact', async () => {
    // The strip is anchored so it can never eat the attachment notice, which is
    // the only warning the user gets that attachments were skipped
    // (BACKLOG-2743).
    const warning = await producedWarning({
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
    });

    const stripped = stripStaleCapClause(warning);
    expect(stripped).toBeDefined();
    expect(stripped).toContain('Attachments were not imported');
    expect(stripped).not.toMatch(/excluded by import limit/);
    expect(stripped).not.toContain('645,576');
  });
});
