/**
 * @jest-environment node
 *
 * BACKLOG-3477 PR D — a checklist a broker adds at review syncs to the agent's
 * desktop when the submission turns `needs_changes`.
 *
 * REAL driver over the REAL schema (run under the Electron runner):
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 *
 * ===========================================================================
 * THE WRONG IMPLEMENTATIONS THIS SUITE EXISTS TO CATCH
 * ===========================================================================
 *   the pull hooked into only ONE status-apply path (SR condition C8)
 *       Realtime usually lands first and writes `needs_changes`; the poller
 *       then sees no transition and never pulls. Each path has its own test
 *       below that drives ONLY that path, so removing the hook from any one
 *       of them turns exactly that test red.
 *   a level-triggered pull
 *       Re-adds a checklist the agent removed on the next pass.
 *   an "already has it" that duplicates or overwrites
 *       The local UNIQUE (transaction_id, template_id) answers `exists`; the
 *       existing section's ticks must survive.
 *   a failed pull that still writes the status
 *       The transition is then gone and the checklist never arrives.
 *
 * The cloud fixture is transcribed from the one live broker-added
 * `submission_checklists` row and its three `submission_checklist_items`
 * (read-only select, 2026-09-27): header sort_order 2 with template_id and
 * added_at_review_by set; items sort_order 10/20/30, is_required boolean,
 * expected_document_type "offer" or null, description null, note null.
 * Ids (not UUIDs here) and the template name are synthetic.
 *
 * The unknown-document-type case is NOT producible today (the cloud template
 * table and the local table CHECK the same list, and both cloud writers copy
 * from CHECKed rows). It is a forward-compatibility guard (C8).
 */
import * as nodePath from "path";
import * as fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

let db: DatabaseType;

jest.mock("../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));

const LOCAL_SELECT =
  "SELECT id, property_address, submission_id, submission_status, last_review_notes FROM transactions";

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    isInitialized: () => true,
    getTransactionBySubmissionId: (submissionId: string) =>
      db.prepare(`${LOCAL_SELECT} WHERE submission_id = ?`).get(submissionId),
    getSubmittedTransactionById: (id: string) =>
      db.prepare(`${LOCAL_SELECT} WHERE id = ? AND submission_id IS NOT NULL`).get(id),
    getActiveSubmittedTransactions: () =>
      db
        .prepare(
          `${LOCAL_SELECT} WHERE submission_id IS NOT NULL AND submission_status NOT IN ('approved', 'rejected', 'not_submitted')`,
        )
        .all(),
    updateTransactionSubmissionStatus: (id: string, status: string, notes: string | null) =>
      db
        .prepare("UPDATE transactions SET submission_status = ?, last_review_notes = ? WHERE id = ?")
        .run(status, notes, id),
  },
}));

jest.mock("../logService");
jest.mock("@sentry/electron/main", () => ({ captureException: jest.fn() }));
jest.mock("../../windowRegistry", () => ({ sendToMainWindow: jest.fn(() => true) }));

// ---------------------------------------------------------------------------
// Fake cloud: three tables served from arrays, plus the realtime channel.
// ---------------------------------------------------------------------------
interface CloudState {
  submissions: Array<{ id: string; status: string; review_notes: string | null }>;
  submission_checklists: Array<Record<string, unknown>>;
  submission_checklist_items: Array<Record<string, unknown>>;
  /** Number of upcoming reads of submission_checklists that fail. */
  checklistFetchFailures: number;
  /** Number of upcoming reads of submission_checklist_items that fail. */
  itemFetchFailures: number;
  /**
   * BACKLOG-3599 (SR condition 5): no session. Measured in production:
   * `SET ROLE anon; SELECT ... FROM submission_checklists` -> 42501 permission
   * denied (the policies are `authenticated` only). Every read is an ERROR,
   * never an empty success.
   */
  signedOut: boolean;
  /**
   * BACKLOG-3599: submissions RLS hides from the signed-in user (another user
   * on the same local database). Reads SUCCEED and return no row for them —
   * nor any of their checklists.
   */
  hiddenSubmissions: Set<string>;
}

const cloud: CloudState = {
  submissions: [],
  submission_checklists: [],
  submission_checklist_items: [],
  checklistFetchFailures: 0,
  itemFetchFailures: 0,
  signedOut: false,
  hiddenSubmissions: new Set(),
};
let realtimeCallback: ((payload: { new: unknown }) => void) | null = null;
const checklistFetches: string[] = [];

function query(table: string) {
  const filters: Array<(row: Record<string, unknown>) => boolean> = [];
  let orderKey: string | null = null;
  const builder = {
    select: () => builder,
    eq: (col: string, value: unknown) => {
      filters.push((row) => row[col] === value);
      return builder;
    },
    in: (col: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[col]));
      return builder;
    },
    not: (col: string, op: string, value: unknown) => {
      if (op !== "is" || value !== null) throw new Error("fake: unsupported not()");
      filters.push((row) => row[col] !== null && row[col] !== undefined);
      return builder;
    },
    order: (col: string) => {
      orderKey = col;
      return builder;
    },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      try {
        if (table === "submission_checklists") checklistFetches.push(table);
        if (cloud.signedOut) {
          return Promise.resolve({
            data: null,
            error: { code: "42501", message: `permission denied for table ${table}` },
          }).then(resolve, reject);
        }
        if (table === "submission_checklists") {
          if (cloud.checklistFetchFailures > 0) {
            cloud.checklistFetchFailures--;
            return Promise.resolve({ data: null, error: { message: "fake network error" } }).then(
              resolve,
              reject,
            );
          }
        }
        if (table === "submission_checklist_items" && cloud.itemFetchFailures > 0) {
          cloud.itemFetchFailures--;
          return Promise.resolve({ data: null, error: { message: "fake items read error" } }).then(
            resolve,
            reject,
          );
        }
        const source =
          table === "transaction_submissions"
            ? (cloud.submissions as Array<Record<string, unknown>>)
            : (cloud[table as "submission_checklists" | "submission_checklist_items"] ?? []);
        let rows = source.filter((row) => filters.every((f) => f(row)));
        const hidden = (row: Record<string, unknown>) =>
          cloud.hiddenSubmissions.has(
            String(table === "transaction_submissions" ? row.id : row.submission_id),
          );
        rows = rows.filter((row) => !hidden(row));
        if (orderKey) {
          const key = orderKey;
          rows = [...rows].sort((a, b) => (a[key] as number) - (b[key] as number));
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    },
  };
  return builder;
}

const fakeClient = {
  from: (table: string) => query(table),
  channel: () => {
    const channel = {
      on: (_event: string, _filter: unknown, cb: (payload: { new: unknown }) => void) => {
        realtimeCallback = cb;
        return channel;
      },
      subscribe: () => channel,
    };
    return channel;
  },
  removeChannel: jest.fn(async () => undefined),
};

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => fakeClient },
}));

import { submissionSyncService } from "../submissionSyncService";
import { removeChecklist, selectChecklistTemplate, setChecklistItemChecked } from "../db/checklistDbService";
import { clearReviewChecklistPullOwed, markReviewChecklistPullOwed } from "../db/submissionDbService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-3477-d";
const TXN = "txn-3477-d";
const SUB = "sub-3477-d";
const HEADER = "hdr-broker-added";
const TEMPLATE = "tpl-review-add";
const TEMPLATE_NAME = "Review add template";

function seedLocal(status = "under_review"): void {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'agent@example.test', 'google', 'oa-agent')`,
  ).run(USER);
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, submission_id, submission_status) VALUES (?, ?, '1 Test Way', ?, ?)`,
  ).run(TXN, USER, SUB, status);
}

function seedCloud(status: string, expectedTypeForB: string | null = null): void {
  cloud.submissions = [{ id: SUB, status, review_notes: status === "needs_changes" ? "Please add docs" : null }];
  cloud.submission_checklists = [
    {
      id: HEADER,
      submission_id: SUB,
      template_id: TEMPLATE,
      template_name: TEMPLATE_NAME,
      sort_order: 2,
      added_at_review_by: "broker-3477-d",
      added_at_review_at: "2026-09-27 23:04:54.012711+00",
    },
    // An agent-snapshot header on the same submission: never pulled.
    {
      id: "hdr-agent-snapshot",
      submission_id: SUB,
      template_id: "tpl-agent-snapshot",
      template_name: "Agent snapshot template",
      sort_order: 0,
      added_at_review_by: null,
      added_at_review_at: null,
    },
  ];
  const item = (title: string, sort: number, required: boolean, type: string | null) => ({
    submission_id: SUB,
    submission_checklist_id: HEADER,
    title,
    is_required: required,
    is_checked: false,
    note: null,
    sort_order: sort,
    reviewer_checked: false,
    reviewer_checked_by: null,
    reviewer_checked_at: null,
    description: null,
    expected_document_type: type,
  });
  cloud.submission_checklist_items = [
    item("Item C closing disclosure", 10, false, null),
    item("Item A signed offer", 20, true, "offer"),
    item("Item B inspection report", 30, false, expectedTypeForB),
    {
      ...item("Snapshot item", 0, true, null),
      submission_checklist_id: "hdr-agent-snapshot",
    },
  ];
}

const localChecklists = () =>
  db
    .prepare("SELECT id, template_id, template_name FROM transaction_checklists WHERE transaction_id = ?")
    .all(TXN) as Array<{ id: string; template_id: string; template_name: string }>;
const localItems = (checklistId: string) =>
  db
    .prepare(
      "SELECT title, description, is_required, expected_document_type, is_checked, note, sort_order FROM transaction_checklist_items WHERE checklist_id = ? ORDER BY sort_order",
    )
    .all(checklistId) as Array<Record<string, unknown>>;
const localStatus = () =>
  (db.prepare("SELECT submission_status FROM transactions WHERE id = ?").get(TXN) as {
    submission_status: string;
  }).submission_status;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

async function deliverRealtime(): Promise<void> {
  await submissionSyncService.startRealtimeSubscription(USER);
  if (!realtimeCallback) throw new Error("realtime callback was not captured");
  realtimeCallback({ new: { ...cloud.submissions[0] } });
  await flush();
}

function expectPulled(): void {
  const lists = localChecklists();
  expect(lists).toHaveLength(1);
  expect(lists[0]).toMatchObject({ template_id: TEMPLATE, template_name: TEMPLATE_NAME });
  expect(localItems(lists[0].id)).toEqual([
    { title: "Item C closing disclosure", description: null, is_required: 0, expected_document_type: null, is_checked: 0, note: null, sort_order: 10 },
    { title: "Item A signed offer", description: null, is_required: 1, expected_document_type: "offer", is_checked: 0, note: null, sort_order: 20 },
    { title: "Item B inspection report", description: null, is_required: 0, expected_document_type: null, is_checked: 0, note: null, sort_order: 30 },
  ]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM transaction_checklist_links").get()).toEqual({ n: 0 });
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  cloud.checklistFetchFailures = 0;
  cloud.itemFetchFailures = 0;
  cloud.signedOut = false;
  cloud.hiddenSubmissions = new Set();
  checklistFetches.length = 0;
  realtimeCallback = null;
  (submissionSyncService as unknown as { reviewChecklistPullFailures: Map<string, number> })
    .reviewChecklistPullFailures.clear();
});

afterEach(async () => {
  await submissionSyncService.stopAllSync();
  db.close();
});

describe("BACKLOG-3477 sync-back: each status-apply path pulls", () => {
  it("realtime path: needs_changes pulls the broker-added checklist, then writes the status", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await deliverRealtime();
    expectPulled();
    expect(localStatus()).toBe("needs_changes");
  });

  it("poller path: needs_changes pulls the broker-added checklist, then writes the status", async () => {
    seedLocal();
    seedCloud("needs_changes");
    const result = await submissionSyncService.manualSync();
    expect(result.updated).toBe(1);
    expectPulled();
    expect(localStatus()).toBe("needs_changes");
  });

  it("single-submission path: needs_changes pulls the broker-added checklist, then writes the status", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await expect(submissionSyncService.syncSubmission(TXN)).resolves.toBe(true);
    expectPulled();
    expect(localStatus()).toBe("needs_changes");
  });
});

describe("BACKLOG-3477 sync-back: idempotence and edges", () => {
  it("agent already has the template: skipped, no duplicate, existing ticks intact, status written", async () => {
    seedLocal();
    seedCloud("needs_changes");
    const own = await selectChecklistTemplate({
      transactionId: TXN,
      templateId: TEMPLATE,
      templateName: "Agent's own copy",
      items: [
        { title: "Own item one", isRequired: true, sortOrder: 0 },
        { title: "Own item two", isRequired: false, sortOrder: 1 },
      ],
    });
    if (own.status !== "added") throw new Error("seed failed");
    const firstItem = db
      .prepare("SELECT id FROM transaction_checklist_items WHERE checklist_id = ? ORDER BY sort_order LIMIT 1")
      .get(own.checklistId) as { id: string };
    await setChecklistItemChecked(firstItem.id, true);

    await submissionSyncService.manualSync();

    const lists = localChecklists();
    expect(lists).toEqual([{ id: own.checklistId, template_id: TEMPLATE, template_name: "Agent's own copy" }]);
    expect(localItems(own.checklistId).map((r) => [r.title, r.is_checked])).toEqual([
      ["Own item one", 1],
      ["Own item two", 0],
    ]);
    expect(localStatus()).toBe("needs_changes");
  });

  it("the same needs_changes event twice (realtime, realtime, then poller) adds nothing twice", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await deliverRealtime();
    realtimeCallback!({ new: { ...cloud.submissions[0] } });
    await flush();
    await submissionSyncService.manualSync();
    await submissionSyncService.syncSubmission(TXN);
    expectPulled();
    // Only the first transition read the cloud checklists.
    expect(checklistFetches).toHaveLength(1);
  });

  it("realtime and poller racing on the same transition still add one checklist", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await submissionSyncService.startRealtimeSubscription(USER);
    realtimeCallback!({ new: { ...cloud.submissions[0] } });
    await Promise.all([submissionSyncService.manualSync(), flush()]);
    expectPulled();
  });

  it("a checklist the agent removes after the pull is not re-added by later passes", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await submissionSyncService.manualSync();
    const [pulled] = localChecklists();
    await removeChecklist(TXN, pulled.id);
    await submissionSyncService.manualSync();
    await submissionSyncService.syncSubmission(TXN);
    await deliverRealtime();
    expect(localChecklists()).toEqual([]);

    // The broker edits the review note while the submission stays
    // needs_changes: a notes-only change is applied, and must not re-pull.
    cloud.submissions[0].review_notes = "Also the addendum";
    await deliverRealtime();
    await submissionSyncService.manualSync();
    expect(localChecklists()).toEqual([]);
    expect(checklistFetches).toHaveLength(1);
  });

  it.each(["approved", "under_review", "rejected"])(
    "status %s pulls nothing and still writes the status",
    async (status) => {
      seedLocal("submitted");
      seedCloud(status);
      await submissionSyncService.manualSync();
      expect(localChecklists()).toEqual([]);
      expect(checklistFetches).toHaveLength(0);
      expect(localStatus()).toBe(status);
    },
  );

  it("an unknown cloud document type is stored as empty, not a failed insert", async () => {
    seedLocal();
    seedCloud("needs_changes", "survey_plat");
    await submissionSyncService.manualSync();
    expectPulled();
    expect(localStatus()).toBe("needs_changes");
  });

  it("a failed pull holds the status for retry; the counter is shared across paths; the 3rd failure writes it", async () => {
    seedLocal();
    seedCloud("needs_changes");
    cloud.checklistFetchFailures = 3;

    await deliverRealtime();
    expect(localStatus()).toBe("under_review");
    const poll = await submissionSyncService.manualSync();
    expect(poll.failed).toBe(1);
    expect(localStatus()).toBe("under_review");
    await submissionSyncService.syncSubmission(TXN);
    expect(localStatus()).toBe("needs_changes");
    expect(localChecklists()).toEqual([]);
  });

  it("a failed pull that later succeeds converges to the realtime result", async () => {
    seedLocal();
    seedCloud("needs_changes");
    cloud.checklistFetchFailures = 1;
    await deliverRealtime();
    expect(localStatus()).toBe("under_review");
    await submissionSyncService.manualSync();
    expectPulled();
    expect(localStatus()).toBe("needs_changes");
  });

  // SR condition D1: the wrong implementation ignores the items-read error,
  // writes an EMPTY checklist, and the `exists` guard then makes it permanent.
  it("an items-read error fails the pull: no checklist written, status held, then converges", async () => {
    seedLocal();
    seedCloud("needs_changes");
    cloud.itemFetchFailures = 1;

    const poll = await submissionSyncService.manualSync();
    expect(poll.failed).toBe(1);
    expect(localChecklists()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transaction_checklist_items").get()).toEqual({ n: 0 });
    expect(localStatus()).toBe("under_review");

    await submissionSyncService.manualSync();
    expectPulled();
    expect(localStatus()).toBe("needs_changes");
  });

  it("an items-read error counts toward the failure limit; the 3rd writes the status without an empty checklist", async () => {
    seedLocal();
    seedCloud("needs_changes");
    cloud.itemFetchFailures = 3;

    await submissionSyncService.manualSync();
    expect(localStatus()).toBe("under_review");
    await submissionSyncService.manualSync();
    expect(localStatus()).toBe("under_review");
    await submissionSyncService.manualSync();
    expect(localStatus()).toBe("needs_changes");
    expect(localChecklists()).toEqual([]);
  });

  // A success resets the failure counter, so a later failure streak on the
  // same submission starts again from 1 and gets its full retries.
  it("a success after a failure resets the counter for a later needs_changes on the same submission", async () => {
    seedLocal();
    seedCloud("needs_changes");
    cloud.checklistFetchFailures = 1;
    await submissionSyncService.manualSync(); // failure 1, held
    expect(localStatus()).toBe("under_review");
    await submissionSyncService.manualSync(); // success, written
    expectPulled();
    expect(localStatus()).toBe("needs_changes");

    // The broker moves it back to review, then requests changes again.
    cloud.submissions[0].status = "under_review";
    await submissionSyncService.manualSync();
    expect(localStatus()).toBe("under_review");
    cloud.submissions[0].status = "needs_changes";
    cloud.checklistFetchFailures = 2;

    await submissionSyncService.manualSync(); // failure 1 again (2 if never reset)
    expect(localStatus()).toBe("under_review");
    await submissionSyncService.manualSync(); // failure 2 (3 if never reset: would write)
    expect(localStatus()).toBe("under_review");
    await submissionSyncService.manualSync(); // failure 3: written
    expect(localStatus()).toBe("needs_changes");
    expectPulled();
  });
});

// ===========================================================================
// BACKLOG-3599 — a pull that fails three times is OWED, and retried until it
// lands. The owed set lives in `transactions.metadata` ($.reviewChecklistPullOwed).
// ===========================================================================
/**
 * Wrong implementations these catch (plan 1540520d, SR conditions 944ab6bf):
 *   an in-memory owed set                 -> C2 (restart clears it)
 *   a marker cleared before the pull      -> C3
 *   a marker never cleared (level retry)  -> C4
 *   a single-slot marker                  -> C7
 *   clearing on an RLS-empty read         -> C2 (hidden) / signed-out case
 */
describe("BACKLOG-3599 — owed broker checklist pulls", () => {
  const S2 = "sub-3599-second";
  /** The owed set, read RAW from SQLite — never through the code under test. */
  const owed = (): unknown => {
    const row = db
      .prepare("SELECT json_extract(metadata, '$.reviewChecklistPullOwed') AS o FROM transactions WHERE id = ?")
      .get(TXN) as { o: string | null };
    return row.o === null ? null : JSON.parse(row.o);
  };
  /**
   * The service under test. `restart()` replaces it with a fresh load of every
   * module (same SQLite database), so NO in-memory state survives — not the
   * service's fields and not any module-level variable.
   */
  let svc = submissionSyncService;
  beforeEach(() => {
    svc = submissionSyncService;
  });
  const restart = (): void => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    svc = (require("../submissionSyncService") as typeof import("../submissionSyncService"))
      .submissionSyncService;
  };
  /** Three failed passes: status written, pull owed. */
  async function failOut(): Promise<void> {
    seedLocal();
    seedCloud("needs_changes");
    cloud.checklistFetchFailures = 3;
    await svc.manualSync();
    await svc.manualSync();
    await svc.manualSync();
    expect(localStatus()).toBe("needs_changes");
    expect(localChecklists()).toEqual([]);
    expect(owed()).toEqual([SUB]);
  }

  it("C1: fail x3 -> status written and the pull owed; the next pass lands it and clears the marker", async () => {
    await failOut();
    await svc.manualSync();
    expectPulled();
    expect(owed()).toBeNull();
    expect(localStatus()).toBe("needs_changes");
  });

  it("C2: a restart between the failure-out and the next pass still lands it", async () => {
    await failOut();
    restart();
    await svc.manualSync();
    expectPulled();
    expect(owed()).toBeNull();
  });

  it("C2 (signed out): every read is 42501 -> marker kept, nothing written; signed in again -> lands", async () => {
    await failOut();
    cloud.signedOut = true;
    await svc.manualSync();
    expect(owed()).toEqual([SUB]);
    expect(localChecklists()).toEqual([]);
    cloud.signedOut = false;
    await svc.manualSync();
    expectPulled();
    expect(owed()).toBeNull();
  });

  it("C2 (RLS-empty): the owed submission is not visible -> marker kept though every read succeeds", async () => {
    await failOut();
    cloud.hiddenSubmissions.add(SUB);
    const before = checklistFetches.length;
    await svc.manualSync();
    expect(owed()).toEqual([SUB]);
    expect(localChecklists()).toEqual([]);
    // Nothing was pulled on no proof.
    expect(checklistFetches.length).toBe(before);
    cloud.hiddenSubmissions.clear();
    await svc.manualSync();
    expectPulled();
    expect(owed()).toBeNull();
  });

  it("C3: the owed retry fails again -> marker still set; a later success lands", async () => {
    await failOut();
    cloud.checklistFetchFailures = 2;
    await svc.manualSync();
    expect(owed()).toEqual([SUB]);
    restart();
    await svc.manualSync();
    expect(owed()).toEqual([SUB]);
    expect(localChecklists()).toEqual([]);
    await svc.manualSync();
    expectPulled();
    expect(owed()).toBeNull();
  });

  it("C4: once the owed pull lands, a checklist the agent removes is never re-added (any path, restart included)", async () => {
    await failOut();
    await svc.manualSync();
    expectPulled();
    const [pulled] = localChecklists();
    await removeChecklist(TXN, pulled.id);
    const fetches = checklistFetches.length;

    await svc.manualSync();
    await svc.syncSubmission(TXN);
    await deliverRealtime();
    restart();
    await svc.manualSync();

    expect(localChecklists()).toEqual([]);
    expect(checklistFetches.length).toBe(fetches);
    expect(owed()).toBeNull();
  });

  it("C5: the submission is approved while the pull is owed -> marker cleared, nothing pulled", async () => {
    await failOut();
    cloud.submissions[0].status = "approved";
    const fetches = checklistFetches.length;
    await svc.manualSync();
    expect(owed()).toBeNull();
    expect(checklistFetches.length).toBe(fetches);
    expect(localChecklists()).toEqual([]);
  });

  it("C5 (not active locally): a marker on a transaction the poller no longer lists is still visited", async () => {
    await failOut();
    // Local status final: the poller's active list excludes it and returns early.
    db.prepare("UPDATE transactions SET submission_status = 'approved' WHERE id = ?").run(TXN);
    cloud.submissions[0].status = "approved";
    await svc.manualSync();
    expect(owed()).toBeNull();
  });

  it("C6: clearing one id leaves a newer id alone (compare-and-clear)", async () => {
    await failOut();
    markReviewChecklistPullOwed(TXN, S2);
    expect(owed()).toEqual([SUB, S2]);
    clearReviewChecklistPullOwed(TXN, SUB);
    expect(owed()).toEqual([S2]);
    clearReviewChecklistPullOwed(TXN, SUB);
    expect(owed()).toEqual([S2]);
  });

  it("C7: two owed ids on one transaction; one lands, the other stays owed", async () => {
    await failOut();
    // A later version is owed too (its row not visible this pass).
    cloud.submissions.push({ id: S2, status: "needs_changes", review_notes: null });
    cloud.hiddenSubmissions.add(S2);
    markReviewChecklistPullOwed(TXN, S2);

    await svc.manualSync();

    expectPulled();
    expect(owed()).toEqual([S2]);
  });

  it("the marker is written before the status (a failed marker write holds the status)", async () => {
    seedLocal();
    seedCloud("needs_changes");
    cloud.checklistFetchFailures = 3;
    await svc.manualSync();
    await svc.manualSync();
    // The 3rd failure cannot record the marker: a trigger refuses the metadata write.
    db.exec(`CREATE TRIGGER block_meta BEFORE UPDATE OF metadata ON transactions BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
    await svc.manualSync();
    expect(localStatus()).toBe("under_review");
    db.exec("DROP TRIGGER block_meta");
  });
});

// ===========================================================================
// BACKLOG-3595 — what an open transaction window is told, and when
// ===========================================================================
// The renderer re-reads an open transaction's checklists on two events. That
// re-read is right only if the rows are committed when the event is sent, so
// every emit below records the local checklist count AT THE MOMENT OF SENDING.
import { sendToMainWindow } from "../../windowRegistry";
// Imported at load, so it is the instance the service holds even after the
// 3599 block resets the module registry.
import supabaseForRetry from "../supabaseService";

describe("BACKLOG-3595 — events reach the window after the checklist rows commit", () => {
  let sent: Array<{ channel: string; rowsAtSend: number; payload: unknown }>;
  beforeEach(() => {
    sent = [];
    jest.mocked(sendToMainWindow).mockImplementation((channel: string, payload?: unknown) => {
      sent.push({ channel, rowsAtSend: localChecklists().length, payload });
      return true;
    });
  });
  const on = (channel: string) => sent.filter((s) => s.channel === channel);

  /** Three failed passes: status written with no checklist, the pull owed. */
  async function failOut(): Promise<void> {
    seedLocal();
    seedCloud("needs_changes");
    cloud.checklistFetchFailures = 3;
    await submissionSyncService.manualSync();
    await submissionSyncService.manualSync();
    await submissionSyncService.manualSync();
    expect(localStatus()).toBe("needs_changes");
    expect(localChecklists()).toEqual([]);
  }

  it("realtime path: submission-status-changed is sent with the broker checklist already written", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await deliverRealtime();
    expect(on("submission-status-changed").map((s) => s.rowsAtSend)).toEqual([1]);
  });

  it("poller path: submission-status-changed is sent with the broker checklist already written", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await submissionSyncService.manualSync();
    expect(on("submission-status-changed").map((s) => s.rowsAtSend)).toEqual([1]);
  });

  it("single-submission path: submission-status-changed is sent with the broker checklist already written", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await submissionSyncService.syncSubmission(TXN);
    expect(on("submission-status-changed").map((s) => s.rowsAtSend)).toEqual([1]);
  });

  it("an owed pull that lands sends transaction-checklists-changed once, after the write, and no status event", async () => {
    await failOut();
    sent = [];

    await submissionSyncService.manualSync();

    expectPulled();
    expect(on("transaction-checklists-changed")).toEqual([
      { channel: "transaction-checklists-changed", rowsAtSend: 1, payload: { transactionId: TXN } },
    ]);
    // No status transition on this pass: a status event here would raise a
    // second "changes requested" notification (useSubmissionSync).
    expect(on("submission-status-changed")).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("an owed pull that adds nothing (the template is already there) sends nothing", async () => {
    await failOut();
    const own = await selectChecklistTemplate({
      transactionId: TXN,
      templateId: TEMPLATE,
      templateName: TEMPLATE_NAME,
      items: [{ title: "Own item", isRequired: true, sortOrder: 0 }],
    });
    if (own.status !== "added") throw new Error("seed failed");
    sent = [];

    await submissionSyncService.manualSync();

    expect(sent).toEqual([]);
  });

  it("an owed pull dropped because the submission is final sends nothing", async () => {
    await failOut();
    cloud.submissions[0].status = "approved";
    sent = [];

    await submissionSyncService.manualSync();

    expect(on("transaction-checklists-changed")).toEqual([]);
  });

  it("an owed pull that fails again sends nothing", async () => {
    await failOut();
    cloud.checklistFetchFailures = 1;
    sent = [];

    await submissionSyncService.manualSync();

    expect(localChecklists()).toEqual([]);
    expect(on("transaction-checklists-changed")).toEqual([]);
  });

  it("a Supabase client that cannot be created does not abort the pass (the retry never throws)", async () => {
    await failOut();
    const supabase = supabaseForRetry as unknown as { getClient: () => unknown };
    const real = supabase.getClient;
    let calls = 0;
    supabase.getClient = () => {
      calls++;
      // The owed retry asks first in the pass; every later caller gets the client.
      if (calls === 1) throw new Error("Supabase is not configured");
      return real();
    };
    try {
      await submissionSyncService.manualSync();
    } finally {
      supabase.getClient = real;
    }
    // The pass went on past the retry and read the cloud statuses.
    expect(calls).toBeGreaterThan(1);
    expect(localChecklists()).toEqual([]);
  });
});
