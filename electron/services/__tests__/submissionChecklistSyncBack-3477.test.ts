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
import { randomUUID } from "crypto";
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
  /**
   * `parent_submission_id` is always present on a cloud row (NULL on a first
   * version; the previous version's id on a resubmit - submissionService
   * `parent_submission_id: options?.parentSubmissionId`).
   */
  submissions: Array<{
    id: string;
    status: string;
    review_notes: string | null;
    parent_submission_id: string | null;
  }>;
  submission_checklists: Array<Record<string, unknown>>;
  submission_checklist_items: Array<Record<string, unknown>>;
  /** Number of upcoming reads of submission_checklists that fail. */
  checklistFetchFailures: number;
  /** Number of upcoming reads of submission_checklist_items that fail. */
  itemFetchFailures: number;
  /**
   * BACKLOG-3607: number of upcoming reads of the checklists the broker
   * REMOVED at review (`removed_at_review_by` not null) that fail.
   */
  removedFetchFailures: number;
  /**
   * BACKLOG-3607: number of upcoming reads of `transaction_submissions` by
   * `parent_submission_id` (the "does a newer version exist" read) that fail.
   */
  newerVersionReadFailures: number;
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
  removedFetchFailures: 0,
  newerVersionReadFailures: 0,
  signedOut: false,
  hiddenSubmissions: new Set(),
};
let realtimeCallback: ((payload: { new: unknown }) => void) | null = null;
const checklistFetches: string[] = [];
/**
 * BACKLOG-3607: one pull reads `submission_checklists` twice - the checklists
 * the broker added (not removed) and the ones the broker removed at review.
 */
const HEADER_READS_PER_PULL = 2;

function query(table: string) {
  const filters: Array<(row: Record<string, unknown>) => boolean> = [];
  let orderKey: string | null = null;
  // BACKLOG-3596 (SR C-6): project ONLY the selected columns, as PostgREST
  // does. A fake that returned whole rows would hand the pull a column it
  // never asked for (the item id), and a control on it could not go red.
  let columns: string[] | null = null;
  const notNullCols: string[] = [];
  const eqCols: string[] = [];
  const builder = {
    select: (list?: string) => {
      const cols = (list ?? "*").split(",").map((c) => c.trim()).filter(Boolean);
      columns = cols.includes("*") ? null : cols;
      return builder;
    },
    eq: (col: string, value: unknown) => {
      eqCols.push(col);
      filters.push((row) => row[col] === value);
      return builder;
    },
    in: (col: string, values: unknown[]) => {
      filters.push((row) => values.includes(row[col]));
      return builder;
    },
    not: (col: string, op: string, value: unknown) => {
      if (op !== "is" || value !== null) throw new Error("fake: unsupported not()");
      notNullCols.push(col);
      filters.push((row) => row[col] !== null && row[col] !== undefined);
      return builder;
    },
    // BACKLOG-3607: `.is(col, null)`, as PostgREST: the column is NULL.
    is: (col: string, value: unknown) => {
      if (value !== null) throw new Error("fake: unsupported is()");
      filters.push((row) => row[col] === null || row[col] === undefined);
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
          if (notNullCols.includes("removed_at_review_by") && cloud.removedFetchFailures > 0) {
            cloud.removedFetchFailures--;
            return Promise.resolve({ data: null, error: { message: "fake removed read error" } }).then(
              resolve,
              reject,
            );
          }
        }
        if (
          table === "transaction_submissions" &&
          eqCols.includes("parent_submission_id") &&
          cloud.newerVersionReadFailures > 0
        ) {
          cloud.newerVersionReadFailures--;
          return Promise.resolve({ data: null, error: { message: "fake newer version read error" } }).then(
            resolve,
            reject,
          );
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
        if (columns) {
          const cols = columns;
          rows = rows.map((row) =>
            Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])),
          );
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
import {
  addChecklistLink,
  getChecklistsForTransaction,
  removeChecklist,
  selectChecklistTemplate,
  setChecklistItemChecked,
} from "../db/checklistDbService";
import { buildChecklistSnapshotPayload } from "../submissionChecklistSnapshot";
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
  cloud.submissions = [
    {
      id: SUB,
      status,
      review_notes: status === "needs_changes" ? "Please add docs" : null,
      parent_submission_id: null,
    },
  ];
  cloud.submission_checklists = [
    {
      id: HEADER,
      submission_id: SUB,
      template_id: TEMPLATE,
      template_name: TEMPLATE_NAME,
      sort_order: 2,
      added_at_review_by: "broker-3477-d",
      added_at_review_at: "2026-09-27 23:04:54.012711+00",
      // BACKLOG-3607 migration 20260929120000 section 1: always present, NULL
      // unless the broker removed the checklist at review.
      removed_at_review_by: null,
      removed_at_review_at: null,
      restored_from_checklist_id: null,
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
      removed_at_review_by: null,
      removed_at_review_at: null,
      restored_from_checklist_id: null,
    },
  ];
  const item = (title: string, sort: number, required: boolean, type: string | null) => ({
    // BACKLOG-3596: every cloud row has a uuid id; generated per run.
    id: randomUUID(),
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
    restored_from_item_id: null,
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
  cloud.removedFetchFailures = 0;
  cloud.newerVersionReadFailures = 0;
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
    // Only the first transition read the cloud checklists (one pull).
    expect(checklistFetches).toHaveLength(HEADER_READS_PER_PULL);
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
    expect(checklistFetches).toHaveLength(HEADER_READS_PER_PULL);
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
    cloud.submissions.push({ id: S2, status: "needs_changes", review_notes: null, parent_submission_id: null });
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

// ---------------------------------------------------------------------------
// BACKLOG-3596: a pulled broker checklist keeps the cloud item ids, so the next
// version sends them as local_item_id and the broker's ticks carry.
// ---------------------------------------------------------------------------
describe("BACKLOG-3596 pulled items keep the cloud item id", () => {
  const cloudIdsByTitle = () =>
    new Map(
      cloud.submission_checklist_items
        .filter((row) => row.submission_checklist_id === HEADER)
        .map((row) => [row.title as string, row.id as string]),
    );

  it("D1: after a pull every local item id equals its cloud item id", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await submissionSyncService.manualSync();

    const lists = localChecklists();
    expect(lists).toHaveLength(1);
    const local = db
      .prepare("SELECT id, title FROM transaction_checklist_items WHERE checklist_id = ?")
      .all(lists[0].id) as Array<{ id: string; title: string }>;
    expect(local).toHaveLength(3);
    expect(new Map(local.map((r) => [r.title, r.id]))).toEqual(cloudIdsByTitle());
  });

  it("D2: the next version's snapshot payload sends the cloud item id as local_item_id", async () => {
    seedLocal();
    seedCloud("needs_changes");
    await submissionSyncService.manualSync();

    const payload = buildChecklistSnapshotPayload(await getChecklistsForTransaction(TXN));
    const pulled = payload.find((c) => c.template_id === TEMPLATE);
    expect(pulled).toBeDefined();
    expect(new Map(pulled!.items.map((i) => [i.title, i.local_item_id]))).toEqual(cloudIdsByTitle());
  });

  it("D3: a template picked on the desktop (no id given) still gets new, distinct random ids", async () => {
    seedLocal();
    const picked = await selectChecklistTemplate({
      transactionId: TXN,
      templateId: "tpl-picked-3596",
      templateName: "Picked template",
      // The shape the select-template IPC handler builds: no id field.
      items: [
        { title: "Picked one", isRequired: true, sortOrder: 0 },
        { title: "Picked two", isRequired: false, sortOrder: 1 },
      ],
    });
    if (picked.status !== "added") throw new Error("seed failed");
    const ids = (
      db
        .prepare("SELECT id FROM transaction_checklist_items WHERE checklist_id = ?")
        .all(picked.checklistId) as Array<{ id: string | null }>
    ).map((r) => r.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(2);
  });
});


// ===========================================================================
// BACKLOG-3607 PR 2 — a checklist the broker REMOVED at review disappears from
// the desktop (founder ruling 6563bab2 [pm_comments] Q2: also when the agent
// linked documents to it; the documents stay on the transaction), and a
// checklist the broker added back (restored) arrives through the same pull.
// ===========================================================================
/**
 * Cloud rows transcribed from migration 20260929120000 section 1: a header the
 * broker removed carries removed_at_review_by / removed_at_review_at (both or
 * neither, CHECK submission_checklists_removed_pair_check); a restored header
 * carries added_at_review_by and restored_from_checklist_id, and its items
 * restored_from_item_id (section 7: never local_item_id, never the agent's
 * tick, note or links). Ids are synthetic.
 *
 * Wrong implementations these catch:
 *   removal keyed on the cloud header id      -> nothing is ever deleted (R1)
 *   removal skipped when the agent edited it  -> the ruling is not applied (R1)
 *   the adds read keeps removed headers       -> an added-then-removed
 *                                                checklist lands (R2)
 *   a failed removal read treated as "none"   -> the marker is cleared and the
 *                                                removal is lost for good (R3)
 *   a write before the last read              -> a failed pull leaves a
 *                                                partial result (R3)
 *   the owed-pull event only on "added"       -> an open window keeps showing
 *                                                the removed checklist (R3)
 *   restored items given fresh ids            -> the broker's restored ticks
 *                                                never carry (R4)
 */
describe("BACKLOG-3607 — broker removals and restores reach the desktop", () => {
  const REMOVED_TPL = "tpl-3607-removed";
  const REMOVED_NAME = "Removed at review";
  const KEEP_TPL = "tpl-3607-keep";
  const BROKER = "broker-3607";
  let sent: Array<{ channel: string; rowsAtSend: number }>;

  beforeEach(() => {
    sent = [];
    jest.mocked(sendToMainWindow).mockImplementation((channel: string) => {
      sent.push({ channel, rowsAtSend: localChecklists().length });
      return true;
    });
  });

  const owed = (): unknown => {
    const row = db
      .prepare("SELECT json_extract(metadata, '$.reviewChecklistPullOwed') AS o FROM transactions WHERE id = ?")
      .get(TXN) as { o: string | null };
    return row.o === null ? null : JSON.parse(row.o);
  };
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  /**
   * The agent's own checklists as submitted (REMOVED_TPL and KEEP_TPL), then
   * EDITED locally after the submit: a tick, a note and an attachment linked
   * on the checklist the broker is about to remove.
   */
  async function seedAgentChecklists(): Promise<{ removedItemIds: string[] }> {
    seedLocal("under_review");
    db.prepare(
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, sender, recipients, sent_at, has_attachments)
       VALUES ('e-3607', ?, 'ext-e-3607', 'gmail', 'acct', 'Signed offer', 'l@example.com', 'agent@example.test', '2026-09-01T10:00:00Z', 1)`,
    ).run(USER);
    db.prepare(
      `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source) VALUES ('c-3607', ?, ?, 'e-3607', 'manual')`,
    ).run(USER, TXN);
    db.prepare(
      `INSERT INTO attachments (id, email_id, filename, mime_type, storage_path, created_at)
       VALUES ('att-3607', 'e-3607', 'offer.pdf', 'application/pdf', '/attachments/3607.pdf', '2026-09-01T10:00:00Z')`,
    ).run();

    const removed = await selectChecklistTemplate({
      transactionId: TXN,
      templateId: REMOVED_TPL,
      templateName: REMOVED_NAME,
      items: [
        { title: "Removed one", isRequired: true, sortOrder: 0 },
        { title: "Removed two", isRequired: false, sortOrder: 1 },
      ],
    });
    const keep = await selectChecklistTemplate({
      transactionId: TXN,
      templateId: KEEP_TPL,
      templateName: "Kept checklist",
      items: [{ title: "Kept one", isRequired: true, sortOrder: 0 }],
    });
    if (removed.status !== "added" || keep.status !== "added") throw new Error("seed failed");
    const removedItemIds = (
      db
        .prepare("SELECT id FROM transaction_checklist_items WHERE checklist_id = ? ORDER BY sort_order")
        .all(removed.checklistId) as Array<{ id: string }>
    ).map((r) => r.id);

    // Edited since the submit.
    await setChecklistItemChecked(removedItemIds[0], true);
    db.prepare("UPDATE transaction_checklist_items SET note = 'Signed copy attached' WHERE id = ?").run(
      removedItemIds[0],
    );
    const link = await addChecklistLink({ itemId: removedItemIds[0], kind: "attachment", targetIds: ["att-3607"] });
    if (link.status !== "added") throw new Error(`seed: link not added (${link.status})`);
    expect(count("transaction_checklist_links")).toBe(1);
    expect(count("transaction_checklist_link_members")).toBe(1);
    return { removedItemIds };
  }

  /** The submitted version's headers: REMOVED_TPL removed at review by the broker. */
  function seedCloudRemoval(status = "needs_changes"): void {
    cloud.submissions = [{ id: SUB, status, review_notes: "Please fix", parent_submission_id: null }];
    cloud.submission_checklists = [
      {
        id: "hdr-3607-removed",
        submission_id: SUB,
        template_id: REMOVED_TPL,
        template_name: REMOVED_NAME,
        sort_order: 0,
        added_at_review_by: null,
        added_at_review_at: null,
        removed_at_review_by: BROKER,
        removed_at_review_at: "2026-09-29 10:15:00+00",
        restored_from_checklist_id: null,
      },
      {
        id: "hdr-3607-keep",
        submission_id: SUB,
        template_id: KEEP_TPL,
        template_name: "Kept checklist",
        sort_order: 1,
        added_at_review_by: null,
        added_at_review_at: null,
        removed_at_review_by: null,
        removed_at_review_at: null,
        restored_from_checklist_id: null,
      },
    ];
    cloud.submission_checklist_items = [];
  }

  function expectRemovalApplied(): void {
    expect(localChecklists().map((c) => c.template_id)).toEqual([KEEP_TPL]);
    // The removed checklist's items, links and members went with it...
    expect(count("transaction_checklist_items")).toBe(1);
    expect(count("transaction_checklist_links")).toBe(0);
    expect(count("transaction_checklist_link_members")).toBe(0);
    // ...the documents stay on the transaction.
    expect(count("attachments")).toBe(1);
    expect(count("emails")).toBe(1);
    expect(count("communications")).toBe(1);
  }

  it("R1: a removal applies although the agent ticked, noted and linked a document since submitting", async () => {
    await seedAgentChecklists();
    seedCloudRemoval();

    await submissionSyncService.manualSync();

    expectRemovalApplied();
    expect(localStatus()).toBe("needs_changes");
    expect(owed()).toBeNull();
  });

  it("R1b: re-delivered (realtime after the poller) and the agent re-picks the template -> it is not removed again", async () => {
    await seedAgentChecklists();
    seedCloudRemoval();
    await submissionSyncService.manualSync();
    expectRemovalApplied();
    await deliverRealtime();
    expectRemovalApplied();

    const again = await selectChecklistTemplate({
      transactionId: TXN,
      templateId: REMOVED_TPL,
      templateName: REMOVED_NAME,
      items: [{ title: "Removed one", isRequired: true, sortOrder: 0 }],
    });
    expect(again.status).toBe("added");
    await submissionSyncService.manualSync();
    await submissionSyncService.syncSubmission(TXN);
    await deliverRealtime();
    expect(localChecklists().map((c) => c.template_id).sort()).toEqual([KEEP_TPL, REMOVED_TPL].sort());
  });

  it("R2: a checklist the broker added and then removed on the same version is not added", async () => {
    seedLocal();
    seedCloud("needs_changes");
    cloud.submission_checklists.push({
      id: "hdr-3607-added-removed",
      submission_id: SUB,
      template_id: "tpl-3607-added-removed",
      template_name: "Added then removed",
      sort_order: 3,
      added_at_review_by: BROKER,
      added_at_review_at: "2026-09-29 10:00:00+00",
      removed_at_review_by: BROKER,
      removed_at_review_at: "2026-09-29 10:05:00+00",
      restored_from_checklist_id: null,
    });
    cloud.submission_checklist_items.push({
      id: randomUUID(),
      submission_id: SUB,
      submission_checklist_id: "hdr-3607-added-removed",
      title: "Never on the desktop",
      is_required: true,
      is_checked: false,
      note: null,
      sort_order: 0,
      reviewer_checked: false,
      reviewer_checked_by: null,
      reviewer_checked_at: null,
      description: null,
      expected_document_type: null,
      restored_from_item_id: null,
    });

    await submissionSyncService.manualSync();

    // The broker-added checklist that is still on the version arrives; the
    // one removed at review does not.
    expectPulled();
    expect(localStatus()).toBe("needs_changes");
  });

  it("R3: a failed removal read writes nothing and is retried; after the failure-out it is owed and lands", async () => {
    await seedAgentChecklists();
    seedCloudRemoval();
    // A broker-added checklist on the same version: a pull that writes before
    // its last read would land it while the removal read fails.
    cloud.submission_checklists.push({
      id: HEADER,
      submission_id: SUB,
      template_id: TEMPLATE,
      template_name: TEMPLATE_NAME,
      sort_order: 2,
      added_at_review_by: BROKER,
      added_at_review_at: "2026-09-29 10:00:00+00",
      removed_at_review_by: null,
      removed_at_review_at: null,
      restored_from_checklist_id: null,
    });
    cloud.submission_checklist_items.push({
      id: randomUUID(),
      submission_id: SUB,
      submission_checklist_id: HEADER,
      title: "Broker item",
      is_required: true,
      is_checked: false,
      note: null,
      sort_order: 0,
      reviewer_checked: false,
      reviewer_checked_by: null,
      reviewer_checked_at: null,
      description: null,
      expected_document_type: null,
      restored_from_item_id: null,
    });
    cloud.removedFetchFailures = 3;

    await submissionSyncService.manualSync();
    // Held: nothing written, status unwritten.
    expect(localChecklists().map((c) => c.template_id).sort()).toEqual([KEEP_TPL, REMOVED_TPL].sort());
    expect(localStatus()).toBe("under_review");

    await submissionSyncService.manualSync();
    await submissionSyncService.manualSync();
    // Third failure: status written, pull owed, still nothing written.
    expect(localStatus()).toBe("needs_changes");
    expect(owed()).toEqual([SUB]);
    expect(localChecklists().map((c) => c.template_id).sort()).toEqual([KEEP_TPL, REMOVED_TPL].sort());
    expect(sent.filter((s) => s.channel === "transaction-checklists-changed")).toEqual([]);

    // Next pass: the owed pull lands the removal (and the add), clears the
    // marker, and tells an open window after the rows are committed.
    await submissionSyncService.manualSync();
    expect(localChecklists().map((c) => c.template_id).sort()).toEqual([KEEP_TPL, TEMPLATE].sort());
    expect(count("transaction_checklist_links")).toBe(0);
    expect(count("attachments")).toBe(1);
    expect(owed()).toBeNull();
    expect(sent.filter((s) => s.channel === "transaction-checklists-changed")).toEqual([
      { channel: "transaction-checklists-changed", rowsAtSend: 2 },
    ]);
  });

  it("R3b: an owed pull that only REMOVES still tells an open window", async () => {
    await seedAgentChecklists();
    seedCloudRemoval();
    cloud.removedFetchFailures = 3;
    await submissionSyncService.manualSync();
    await submissionSyncService.manualSync();
    await submissionSyncService.manualSync();
    expect(owed()).toEqual([SUB]);

    await submissionSyncService.manualSync();

    expectRemovalApplied();
    expect(owed()).toBeNull();
    expect(sent.filter((s) => s.channel === "transaction-checklists-changed")).toEqual([
      { channel: "transaction-checklists-changed", rowsAtSend: 1 },
    ]);
  });

  it("R5: one local transaction - an add that fails rolls the removal back too; the status is held for retry", async () => {
    await seedAgentChecklists();
    seedCloudRemoval();
    // A broker-added item whose id is already a local item id: the insert
    // hits the primary key (checklistDbService: "A PK clash throws and rolls
    // back"). Not producible by the server; it is the fault injected here.
    const keptItemId = (
      db.prepare(
        "SELECT i.id FROM transaction_checklist_items i JOIN transaction_checklists c ON c.id = i.checklist_id WHERE c.template_id = ?",
      ).get(KEEP_TPL) as { id: string }
    ).id;
    cloud.submission_checklists.push({
      id: HEADER,
      submission_id: SUB,
      template_id: TEMPLATE,
      template_name: TEMPLATE_NAME,
      sort_order: 2,
      added_at_review_by: BROKER,
      added_at_review_at: "2026-09-29 10:00:00+00",
      removed_at_review_by: null,
      removed_at_review_at: null,
      restored_from_checklist_id: null,
    });
    cloud.submission_checklist_items.push({
      id: keptItemId,
      submission_id: SUB,
      submission_checklist_id: HEADER,
      title: "Clashing item",
      is_required: true,
      is_checked: false,
      note: null,
      sort_order: 0,
      reviewer_checked: false,
      reviewer_checked_by: null,
      reviewer_checked_at: null,
      description: null,
      expected_document_type: null,
      restored_from_item_id: null,
    });

    await submissionSyncService.manualSync();

    // Nothing of the pull landed: the removed checklist and its evidence are
    // still there, and the status waits for the retry.
    expect(localChecklists().map((c) => c.template_id).sort()).toEqual([KEEP_TPL, REMOVED_TPL].sort());
    expect(count("transaction_checklist_links")).toBe(1);
    expect(count("transaction_checklist_link_members")).toBe(1);
    expect(localStatus()).toBe("under_review");
  });

  it("R4: a checklist the broker added back (restored) arrives with the restored rows' cloud ids, unticked", async () => {
    // The agent removed REMOVED_TPL before this version; the broker restored
    // it onto this version (restore_submission_checklist_at_review).
    seedLocal();
    cloud.submissions = [
      { id: SUB, status: "needs_changes", review_notes: "Added back", parent_submission_id: null },
    ];
    cloud.submission_checklists = [
      {
        id: "hdr-3607-restored",
        submission_id: SUB,
        template_id: REMOVED_TPL,
        template_name: REMOVED_NAME,
        sort_order: 0,
        added_at_review_by: BROKER,
        added_at_review_at: "2026-09-29 11:00:00+00",
        removed_at_review_by: null,
        removed_at_review_at: null,
        restored_from_checklist_id: "hdr-3607-v1-source",
      },
    ];
    const restoredItem = (title: string, sort: number, ticked: boolean) => ({
      id: randomUUID(),
      submission_id: SUB,
      submission_checklist_id: "hdr-3607-restored",
      title,
      local_item_id: null,
      is_required: true,
      is_checked: false,
      note: null,
      sort_order: sort,
      reviewer_checked: ticked,
      reviewer_checked_by: ticked ? BROKER : null,
      reviewer_checked_at: ticked ? "2026-09-20 10:01:00+00" : null,
      description: null,
      expected_document_type: null,
      restored_from_item_id: randomUUID(),
    });
    cloud.submission_checklist_items = [
      restoredItem("Removed one", 0, true),
      restoredItem("Removed two", 1, false),
    ];

    await submissionSyncService.manualSync();

    const lists = localChecklists();
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ template_id: REMOVED_TPL, template_name: REMOVED_NAME });
    const local = db
      .prepare("SELECT id, title, is_checked, note FROM transaction_checklist_items WHERE checklist_id = ? ORDER BY sort_order")
      .all(lists[0].id);
    expect(local).toEqual(
      cloud.submission_checklist_items.map((row) => ({ id: row.id, title: row.title, is_checked: 0, note: null })),
    );
    // The next version sends those ids as local_item_id, so the carry matches
    // the restored items and the restored ticks carry.
    const payload = buildChecklistSnapshotPayload(await getChecklistsForTransaction(TXN));
    expect(payload[0].items.map((i) => i.local_item_id)).toEqual(
      cloud.submission_checklist_items.map((row) => row.id),
    );
    expect(count("transaction_checklist_links")).toBe(0);
  });
  // ---- BACKLOG-3607 (SR B-1): an owed pull for version N after N+1 exists ----
  const SUB3 = "sub-3607-v3";
  /**
   * What a resubmit leaves behind: a cloud row for the next version whose
   * parent is SUB (status "resubmitted", submissionService finalStatus), and
   * the local transaction pointing at it.
   */
  function resubmitLocallyAndInCloud(): void {
    cloud.submissions.push({
      id: SUB3,
      status: "resubmitted",
      review_notes: null,
      parent_submission_id: SUB,
    });
    db.prepare(
      "UPDATE transactions SET submission_id = ?, submission_status = 'resubmitted' WHERE id = ?",
    ).run(SUB3, TXN);
  }
  /** Three failed passes: the status is written and the pull is owed for SUB. */
  async function owePullForSub(): Promise<void> {
    await submissionSyncService.manualSync();
    await submissionSyncService.manualSync();
    await submissionSyncService.manualSync();
    expect(owed()).toEqual([SUB]);
  }
  const localTemplates = (): string[] => localChecklists().map((c) => c.template_id).sort();

  it("C-B1a: an owed REMOVAL for v2 that lands after v3 exists leaves the local checklist alone", async () => {
    await seedAgentChecklists();
    seedCloudRemoval();
    cloud.removedFetchFailures = 3;
    await owePullForSub();
    resubmitLocallyAndInCloud();

    await submissionSyncService.manualSync();

    expect(localTemplates()).toEqual([KEEP_TPL, REMOVED_TPL].sort());
    expect(owed()).toBeNull();
  });

  it("C-B1b: an owed ADD for v2 (the 3599 retry) that lands after v3 exists writes nothing", async () => {
    seedLocal();
    seedCloud("needs_changes");
    cloud.checklistFetchFailures = 3;
    await owePullForSub();
    resubmitLocallyAndInCloud();

    await submissionSyncService.manualSync();

    expect(localChecklists()).toEqual([]);
    expect(owed()).toBeNull();
  });

  it("C-B1c: v3 exists in the cloud but the local pointer never moved -> still not applied", async () => {
    await seedAgentChecklists();
    seedCloudRemoval();
    cloud.removedFetchFailures = 3;
    await owePullForSub();
    resubmitLocallyAndInCloud();
    // The resubmit's local status write failed: the pointer is still SUB.
    db.prepare(
      "UPDATE transactions SET submission_id = ?, submission_status = 'needs_changes' WHERE id = ?",
    ).run(SUB, TXN);

    await submissionSyncService.manualSync();

    expect(localTemplates()).toEqual([KEEP_TPL, REMOVED_TPL].sort());
    expect(owed()).toBeNull();
  });

  it("C-B1d: the newer-version read fails -> nothing written, marker kept; next pass drops it", async () => {
    await seedAgentChecklists();
    seedCloudRemoval();
    cloud.removedFetchFailures = 3;
    await owePullForSub();
    resubmitLocallyAndInCloud();
    cloud.newerVersionReadFailures = 1;

    await submissionSyncService.manualSync();

    expect(cloud.newerVersionReadFailures).toBe(0); // the failing read was reached
    expect(localTemplates()).toEqual([KEEP_TPL, REMOVED_TPL].sort());
    expect(owed()).toEqual([SUB]);

    await submissionSyncService.manualSync();

    expect(localTemplates()).toEqual([KEEP_TPL, REMOVED_TPL].sort());
    expect(owed()).toBeNull();
  });
});
