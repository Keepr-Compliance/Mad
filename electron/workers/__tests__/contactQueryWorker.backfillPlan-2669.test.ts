/**
 * @jest-environment node
 *
 * THE WORKER TWIN, DRIVEN FOR REAL (BACKLOG-2669, control 4)
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS — `electron/workers/` HAD NO TESTS AT ALL
 * ===========================================================================
 * There are TWO backfill implementations and the worker's wins whenever the
 * pool is warm: `contactHandlers.backfillImportedContactsFromExternal` plans and
 * copies on the main thread, `contactQueryWorker.runBackfillQuery` plans off it.
 * BACKLOG-2664 found the pair disagreeing, which is why its fix and this one
 * live in a SHARED SQL constant rather than in either consumer.
 *
 * Until this file, nothing executed the worker. "The two writers agree" rested
 * entirely on their importing the same string — an assumption, checkable only by
 * reading. This suite turns it into a test: it starts the real worker module
 * against a real encrypted database file and asserts the PLAN it posts back.
 *
 * ===========================================================================
 * WHAT IS MOCKED, AND WHAT DELIBERATELY IS NOT
 * ===========================================================================
 *   `worker_threads`   — a fake `parentPort` that captures the message handler
 *                        the module registers and records what it posts. This is
 *                        the only way to speak the worker's protocol in-process.
 *   `better-sqlite3-multiple-ciphers` — forced back to the REAL driver. The
 *                        repo's `moduleNameMapper` rewrites it to an auto-mock
 *                        that evaluates no SQL; a plan built on that mock would
 *                        be empty for reasons having nothing to do with this fix.
 *
 * NOT mocked: the worker itself, its `openDatabase`, its `runBackfillQuery`, the
 * shared `CONTACT_SOURCE_RECORDS_SQL`, or the schema. The database is a keyed
 * file on disk, opened read-only by the worker exactly as in production.
 *
 * ===========================================================================
 * THE POSITIVE CONTROL IS LOAD-BEARING
 * ===========================================================================
 * "The worker planned nothing" is also what a worker that failed to open the
 * database says. So the second case links a record and asserts the plan carries
 * that record's values, by exact identity. An empty plan only means something
 * once the same fixture, plus a link, produces a non-empty one.
 *
 * ===========================================================================
 * DRIVING THE WORKER FOR REAL MEANS CLOSING IT FOR REAL
 * ===========================================================================
 * The worker opens its own connection and owns it; the fixture's `seed.close()`
 * closes a different handle entirely. Leaving the worker's open cost this suite
 * a Windows-only failure — macOS unlinks open files without complaint, Windows
 * locks them, and the temp-directory cleanup died with `EBUSY` on the two tests
 * that start a worker (CI run 31639170765).
 *
 * Teardown now sends the worker the same `shutdown` message production sends
 * and then ASSERTS the connection is closed, so the next leak fails on the
 * machine that wrote it rather than two platforms away. See `afterEach`.
 */

import path from "path";
import fs from "fs";
import os from "os";
import type { Database as DatabaseType } from "better-sqlite3";

const REAL_DRIVER_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "node_modules",
  "better-sqlite3-multiple-ciphers",
);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(REAL_DRIVER_PATH) as typeof import("better-sqlite3-multiple-ciphers");

/**
 * Every connection the WORKER opens, in construction order.
 *
 * The worker's `db` is a module-local that it never exports, so this array is
 * the only handle a test can get on it — and holding it is what lets teardown
 * PROVE the connection was closed instead of assuming it. See `afterEach` for
 * why that proof is the control this suite turns on.
 *
 * The seed's connection is absent by construction, not by filtering: the seed
 * requires the driver by ABSOLUTE PATH (`REAL_DRIVER_PATH`), and the repo's
 * `moduleNameMapper` entry is anchored (`^better-sqlite3-multiple-ciphers$`),
 * so a path require never reaches this factory. Only the worker's
 * `import Database from "better-sqlite3-multiple-ciphers"` does.
 */
const mockWorkerConnections: DatabaseType[] = [];

// The worker imports the driver by name; the repo maps that name to an
// auto-mock. Point it back at the real module for this suite only, through a
// thin wrapper that records what the worker opens.
jest.mock("better-sqlite3-multiple-ciphers", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Real = require(
    require("path").join(
      __dirname,
      "..",
      "..",
      "..",
      "node_modules",
      "better-sqlite3-multiple-ciphers",
    ),
  );

  // A `function`, not an arrow: the worker calls `new Database(...)`, and an
  // arrow cannot be constructed. Returning the real instance from a constructor
  // makes it the value of `new`, so the worker is handed the genuine connection
  // and this wrapper is invisible to it.
  function RecordingDatabase(this: unknown, ...args: unknown[]): unknown {
    const connection = new Real(...args);
    mockWorkerConnections.push(connection);
    return connection;
  }

  return RecordingDatabase;
});

/** Captures the worker's side of the `parentPort` protocol. */
const mockPort: {
  handler: ((msg: unknown) => void) | null;
  posted: Array<Record<string, unknown>>;
} = { handler: null, posted: [] };

jest.mock("worker_threads", () => ({
  parentPort: {
    on: (_event: string, cb: (msg: unknown) => void) => {
      mockPort.handler = cb;
    },
    postMessage: (msg: Record<string, unknown>) => {
      mockPort.posted.push(msg);
    },
  },
}));

jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { CONTACT_IDENTITY_SCHEMA } from "../../services/__tests__/helpers/contactIdentitySchema";
import { setDb, setDbPath, setEncryptionKey } from "../../services/db/core/dbConnection";
import { recordContactOrigin } from "../../services/db/contactOriginLink";
import { createLink } from "../../services/db/contactSourceLinkDbService";
import { linkExternalContactsForUser } from "../../services/contactSourceLinker";

const USER = "user-2669";
/** 32 bytes of hex — the shape `openDatabase` interpolates into `PRAGMA key`. */
const KEY_HEX = "a1".repeat(32);
const CURRENT_SYNC = "2026-08-12T00:00:00.000Z";

// The founder's card, transcribed — see the main-thread suite's header for the
// full trail and for which parts are transcription and which are fixture.
const WENDELL = "contact-wendell-marchetti";
const WENDELL_OWN_PHONE = "+15035550181";
const BIANCA_REC = "805AC73C";
const BIANCA_EMAIL = "bianca@example.com";
const NEVER_TYPED_PHONE = "+15035550180";

interface BackfillPlanRow {
  contactId: string;
  emails: string[];
  phones: string[];
}

describe("BACKLOG-2669 — the worker twin plans from links only", () => {
  let tmpDir: string;
  let dbPath: string;

  const lookupKey = (phone: string): string => phone.replace(/\D/g, "").slice(-10);

  beforeEach(() => {
    mockPort.handler = null;
    mockPort.posted = [];
    mockWorkerConnections.length = 0;
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2669-worker-"));
    dbPath = path.join(tmpDir, "keepr.db");
  });

  /**
   * Closes the worker's connection through the worker's OWN teardown path.
   *
   * WHY A MESSAGE AND NOT A THREAD KILL: there is no thread to kill. This suite
   * mocks `worker_threads`, so the worker module runs in-process and its `db`
   * is a module-local nothing else can reach; only the worker's own `shutdown`
   * branch closes it. `{type:"shutdown"}` is also exactly what production posts
   * (`contactWorkerPool.ts`), so the close this exercises is the one that runs
   * in the app rather than a teardown invented for the test.
   *
   * WHY `process.exit` IS STUBBED: the worker's shutdown branch ends with
   * `process.exit(0)`. That is right for a real worker thread and fatal
   * in-process — unstubbed it would take the entire Jest worker down mid-run.
   * The stub is scoped to this one call and restored immediately after.
   */
  function shutdownWorker(): void {
    if (!mockPort.handler) return; // worker never loaded — nothing was opened
    const exit = jest
      .spyOn(process, "exit")
      .mockImplementation(
        (() => undefined) as unknown as (code?: string | number | null) => never,
      );
    try {
      mockPort.handler({ type: "shutdown" });
    } finally {
      exit.mockRestore();
    }
  }

  afterEach(() => {
    try {
      shutdownWorker();

      /**
       * THE CONTROL — and the reason this file must not merely retry `rmSync`.
       *
       * The worker opens its OWN connection to `keepr.db` (its `openDatabase`),
       * which the fixture's `seed.close()` does not touch and `setDb(null)` only
       * drops a reference to. That leaked handle is INVISIBLE on macOS, which
       * lets a process unlink an open file; Windows refuses, so the leak
       * surfaced only there — as `EBUSY: resource busy or locked, unlink` out of
       * the `rmSync` below (CI run 31639170765). `force: true` suppresses
       * ENOENT, never EBUSY.
       *
       * `.open` flips to false exactly on close, on every platform. Asserting it
       * here makes the leak fail LOUDLY on a developer's machine instead of only
       * on a Windows runner: delete the `shutdownWorker()` call above and this
       * goes red locally on macOS — which is how it was verified.
       *
       * The count assertion stops the loop from passing vacuously. If the
       * recording wrapper above ever stops seeing the worker's constructor, an
       * empty array would satisfy the loop forever and this control would
       * quietly stop controlling anything.
       */
      if (mockPort.handler) {
        expect(mockWorkerConnections.length).toBeGreaterThan(0);
      }
      for (const connection of mockWorkerConnections) {
        expect(connection.open).toBe(false);
      }
    } finally {
      // Cleanup runs even when the assertions above fail, so one leaked handle
      // cannot strand a temp directory for every later run.
      setDb(null as unknown as DatabaseType);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * Builds the fixture in a keyed file the worker can reopen. Written through
   * the production helpers (`recordContactOrigin`, `linkExternalContactsForUser`)
   * wherever one exists, so the crosswalk shape is the app's and not this
   * file's idea of it.
   */
  function seedDatabase(opts: { link: boolean }): void {
    const seed = new RealDatabase(dbPath) as DatabaseType;
    seed.pragma(`key = "x'${KEY_HEX}'"`);
    seed.pragma("cipher_compatibility = 4");
    // The worker opens READ-ONLY and then asks for `journal_mode = WAL`. On a
    // database that is already WAL that pragma is a no-op and succeeds; on a
    // `delete`-mode file it is a WRITE and the worker dies with "attempt to
    // write a readonly database". Production databases are WAL because the main
    // process made them so, and a fixture that was not would be describing a
    // state the app does not ship. (Observed: this suite failed exactly that way
    // before the line below existed.)
    seed.pragma("journal_mode = WAL");
    seed.exec(CONTACT_IDENTITY_SCHEMA);

    setDb(seed);
    setDbPath(dbPath);
    setEncryptionKey(KEY_HEX);

    seed
      .prepare(
        "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, 'manual', 1)",
      )
      .run(WENDELL, USER, "Wendell Marchetti");
    seed
      .prepare(
        `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source)
         VALUES (?, ?, ?, ?, 1, 'manual')`,
      )
      .run(`${WENDELL}-p0`, WENDELL, WENDELL_OWN_PHONE, lookupKey(WENDELL_OWN_PHONE));
    recordContactOrigin(USER, WENDELL, "manual");

    const phones = [WENDELL_OWN_PHONE, NEVER_TYPED_PHONE];
    seed
      .prepare(
        `INSERT INTO external_contacts
           (id, user_id, name, phones_json, phones_normalized_json, emails_json,
            external_record_id, source, synced_at, external_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'macos', ?, NULL)`,
      )
      .run(
        `ext-macos-${BIANCA_REC}`,
        USER,
        "Bianca Okafor",
        JSON.stringify(phones),
        JSON.stringify(phones.map(lookupKey)),
        JSON.stringify([BIANCA_EMAIL]),
        BIANCA_REC,
        CURRENT_SYNC,
      );

    // The pass that files the question. It refuses to link (the names disagree),
    // which is the state the founder was in.
    linkExternalContactsForUser(USER);

    if (opts.link) {
      // The positive control: a human answered, so the record IS his.
      createLink({
        userId: USER,
        contactId: WENDELL,
        sourceType: "macos",
        sourceRecordId: BIANCA_REC,
        matchMethod: "manual",
      });
    }

    setDb(null as unknown as DatabaseType);
    seed.close();
  }

  /** Starts the real worker and runs one `backfill` query through it. */
  function runWorkerBackfill(): BackfillPlanRow[] {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("../contactQueryWorker");
    });

    expect(mockPort.handler).toBeInstanceOf(Function);
    const send = mockPort.handler as (msg: unknown) => void;

    send({ type: "init", dbPath, encryptionKey: KEY_HEX });
    // A worker that could not open the database posts `{type:"error"}` here, so
    // this assertion is what stops an empty plan from being read as a pass.
    expect(mockPort.posted).toEqual([{ type: "ready" }]);

    send({ id: "q1", type: "backfill", userId: USER });

    const reply = mockPort.posted[1] as { id: string; success: boolean; data?: unknown };
    expect(reply.id).toBe("q1");
    expect(reply.success).toBe(true);
    return reply.data as BackfillPlanRow[];
  }

  it("plans NOTHING for a contact whose only crosswalk row is `origin`", () => {
    seedDatabase({ link: false });

    expect(runWorkerBackfill()).toEqual([]);
  });

  it("plans the record's values once it is linked — the positive control", () => {
    seedDatabase({ link: true });

    // Exact identity: the email he never had, and the number that differs from
    // his own in one digit. His own `0301` is absent because he already holds it.
    expect(runWorkerBackfill()).toEqual([
      {
        contactId: WENDELL,
        emails: [BIANCA_EMAIL],
        phones: [NEVER_TYPED_PHONE],
      },
    ]);
  });
});
