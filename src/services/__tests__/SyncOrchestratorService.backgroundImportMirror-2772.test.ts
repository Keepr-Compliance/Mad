/**
 * BACKLOG-2772 — a macOS Messages import MAIN started becomes a queue item here.
 *
 * ## Why this suite exists separately
 *
 * `messagesSyncTrigger.test.ts` pins main's half: the trigger announces its runs
 * (started / finished, finished even on a throw). This pins the half that makes
 * the announcement worth anything — that the renderer turns it into a queue
 * item, which is what renders the Cancel button.
 *
 * Nothing else covers it, and the reason is the failure mode itself. Every other
 * orchestrator suite mocks `window.api.messages` as
 * `{ importMacOSMessages, onImportProgress }`, so the
 * `!window.api?.messages?.onBackgroundImport` guard in
 * `subscribeToBackgroundImports` makes the subscription a silent no-op in all of
 * them. A regression that broke the wiring — the preload key renamed, the
 * subscription never invoked — would leave those suites green, with no queue
 * item and no Cancel button in the app.
 *
 * The routing shape is forced by the process boundary: this queue lives in the
 * renderer and every sync function it registers dereferences `window.api`, so
 * main cannot enqueue on it. It announces; this mirrors — the EXTERNAL sync
 * item, as the iPhone sync has used since BACKLOG-2195.
 */

import type { SyncItem } from '../SyncOrchestratorService';

jest.mock('@sentry/electron/renderer', () => ({ addBreadcrumb: jest.fn() }));
jest.mock('../../utils/platform', () => ({ isMacOS: jest.fn(() => true) }));

/** The callbacks the orchestrator hands the preload bridge. */
let captured:
  | { onStarted: (s: { userId: string; reason: string }) => void;
      onFinished: (s: { userId: string; reason: string }) => void }
  | undefined;

const onBackgroundImport = jest.fn((callbacks: typeof captured) => {
  captured = callbacks;
  return () => {};
});

Object.defineProperty(global, 'window', {
  value: {
    api: {
      preferences: { get: jest.fn().mockResolvedValue({ success: true, data: {} }) },
      contacts: { syncExternal: jest.fn(), syncOutlookContacts: jest.fn(), forceReimport: jest.fn() },
      transactions: { scan: jest.fn(), precacheEmails: jest.fn().mockResolvedValue({ success: true }) },
      messages: {
        importMacOSMessages: jest.fn(),
        onImportProgress: jest.fn(() => () => {}),
        // The key whose ABSENCE silently disables the mirror everywhere else.
        onBackgroundImport,
      },
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

const messagesItem = (): SyncItem | undefined =>
  syncOrchestrator.getState().queue.find((i) => i.type === 'messages');

beforeEach(() => {
  syncOrchestrator.reset();
  captured = undefined;
  onBackgroundImport.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (syncOrchestrator as any).syncFunctions = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (syncOrchestrator as any).initialized = false;
  syncOrchestrator.initializeSyncFunctions();
});

describe("BACKLOG-2772: main's import announcement becomes a queue item", () => {
  it('subscribes on initialization', () => {
    // The wiring itself. Without the subscription there is no mirror, and the
    // guard that skips it is invisible — it neither throws nor logs.
    expect(onBackgroundImport).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
  });

  it('a started announcement produces a running EXTERNAL messages item', () => {
    expect(messagesItem()).toBeUndefined();

    captured!.onStarted({ userId: 'u1', reason: 'date-change' });

    const item = messagesItem();
    expect(item).toMatchObject({ type: 'messages', status: 'running', external: true });
  });

  it('the item is what carries the Cancel affordance', () => {
    // The renderer offers Cancel while the messages item is 'running' — the
    // `running`-not-`isImporting` gate BACKLOG-2748 established. Asserting the
    // status here is asserting the button, without reaching into the component.
    captured!.onStarted({ userId: 'u1', reason: 'create' });

    expect(messagesItem()?.status).toBe('running');
    expect(syncOrchestrator.getState().isRunning).toBe(true);
  });

  it('a finished announcement completes it', () => {
    captured!.onStarted({ userId: 'u1', reason: 'date-change' });
    captured!.onFinished({ userId: 'u1', reason: 'date-change' });

    expect(messagesItem()?.status).toBe('complete');
  });

  it('a finish with no start in flight changes nothing', () => {
    // The trigger emits finished from a `finally`, so a run that never started
    // an item can still announce a finish. `completeExternalSync` no-ops without
    // an external item, which is what makes the pair safe in either order.
    captured!.onFinished({ userId: 'u1', reason: 'export' });

    expect(messagesItem()).toBeUndefined();
  });

  it('ANTI-VACUITY: a USER-initiated messages import is never displaced by a mirrored one', () => {
    // The collision this design rests on. `updateQueueItem` matches on type
    // alone, so an internal 'messages' item and a mirrored one would fight over
    // the same row — and the mirrored one would be reported as the user's run.
    // `registerExternalSync` returns early while an item of the type is already
    // running; that early return is load-bearing and was, until this test, an
    // unpinned assumption.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (syncOrchestrator as any).setState({
      isRunning: true,
      queue: [{ type: 'messages', status: 'running', progress: 42 }],
      currentSync: 'messages',
    });

    captured!.onStarted({ userId: 'u1', reason: 'create' });

    const item = messagesItem();
    expect(item?.external).toBeUndefined();
    expect(item?.progress).toBe(42);
    expect(syncOrchestrator.getState().queue.filter((i) => i.type === 'messages')).toHaveLength(1);
  });
});
