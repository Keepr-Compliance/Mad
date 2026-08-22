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

  it("BLOCKER: a PENDING internal messages item is not evicted by a mirrored run", async () => {
    /*
     * The interleaving SR found, and the reason the `running`-only guard below
     * was not enough.
     *
     * `startSync` seeds EVERY requested type as `pending` and runs them
     * sequentially, so on a full sync `messages` sits pending for the whole of
     * the contacts and emails syncs ahead of it — minutes, routinely. Daniel
     * creates a transaction with an early start date inside that window; the
     * trigger announces STARTED.
     *
     * Pre-fix, that announcement filtered the pending internal item out and
     * replaced it with an external one. Then `updateQueueItem` (which matches
     * on type alone) drove the mirrored row from the user's own import, and the
     * trigger's FINISHED marked it complete at 100% and removed it three
     * seconds later — while the user's import was still running. Row gone,
     * Cancel gone, and a completion reported that never happened.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (syncOrchestrator as any).setState({
      isRunning: true,
      queue: [
        { type: 'emails', status: 'running', progress: 30 },
        { type: 'messages', status: 'pending', progress: 0 },
      ],
      currentSync: 'emails',
    });

    captured!.onStarted({ userId: 'u1', reason: 'date-change' });

    const item = messagesItem();
    // Still the USER's row: internal, still pending, still waiting its turn.
    expect(item?.external).toBeUndefined();
    expect(item?.status).toBe('pending');
    expect(syncOrchestrator.getState().queue).toHaveLength(2);
  });

  it("BLOCKER: a finish cannot complete a run the mirror never owned", () => {
    // The second half of the same defect. Even having correctly declined to
    // mirror, a FINISHED announcement must not reach across and complete the
    // user's item — `completeExternalSync` matches `type && external`, and the
    // pending row is neither finished nor external.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (syncOrchestrator as any).setState({
      isRunning: true,
      queue: [
        { type: 'emails', status: 'running', progress: 30 },
        { type: 'messages', status: 'pending', progress: 0 },
      ],
      currentSync: 'emails',
    });

    captured!.onStarted({ userId: 'u1', reason: 'date-change' });
    captured!.onFinished({ userId: 'u1', reason: 'date-change' });

    const item = messagesItem();
    expect(item?.status).toBe('pending');
    expect(item?.status).not.toBe('complete');
    expect(item?.progress).toBe(0);
  });

  it("BLOCKER (reverse order): a user's sync starting takes the row back, leaving exactly one", () => {
    // The mirror image. A mirrored run is in flight when Daniel starts a full
    // sync. `startSync` used to preserve every external item and then append a
    // fresh internal one of the same type, so the queue held TWO rows typed
    // 'messages' — and `updateQueueItem` maps over every match, so both moved
    // together while the trigger's FINISHED completed one of them.
    captured!.onStarted({ userId: 'u1', reason: 'create' });
    expect(messagesItem()?.external).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (syncOrchestrator as any).syncFunctions = new Map([
      ['messages', jest.fn(async () => new Promise(() => {}))],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (syncOrchestrator as any).startSync({ types: ['messages'], userId: 'u1' });

    const rows = syncOrchestrator.getState().queue.filter((i) => i.type === 'messages');
    expect(rows).toHaveLength(1);
    expect(rows[0].external).toBeUndefined();
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
