/**
 * @jest-environment node
 *
 * BACKLOG-2791 — THE TRANSITION MATRIX.
 *
 * An email lives in exactly one of three places, and the founder's bar is that
 * it moves between them smoothly in BOTH directions:
 *
 *   SUGGESTED  = pending_review_communications  (Needs Review)
 *   LINKED     = communications                 (the tab's linked list)
 *   REMOVED    = ignored_communications         (Show removed)
 *
 * The rule: OLD buttons keep OLD destinations (trash -> removed, confirm ->
 * linked); the NEW review actions are separate. Every transition below is
 * asserted BY ID SET across all three stores at once, so an item cannot be
 * "somewhere else" and still pass.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/m") },
  BrowserWindow: { getAllWindows: () => [] },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(), setUser: jest.fn(), addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = { info: jest.fn().mockResolvedValue(undefined), debug: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined), error: jest.fn().mockResolvedValue(undefined) };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../databaseEncryptionService", () => {
  const m = { initialize: jest.fn().mockResolvedValue(undefined), getEncryptionKey: jest.fn().mockResolvedValue("k"),
    isDatabaseEncrypted: jest.fn().mockResolvedValue(false), getCachedKey: jest.fn(() => "k"),
    getKeyMetadata: jest.fn().mockResolvedValue({}) };
  return { __esModule: true, default: m, databaseEncryptionService: m };
});
jest.mock("../contactsService", () => ({ getContactNames: jest.fn(() => Promise.resolve([])) }));
jest.mock("../../workers/contactWorkerPool", () => ({ queryContacts: jest.fn(), isPoolReady: jest.fn(() => false) }));

import { createMigrationHarness, type MigrationHarness } from "./helpers/migrationTestHarness";
import {
  getReviewState,
  syncReviewQueueForTransaction,
  approveReviewItems,
  rejectReviewItems,
  restoreRejectedToQueue,
} from "../reviewStateService";

const U = "u-m", T = "t-m", C = "c-m", PROPERTY = "3414 Sapp Rd SW";
const SCHEMA = fs.readFileSync(path.join(__dirname, "../../database/schema.sql"), "utf8");

/** The exact join "Show removed" uses (transactions:get-removed-emails). */
const REMOVED_SQL = `
  SELECT DISTINCT e.id AS email_id FROM ignored_communications ic
  JOIN emails e ON ((ic.email_id IS NOT NULL AND ic.email_id = e.id)
    OR (ic.original_communication_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM communications c WHERE c.id = ic.original_communication_id AND c.email_id = e.id)))
  WHERE ic.transaction_id = ? ORDER BY e.id`;

let h: MigrationHarness;
let db: DatabaseType;

const suggested = () => getReviewState(T).items.filter((i) => i.origin === "pending").map((i) => i.email_id).sort();
const linked = () => (db.prepare(
  "SELECT email_id FROM communications WHERE transaction_id=? AND email_id IS NOT NULL ORDER BY email_id",
).all(T) as Array<{ email_id: string }>).map((r) => r.email_id);
const removed = () => (db.prepare(REMOVED_SQL).all(T) as Array<{ email_id: string }>).map((r) => r.email_id);
/** Where does each email live, right now? */
const where = () => ({ suggested: suggested(), linked: linked(), removed: removed() });

function addEmail(id: string, body: string): void {
  db.prepare(
    `INSERT INTO emails (id,user_id,subject,sender,body_plain,sent_at,created_at)
     VALUES (?,?,?, 'jane@example.com', ?, '2026-06-01T00:00:00.000Z', CURRENT_TIMESTAMP)`,
  ).run(id, U, `S ${id}`, body);
  db.prepare(
    `INSERT INTO email_participants (email_id,role,position,participant_hash,email_address)
     VALUES (?, 'from', 0, ?, 'jane@example.com')`,
  ).run(id, `h-${id}`);
}

beforeEach(() => {
  h = createMigrationHarness({ seedV29Schema: false });
  db = h.db;
  db.exec(SCHEMA);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS i1 ON pending_review_communications(transaction_id,email_id) WHERE email_id IS NOT NULL;`);
  for (const t of ["transaction_contacts", "contacts"]) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN removed_at DATETIME;`);
    db.exec(`ALTER TABLE ${t} ADD COLUMN removed_reason TEXT;`);
  }
  db.prepare("INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?,?,'google','o')").run(U, "me@a.com");
  db.prepare("INSERT INTO transactions (id,user_id,property_address,started_at,closed_at) VALUES (?,?,?,?,?)")
    .run(T, U, PROPERTY, "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
  db.prepare("INSERT INTO contacts (id,user_id,display_name) VALUES (?,?,?)").run(C, U, "Jane Seller");
  db.prepare("INSERT INTO contact_emails (id,contact_id,email) VALUES ('ce',?,?)").run(C, "jane@example.com");
  db.prepare("INSERT INTO transaction_contacts (id,transaction_id,contact_id) VALUES ('tc',?,?)").run(T, C);
});
afterEach(async () => { try { await h.cleanup(); } catch { /* cleaned */ } });

describe("discovery places each email in exactly one home", () => {
  it("address-matching -> LINKED; address-missing -> SUGGESTED", async () => {
    addEmail("e-match", `Docs for ${PROPERTY} attached.`);
    addEmail("e-miss", "Are you free Thursday?");
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    expect(where()).toEqual({ suggested: ["e-miss"], linked: ["e-match"], removed: [] });
  });
});

describe("SUGGESTED ->", () => {
  beforeEach(async () => {
    addEmail("e-miss", "Are you free Thursday?");
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    expect(where().suggested).toEqual(["e-miss"]);
  });

  it("approve -> LINKED (and out of suggested)", async () => {
    await approveReviewItems([getReviewState(T).items[0].id]);
    expect(where()).toEqual({ suggested: [], linked: ["e-miss"], removed: [] });
  });

  it("trash/reject -> REMOVED, visible in Show removed, NOT still suggested", async () => {
    // The founder's report: the email vanished instead of appearing in Show
    // removed. The row was always written; the LIST never re-fetched.
    await rejectReviewItems([getReviewState(T).items[0].id]);
    expect(where()).toEqual({ suggested: [], linked: [], removed: ["e-miss"] });
  });

  it("a re-sync does not resurrect a removed email", async () => {
    await rejectReviewItems([getReviewState(T).items[0].id]);
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    expect(where()).toEqual({ suggested: [], linked: [], removed: ["e-miss"] });
  });
});

describe("REMOVED -> (the reverse paths)", () => {
  it("restore of a REVIEW rejection -> back to SUGGESTED, never straight to linked", async () => {
    addEmail("e-miss", "Are you free Thursday?");
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    await rejectReviewItems([getReviewState(T).items[0].id]);

    const ig = db.prepare("SELECT id FROM ignored_communications WHERE transaction_id=?").get(T) as { id: string };
    expect(await restoreRejectedToQueue(ig.id)).toBe(true);

    // Back where it was, still awaiting approval — it was never approved.
    expect(where()).toEqual({ suggested: ["e-miss"], linked: [], removed: [] });
  });

  it("restore of an ORDINARY removal is NOT hijacked by the review path", async () => {
    // A legacy/unlink removal must keep develop's behaviour: the old restore
    // re-links it. Keyed on reason, so the two cannot be confused.
    addEmail("e-old", "whatever");
    db.prepare(
      `INSERT INTO ignored_communications (id,user_id,transaction_id,email_id,reason,match_reason)
       VALUES ('ig-old',?,?,'e-old','user_removed','address_missing')`,
    ).run(U, T);
    expect(await restoreRejectedToQueue("ig-old")).toBe(false);
    // Untouched by the review path — the old handler still owns it.
    expect(where().removed).toEqual(["e-old"]);
  });
});

describe("round trip", () => {
  it("suggested -> removed -> suggested -> linked, ending linked exactly once", async () => {
    addEmail("e-miss", "Are you free Thursday?");
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });

    await rejectReviewItems([getReviewState(T).items[0].id]);
    expect(where()).toEqual({ suggested: [], linked: [], removed: ["e-miss"] });

    const ig = db.prepare("SELECT id FROM ignored_communications WHERE transaction_id=?").get(T) as { id: string };
    await restoreRejectedToQueue(ig.id);
    expect(where()).toEqual({ suggested: ["e-miss"], linked: [], removed: [] });

    await approveReviewItems([getReviewState(T).items[0].id]);
    expect(where()).toEqual({ suggested: [], linked: ["e-miss"], removed: [] });
  });
});
