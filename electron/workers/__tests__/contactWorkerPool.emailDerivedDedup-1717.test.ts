/**
 * @jest-environment node
 *
 * BACKLOG-1717 — two reads for different mailboxes must not collide.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * The pool de-duplicates in-flight queries so two surfaces opening at once do
 * not run the same read twice. Its key was `${userId}:${type}` — which was
 * exactly right while every query type took no arguments beyond the user.
 *
 * `emailDerived` takes the set of mailboxes to read. Under the old key, a read
 * for `["outlook"]` and a read for `["outlook","gmail"]` are the SAME key, so
 * the second caller is handed the first's promise and receives an answer for a
 * set of mailboxes it did not ask for. Gmail people appear in a picker opened
 * with Gmail off, or vanish from one opened with it on.
 *
 * It needs no contrivance to reach: the user flips the Gmail switch while a
 * picker read is in flight, or two surfaces load either side of a toggle
 * change.
 *
 * ===========================================================================
 * WHY THE WORKER IS A STUB HERE
 * ===========================================================================
 * This is about the POOL's bookkeeping, not the worker's SQL — so the worker
 * is a stub that records what it is sent and answers only when a test tells it
 * to. Dedup is a property of an IN-FLIGHT query, so each control asserts while
 * both queries are still outstanding and settles them afterwards. The worker's
 * own behaviour is controlled against a real
 * thread in `contactWorkerPool.drain-2553.test.ts` and against a real database
 * in `services/db/__tests__/emailDerivedContacts-1717.test.ts`.
 *
 * Mutation: drop the provider term from `dedupKey` -> one `postMessage`, red.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { EventEmitter } from "events";

const posted: any[] = [];
let live: StubWorker | null = null;

class StubWorker extends EventEmitter {
  postMessage(msg: any): void {
    posted.push(msg);
    live = this;
    // The init handshake answers itself; queries wait for `answerAll`. An
    // answered query is no longer in flight, and a query that is not in flight
    // cannot demonstrate a dedup collision.
    if (msg?.type === "init") {
      setImmediate(() => this.emit("message", { type: "ready" }));
    }
  }
  terminate(): Promise<number> {
    return Promise.resolve(0);
  }
  unref(): void {}
}

jest.mock("worker_threads", () => ({
  __esModule: true,
  Worker: jest.fn(() => {
    live = new StubWorker();
    return live;
  }),
}));

/**
 * Answer every query the pool has sent, so nothing is left in flight when the
 * pool shuts down.
 *
 * Without this, `shutdownPool` rejects the pending queries and the rejection
 * escapes through the pool's own `promise.finally(...)` — a derived promise
 * with no handler, which is BACKLOG-2576 and NOT this item's to fix. Leaving
 * it to fire would make this suite red for a reason that has nothing to do
 * with what it is asserting.
 */
function answerAll(): void {
  for (const msg of posted) {
    if (msg?.id) live?.emit("message", { id: msg.id, success: true, data: [] });
  }
}

jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { initializePool, queryContacts, shutdownPool, isPoolReady } from "../contactWorkerPool";

const USER = "550e8400-e29b-41d4-a716-446655440000"; // pii-allow-uuid: invented, not from any live row

const queryMessages = () => posted.filter((m) => m?.type === "emailDerived");

beforeEach(async () => {
  posted.length = 0;
  await initializePool("/fake/path/mad.db", "deadbeef");
  // PRECONDITION: without a ready pool every query below rejects immediately
  // and the dedup bookkeeping is never reached.
  expect(isPoolReady()).toBe(true);
  posted.length = 0;
});

afterEach(() => {
  shutdownPool();
});

describe("BACKLOG-1717 — the pool keeps mailbox sets apart", () => {
  it("runs two reads when the mailboxes differ", async () => {
    const a = queryContacts("emailDerived", USER, 5_000, { providers: ["outlook"] });
    const b = queryContacts("emailDerived", USER, 5_000, {
      providers: ["outlook", "gmail"],
    });

    // Distinct promises, and two messages actually sent to the worker.
    expect(a).not.toBe(b);
    expect(queryMessages()).toHaveLength(2);
    expect(queryMessages()[0].providers).toEqual(["outlook"]);
    expect(queryMessages()[1].providers).toEqual(["outlook", "gmail"]);

    answerAll();
    await Promise.all([a, b]);
  });

  /**
   * THE OTHER HALF, and it is what stops the fix being "never dedup".
   *
   * Two surfaces asking for the SAME mailboxes must still share one read —
   * that is what the dedup is for, and losing it would double the cost of
   * every picker open.
   */
  it("still shares one read when the mailboxes match", async () => {
    const a = queryContacts("emailDerived", USER, 5_000, { providers: ["outlook"] });
    const b = queryContacts("emailDerived", USER, 5_000, { providers: ["outlook"] });

    expect(a).toBe(b);
    expect(queryMessages()).toHaveLength(1);

    answerAll();
    await Promise.all([a, b]);
  });

  /** The same set in a different order is the same read, not a second one. */
  it("treats the same mailboxes in a different order as one read", async () => {
    const a = queryContacts("emailDerived", USER, 5_000, {
      providers: ["outlook", "gmail"],
    });
    const b = queryContacts("emailDerived", USER, 5_000, {
      providers: ["gmail", "outlook"],
    });

    expect(a).toBe(b);
    expect(queryMessages()).toHaveLength(1);

    answerAll();
    await Promise.all([a, b]);
  });

  /** Query types that carry no payload keep exactly the key they had. */
  it("leaves the existing query types deduping as before", async () => {
    const a = queryContacts("external", USER, 5_000);
    const b = queryContacts("external", USER, 5_000);

    expect(a).toBe(b);
    expect(posted.filter((m) => m?.type === "external")).toHaveLength(1);
    // and no stray providers field reaches the worker
    expect(posted.filter((m) => m?.type === "external")[0]).not.toHaveProperty("providers");

    answerAll();
    await Promise.all([a, b]);
  });
});
