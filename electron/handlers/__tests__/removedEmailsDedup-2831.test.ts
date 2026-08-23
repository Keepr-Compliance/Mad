/**
 * @jest-environment node
 *
 * BACKLOG-2831 — Show removed rendered one email twice.
 *
 * Founder, 2026-08-23: "the same issue is with the show removed — it's showing
 * everything twice, but not two cards. The cards show it has two emails."
 *
 * THE WRITE THAT CAUSED IT, measured on the real driver before this fix:
 * `ignored_communications` has no uniqueness constraint (every index on it is a
 * plain CREATE INDEX) and `addIgnoredCommunication` is a bare INSERT with a
 * fresh uuid. A twinned email — one present in BOTH review stores — rendered as
 * two items inside ONE review thread group; the card's Reject passes every id in
 * the group (`group.items.map(i => i.id)`), so `rejectReviewItems` looped twice
 * and wrote TWO suppression rows, identical but for the uuid
 * (`{rejected: 2, ignoredRows: 2}`; after the review-side fix, `{1, 1}`).
 *
 * WHY THE READ SIDE IS THE HALF THAT MATTERS: those rows are already written, in
 * every database that hit the route. `SELECT DISTINCT` cannot collapse them —
 * `ic.id` differs — so the handler returned two rows, `groupRemovedEmailsByThread`
 * put both in one thread group, and the card read "(2 emails)" with the same
 * message twice. No write-path correctness un-writes them; collapsing on read
 * makes an already-damaged database render correctly with no migration.
 *
 * MEASURED CONTROLS (mutation applied to the handler, suite re-run):
 *  1. Remove the collapse entirely (return `rows`)     -> RED, 2 of 5.
 *  2. Collapse on `email_id` ALONE, dropping reason/match_reason from the key
 *                                                      -> RED, 1 of 5 — the
 *     flavour test, which is the only one that can see it. That test is the
 *     reason the key is three columns: `classifyRemoval` routes a Restore on
 *     exactly those two fields (Communication Lifecycle Contract T6/T7/T7b), so
 *     merging a review rejection with an ordinary removal would send a restore
 *     to the wrong destination.
 *  3. Keep the LATEST duplicate instead of the earliest -> RED, 2 of 5, not the
 *     1 predicted: the ordering test sees it too, because which duplicate
 *     survives also decides which ignored_id represents the group.
 */

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/mock/user/data") },
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  },
  BrowserWindow: { getAllWindows: jest.fn(() => []) },
}));
jest.mock("../../utils/wrapHandler", () => ({
  wrapHandler: (fn: IpcHandler) => fn,
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../../services/logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../../services/databaseEncryptionService", () => {
  const m = {
    initialize: jest.fn().mockResolvedValue(undefined),
    getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false),
    getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}),
  };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../../services/contactsService", () => ({
  getContactNames: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../../workers/contactWorkerPool", () => ({
  queryContacts: jest.fn(),
  isPoolReady: jest.fn(() => false),
}));

import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";
import {
  createMigrationHarness,
  type MigrationHarness,
} from "../../services/__tests__/helpers/migrationTestHarness";
import { registerEmailLinkingHandlers } from "../emailLinkingHandlers";
import { REVIEW_REJECTION_REASON } from "../../types/ipc/communicationLifecycle";

const USER = "11111111-2222-4333-8444-555555555555";
// A REAL uuid: the handler runs `validateTransactionId`, which rejects anything
// else outright. A "t-2831b"-style fixture id is a transaction the app cannot
// have, and every test below failed with ValidationError until this matched what
// the producer actually emits.
const TXN = "66666666-7777-4888-8999-aaaaaaaaaaaa";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "../../database/schema.sql"),
  "utf8",
);

interface RemovedRow {
  ignored_id: string;
  email_id: string;
  reason: string | null;
  match_reason: string | null;
  ignored_at: string | null;
}

function seed(db: DatabaseType): void {
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'oauth-1')",
  ).run(USER, "me@agent.com");
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, started_at, closed_at)
     VALUES (?, ?, '1 Test St', '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z')`,
  ).run(TXN, USER);
}

function addEmail(db: DatabaseType, id: string, subject: string, threadId: string | null): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, subject, sender, body_plain, thread_id, sent_at, created_at)
     VALUES (?, ?, ?, 'paul@example.com', 'hello', ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(id, USER, subject, threadId);
}

/** A suppression row exactly as `addIgnoredCommunication` writes one. */
function addIgnored(
  db: DatabaseType,
  id: string,
  emailId: string,
  opts: { reason?: string | null; matchReason?: string | null; ignoredAt: string },
): void {
  db.prepare(
    `INSERT INTO ignored_communications
       (id, user_id, transaction_id, email_id, thread_id, reason, match_reason, ignored_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).run(
    id,
    USER,
    TXN,
    emailId,
    opts.reason === undefined ? REVIEW_REJECTION_REASON : opts.reason,
    opts.matchReason === undefined ? "address_missing" : opts.matchReason,
    opts.ignoredAt,
  );
}

async function getRemoved(): Promise<RemovedRow[]> {
  const handler = handlers.get("transactions:get-removed-emails");
  if (!handler) throw new Error("handler not registered");
  const res = (await handler({}, TXN)) as { removedEmails: RemovedRow[] };
  return res.removedEmails;
}

describe("BACKLOG-2831 — Show removed collapses a duplicated removal", () => {
  let harness: MigrationHarness;
  let db: DatabaseType;

  beforeAll(() => {
    registerEmailLinkingHandlers();
  });

  beforeEach(() => {
    harness = createMigrationHarness({ seedV29Schema: false });
    db = harness.db;
    seed(db);
  });

  afterEach(async () => {
    try {
      await harness.cleanup();
    } catch {
      /* already cleaned */
    }
  });

  it("returns ONE entry for an email that acquired two identical removal rows", async () => {
    // The pair a pre-fix reject of a twinned card wrote: same email, same
    // discriminator, different uuid.
    addEmail(db, "e1", "Recurring invite", "th-1");
    addIgnored(db, "ic-1", "e1", { ignoredAt: "2026-08-20 10:00:00" });
    addIgnored(db, "ic-2", "e1", { ignoredAt: "2026-08-20 10:00:01" });

    const rows = await getRemoved();
    expect(rows.map((r) => r.email_id)).toEqual(["e1"]);
  });

  it("keeps the EARLIEST row, so the entry carries the original removal time", async () => {
    addEmail(db, "e1", "Recurring invite", "th-1");
    addIgnored(db, "ic-late", "e1", { ignoredAt: "2026-08-20 10:00:01" });
    addIgnored(db, "ic-early", "e1", { ignoredAt: "2026-08-20 10:00:00" });

    const rows = await getRemoved();
    expect(rows.map((r) => r.ignored_id)).toEqual(["ic-early"]);
    expect(rows[0].ignored_at).toBe("2026-08-20 10:00:00");
  });

  it("does NOT merge removals that disagree on the flavour, because Restore routes on it", async () => {
    // THE GUARD. `classifyRemoval(reason, matchReason)` decides where a Restore
    // sends the email: a review rejection returns to the review queue (T7b), an
    // ordinary removal recreates a link (T6). Two rows for one email that
    // disagree are a real distinction, not a duplicate — collapsing them would
    // silently move a restore to the wrong destination. This is the only test
    // that can see a key of `email_id` alone.
    addEmail(db, "e1", "Contested", "th-1");
    addIgnored(db, "ic-review", "e1", { ignoredAt: "2026-08-20 10:00:00" });
    addIgnored(db, "ic-manual", "e1", {
      reason: "Manually unlinked by user",
      matchReason: null,
      ignoredAt: "2026-08-20 11:00:00",
    });

    const rows = await getRemoved();
    expect(rows.map((r) => r.ignored_id).sort()).toEqual(["ic-manual", "ic-review"]);
    expect(rows.map((r) => r.reason).sort()).toEqual([
      "Manually unlinked by user",
      REVIEW_REJECTION_REASON,
    ]);
  });

  it("leaves two genuinely different emails in one thread as two entries", async () => {
    // The over-collapse control, mirroring the review side: a thread of two
    // removed emails must stay two entries with two Restores.
    addEmail(db, "e1", "Offer", "th-1");
    addEmail(db, "e2", "Re: Offer", "th-1");
    addIgnored(db, "ic-1", "e1", { ignoredAt: "2026-08-20 10:00:00" });
    addIgnored(db, "ic-2", "e2", { ignoredAt: "2026-08-20 10:00:01" });

    const rows = await getRemoved();
    expect(rows.map((r) => r.email_id).sort()).toEqual(["e1", "e2"]);
  });

  it("preserves newest-first ordering across the collapse", async () => {
    addEmail(db, "e-old", "Older", null);
    addEmail(db, "e-new", "Newer", null);
    addIgnored(db, "ic-old", "e-old", { ignoredAt: "2026-08-19 09:00:00" });
    addIgnored(db, "ic-new-a", "e-new", { ignoredAt: "2026-08-21 09:00:00" });
    addIgnored(db, "ic-new-b", "e-new", { ignoredAt: "2026-08-21 09:00:05" });

    const rows = await getRemoved();
    expect(rows.map((r) => r.email_id)).toEqual(["e-new", "e-old"]);
    expect(rows.map((r) => r.ignored_id)).toEqual(["ic-new-a", "ic-old"]);
  });
});
