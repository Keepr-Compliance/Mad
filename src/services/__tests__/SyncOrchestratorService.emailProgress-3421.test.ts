/**
 * BACKLOG-3421 — the emails leg reports the pre-cache's OWN progress, and never
 * a number the pre-cache did not emit.
 *
 * WHAT THE FOUNDER SAW: "it jump from 50 to sync complete there is no
 * visiabiliyt into where we are". The 50 was one hard-coded `onProgress(50)`
 * emitted BEFORE `precacheEmails` ran and held for its entire duration —
 * measured at 48.4s on his own mailbox, and he reports five minutes for some
 * users — then 100, then the completion card.
 *
 * WHY THESE TESTS DRIVE THE REAL SYNC FUNCTION. The sibling
 * `progressDetail-3128` suite deliberately re-registers synthetic sources,
 * because its claim is about the orchestrator's plumbing and holds for any
 * producer. The claim here is the opposite kind: it is about the REAL emails
 * leg subscribing to a real channel and forwarding what arrives. A synthetic
 * source would test nothing — that suite's own header records the first attempt
 * at a control that ran green because the code under test was the one thing the
 * fixture replaced.
 *
 * THE FIXTURE IS TRANSCRIBED, NOT INVENTED. Every progress payload below has
 * the shape `emailPrecacheProgress.ts` defines and the values `precacheEmails`
 * actually emits: `percent` interpolated inside the published anchors
 * (`EMAIL_PRECACHE_FETCH_RANGE`: 10..30 for the Outlook inbox, 50..54 for the
 * Gmail scan), a `stage` only while `phase` is `"fetching"`, and a terminal
 * `"done"` carrying an `outcome`.
 *
 * WITH TWO DEPARTURES. The first is deliberate and load-bearing: the run in
 * "reports no number this run did not measure" WITHHOLDS the
 * `FETCH_SECOND_PROVIDER` boundary event, which a real run emits
 * unconditionally. That omission is the only thing making that control
 * distinguishing, and its own header says so at length.
 *
 * The second is inaccuracy, recorded rather than quietly corrected so that the
 * transcription claim above is not read as covering it. Three payloads pair a
 * `stage` with a `percent` outside that round's slice — `outlook-inbox` with 34
 * twice, and `gmail-messages` with 77 — where `EMAIL_PRECACHE_FETCH_RANGE` puts
 * the inbox at 10..29, the Gmail scan and bodies at 50..69, and 77 inside
 * `gmail-labels`. Each percent and each stage is individually emittable; the
 * PAIR is not. Neither test that uses them asserts that a pair is producible:
 * one checks that an arriving payload is forwarded field for field, the other
 * that a cancel freezes the item at the earlier percent and never shows the
 * later one, and both would read identically with a producible pair. Do not
 * cite these payloads as evidence of what the producer emits.
 */

import type { SyncItem } from '../SyncOrchestratorService';

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@sentry/electron/renderer', () => ({
  addBreadcrumb: jest.fn(),
}));

// Windows, so the real `messages` leg is never registered and cannot interleave
// with the emails leg under test.
jest.mock('../../utils/platform', () => ({
  isMacOS: jest.fn(() => false),
}));

/** The progress payload the main process pushes, as the preload types it. */
type PrecacheProgress = {
  phase: 'repairing' | 'fetching' | 'swapping' | 'done';
  current: number;
  total: number;
  percent: number;
  outcome?: 'success' | 'error' | 'cancelled';
  stage?: 'outlook-inbox' | 'outlook-folders' | 'gmail-messages' | 'gmail-labels';
};

/** Subscribers currently attached to `emails:precache-progress`. */
const precacheSubscribers: Array<(p: PrecacheProgress) => void> = [];
/** How many times a subscription's cleanup function has been invoked. */
let precacheUnsubscribeCount = 0;

const onPrecacheProgress = jest.fn((callback: (p: PrecacheProgress) => void) => {
  precacheSubscribers.push(callback);
  return () => {
    precacheUnsubscribeCount += 1;
    const at = precacheSubscribers.indexOf(callback);
    if (at !== -1) precacheSubscribers.splice(at, 1);
  };
});

/** Push one event to every attached subscriber, the way the handler does. */
const emitPrecacheProgress = (p: PrecacheProgress): void => {
  precacheSubscribers.slice().forEach((cb) => cb(p));
};

const precacheEmails = jest.fn();

Object.defineProperty(global, 'window', {
  value: {
    api: {
      preferences: { get: jest.fn().mockResolvedValue({ success: false }) },
      contacts: { syncExternal: jest.fn(), syncOutlookContacts: jest.fn(), forceReimport: jest.fn() },
      transactions: {
        scan: jest.fn().mockResolvedValue({ success: true }),
        precacheEmails,
        onPrecacheProgress,
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

/** Every queue snapshot the run published, so mid-run state is readable. */
function captureQueues(): { snapshots: SyncItem[][]; stop: () => void } {
  const snapshots: SyncItem[][] = [];
  const stop = syncOrchestrator.subscribe((state: { queue: SyncItem[] }) => {
    snapshots.push(state.queue.map((item) => ({ ...item })));
  });
  return { snapshots, stop };
}

const framesFor = (snapshots: SyncItem[][], type: SyncItem['type']) =>
  snapshots.map((q) => q.find((i) => i.type === type)).filter(Boolean) as SyncItem[];

/**
 * The frames a surface would render a NUMBER from: running, and not flagged as
 * having no honest percentage. This is the dashboard's own gate
 * (`SyncStatusIndicator.tsx`: `running && !indeterminate`), restated here so the
 * assertions below are about what the user sees rather than about field values.
 */
const numberedFrames = (snapshots: SyncItem[][], type: SyncItem['type']) =>
  framesFor(snapshots, type).filter((i) => i.status === 'running' && !i.indeterminate);

/** Let the leg run to the `await` inside `precacheEmails`. */
const tick = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  precacheSubscribers.length = 0;
  precacheUnsubscribeCount = 0;
  precacheEmails.mockResolvedValue({ success: true });
  syncOrchestrator.reset();
});

describe('BACKLOG-3421 — the emails leg forwards the pre-cache percent', () => {
  it('reports the producer mid-download percent, its round and its counts', async () => {
    // MUTATION that reds this: delete the `onProgress(progress.percent, …)`
    // forward inside the `onPrecacheProgress` listener.
    let release: (() => void) | undefined;
    precacheEmails.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ success: true }); }),
    );

    const { snapshots, stop } = captureQueues();
    void syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await tick();

    emitPrecacheProgress({
      phase: 'fetching',
      stage: 'outlook-inbox',
      current: 412,
      total: 1200,
      percent: 34,
    });
    release?.();
    await flush();
    stop();

    const mid = framesFor(snapshots, 'emails').find((i) => i.progress === 34);
    expect(mid).toBeDefined();
    // The dashboard gates the number on the flag, so a forwarded real percent
    // must arrive WITHOUT it or the number is still suppressed.
    expect(mid!.indeterminate).toBeFalsy();
    expect(mid!.phase).toBe('outlook-inbox');
    expect(mid!.current).toBe(412);
    expect(mid!.total).toBe(1200);
  });

  it('reports no number this run did not measure', async () => {
    // THE CONTROL FOR THE HARD-CODED 50. The test above cannot catch its
    // return: a restored `onProgress(50)` adds a frame without removing the
    // forwarded 34, so that assertion stays green. This one enumerates every
    // number the leg put on screen and requires the producer to have emitted
    // each one.
    //
    // MUTATION: put `onProgress(50)` back before the precache invoke -> red
    // ("50 was never emitted by the producer").
    //
    // THE FIRST FORM OF THIS FIXTURE WAS VACUOUS, and running the mutation is
    // what showed it: the emitted list contained 50, because 50 is a published
    // anchor (`FETCH_SECOND_PROVIDER`). A restored hard-coded 50 was then
    // indistinguishable from the producer's own, and this test stayed green
    // under the one mutation it exists for.
    //
    // WHAT MAKES IT NON-VACUOUS NOW IS THAT THE FIXTURE WITHHOLDS AN EVENT, AND
    // NOTHING ELSE. Each percent below is one a real run can emit —
    // `FETCH_START` (10), the inbox round (21), `OUTLOOK_FOLDERS.start` (30),
    // the folder walk (44), `FETCH_DONE` (90); `interpolateFetchPercent` never
    // returns a range's `end`, so the rounds themselves top out at 29 and 49.
    // But a real Outlook-only run ALSO emits the `FETCH_SECOND_PROVIDER`
    // boundary at 50, and the list below leaves it out. That emit is
    // unconditional — `emailSyncService.ts:2569-2574` sits outside both the
    // `microsoftToken` block (which closes at `:2546`) and the `googleToken`
    // block (which opens at `:2579`), and `emitProgress` (`:2042-2047`) clamps
    // only upward, so nothing suppresses it when Gmail is absent. The
    // producer's own pinned test says so: under a microsoft-only token mock it
    // asserts the fetching series `[10, 13, 21, 29, 50, 90]`
    // (`electron/services/__tests__/emailSyncService.precacheProgress-2856.test.ts:775-797`).
    //
    // SO THIS CONTROL DISTINGUISHES A RESTORED HARD-CODED 50 ONLY BECAUSE THE
    // FIXTURE DOES NOT SUPPLY THE PRODUCER'S. Add the 50 back and it goes green
    // under its own mutation — measured in the SR review of this PR
    // (BACKLOG-3421), not merely reasoned about. Keep the enumeration for what
    // it does catch, but do not treat it as the last line of defence, and do
    // not "fix" the fixture's fidelity without replacing the guard first.
    //
    // THE GUARD NO FIXTURE CAN DEFEAT is the next test, "reports NO percentage
    // before the producer has said anything". It separates a hard-coded 50 from
    // a producer's 50 on ORDERING rather than on value: the hard-coded one is
    // written before any producer event exists, and no choice of fixture makes
    // that frame legitimate.
    let release: (() => void) | undefined;
    precacheEmails.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ success: true }); }),
    );

    const emitted = [10, 21, 30, 44, 90];
    const { snapshots, stop } = captureQueues();
    void syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await tick();

    emitted.forEach((percent) =>
      emitPrecacheProgress({
        phase: 'fetching',
        // The last event of the fetch phase is the `FETCH_DONE` boundary, which
        // names no round — hence the `undefined`.
        stage: percent === 90 ? undefined : percent < 30 ? 'outlook-inbox' : 'outlook-folders',
        current: percent * 10,
        total: 1200,
        percent,
      }),
    );
    release?.();
    await flush();
    stop();

    const rendered = numberedFrames(snapshots, 'emails').map((i) => i.progress);
    expect(rendered.length).toBeGreaterThan(0);
    rendered.forEach((percent) => expect(emitted).toContain(percent));
  });

  it('reports NO percentage before the producer has said anything', async () => {
    // The AI-scan window at the head of the leg. It has no producer, so there
    // is nothing honest to report — and the leg-start seed must not report a
    // hard "0%" either.
    //
    // MUTATION: `onProgress(0)` instead of `onProgress(0, undefined, {
    // indeterminate: true })`, or drop `indeterminate: true` from the leg-start
    // seed in `startSync` -> red.
    let release: (() => void) | undefined;
    precacheEmails.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ success: true }); }),
    );

    const { snapshots, stop } = captureQueues();
    void syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await tick();
    const beforeAnyEvent = numberedFrames(snapshots, 'emails');

    release?.();
    await flush();
    stop();

    expect(framesFor(snapshots, 'emails').length).toBeGreaterThan(0);
    expect(beforeAnyEvent).toEqual([]);
  });

  it('does not forward the terminal event percent', async () => {
    // `terminalProgress` reports the LAST percent reached on an error or a
    // cancel, not 100. Forwarding it would pin a stale number on a leg that has
    // stopped; the leg's own completion writes the 100.
    //
    // MUTATION: delete the `if (progress.phase === 'done') return;` guard -> red.
    let release: (() => void) | undefined;
    precacheEmails.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ success: true }); }),
    );

    const { snapshots, stop } = captureQueues();
    void syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await tick();

    emitPrecacheProgress({ phase: 'done', current: 0, total: 0, percent: 41, outcome: 'error' });
    release?.();
    await flush();
    stop();

    expect(framesFor(snapshots, 'emails').some((i) => i.progress === 41)).toBe(false);
  });

  it('reports no number at all when the rate limiter refuses the run', async () => {
    // Seen four times in the founder's own log: the handler returns before
    // `precacheEmails` starts, so no progress event is ever emitted and the leg
    // finishes in ~2ms. It used to show 50 and then 100 for that 2ms.
    precacheEmails.mockResolvedValue({
      success: false,
      error: 'Please wait 24 seconds before re-caching.',
      rateLimited: true,
    });

    const { snapshots, stop } = captureQueues();
    await syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await flush();
    stop();

    expect(numberedFrames(snapshots, 'emails')).toEqual([]);
    // It still finishes cleanly — no number is not the same as no outcome.
    const last = framesFor(snapshots, 'emails').pop();
    expect(last!.status).toBe('complete');
  });
});

describe('BACKLOG-3421 — the listener does not outlive the leg', () => {
  // The channel is app-global. A listener left attached would let a
  // Settings-initiated re-cache drive a dashboard row with no dashboard run
  // behind it. MUTATION for all three: delete `finally { stopListening?.(); }`.

  it('detaches when the leg completes', async () => {
    await syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await flush();

    expect(onPrecacheProgress).toHaveBeenCalledTimes(1);
    expect(precacheUnsubscribeCount).toBe(1);
    expect(precacheSubscribers).toHaveLength(0);
  });

  it('detaches when the pre-cache throws a non-fatal error', async () => {
    precacheEmails.mockRejectedValue(new Error('network down'));

    await syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await flush();

    expect(precacheUnsubscribeCount).toBe(1);
    expect(precacheSubscribers).toHaveLength(0);
  });

  it('detaches when a dead token sends the leg to an error state', async () => {
    precacheEmails.mockResolvedValue({
      success: false,
      providerError: { provider: 'microsoft', message: 'expired', tokenExpired: true },
    });

    await syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await flush();

    expect(precacheUnsubscribeCount).toBe(1);
    expect(precacheSubscribers).toHaveLength(0);
    const state = syncOrchestrator.getState();
    expect(state.queue.find((i) => i.type === 'emails')!.status).toBe('error');
  });
});

describe('BACKLOG-2776 — a cancel still freezes the number', () => {
  it('holds the last percent while the producer keeps emitting', async () => {
    // The freeze works because the orchestrator stops WRITING to the item. The
    // forwarded pre-cache events go through that same callback, so they are
    // frozen by the same gate — if they had been written straight onto the item
    // the dashboard would have carried on climbing through a cancel the user
    // had already pressed.
    //
    // MUTATION: delete the `cancelRequested` early return in the `startSync`
    // progress callback -> red (the item reads 77).
    let release: (() => void) | undefined;
    precacheEmails.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ success: true }); }),
    );

    const { snapshots, stop } = captureQueues();
    void syncOrchestrator.requestSync({ types: ['emails'], userId: 'test-user' });
    await tick();

    emitPrecacheProgress({
      phase: 'fetching',
      stage: 'outlook-inbox',
      current: 412,
      total: 1200,
      percent: 34,
    });
    expect(syncOrchestrator.markCancelRequested('emails')).toBe('running');

    emitPrecacheProgress({
      phase: 'fetching',
      stage: 'gmail-messages',
      current: 900,
      total: 1200,
      percent: 77,
    });
    await Promise.resolve();

    const duringCancel = syncOrchestrator.getState().queue.find((i) => i.type === 'emails')!;
    expect(duringCancel.progress).toBe(34);
    expect(duringCancel.phase).toBe('outlook-inbox');

    release?.();
    await flush();
    stop();

    expect(framesFor(snapshots, 'emails').some((i) => i.progress === 77)).toBe(false);
  });
});

describe('BACKLOG-3421 — the leg-start seed claims no percentage', () => {
  it('flags the first running frame as having no honest percent', async () => {
    // The ~380ms hard "0%" the investigation found on the messages leg: the item
    // was seeded `{ status: 'running', progress: 0 }` with no flag, so the
    // dashboard's gate let the 0 through until the producer's first event.
    // Registering a source that reports nothing for a tick reproduces exactly
    // that window for any leg.
    //
    // MUTATION: drop `indeterminate: true` from the seed in `startSync` -> red.
    syncOrchestrator.registerSyncFunction('messages', async () => {
      await flush();
    });

    const { snapshots, stop } = captureQueues();
    await syncOrchestrator.requestSync({ types: ['messages'], userId: 'test-user' });
    await flush();
    stop();

    const first = framesFor(snapshots, 'messages').find((i) => i.status === 'running');
    expect(first).toBeDefined();
    expect(first!.progress).toBe(0);
    expect(first!.indeterminate).toBe(true);
    // And nothing rendered a number for the whole leg.
    expect(numberedFrames(snapshots, 'messages')).toEqual([]);
  });
});
