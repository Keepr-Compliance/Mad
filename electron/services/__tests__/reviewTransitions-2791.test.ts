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
  /**
   * BACKLOG-2818 — a rejection row written by a SHIPPED build still routes home.
   *
   * Every other rejection in this file is written by rejectReviewItems, which
   * now uses REVIEW_REJECTION_REASON — so read and write would move together and
   * a renamed constant would leave the whole file green while silently
   * reclassifying every row already on a user's disk as an ordinary removal
   * (and handing them a one-click path from "rejected, never approved" to
   * "linked"). The literal below is spelled out LONGHAND ON PURPOSE: it is the
   * value shipped builds persisted, and it is what makes that rename go red.
   */
  it("a rejection row written by a shipped build (raw 'rejected_in_review') still restores to SUGGESTED", async () => {
    addEmail("e-shipped", "Are you free Thursday?");
    db.prepare(
      `INSERT INTO ignored_communications (id,user_id,transaction_id,email_id,reason,match_reason)
       VALUES ('ig-shipped',?,?,'e-shipped','rejected_in_review','address_missing')`,
    ).run(U, T);

    expect(await restoreRejectedToQueue("ig-shipped")).toBe(1);
    expect(where()).toEqual({ suggested: ["e-shipped"], linked: [], removed: [] });
  });

  it("restore of a REVIEW rejection -> back to SUGGESTED, never straight to linked", async () => {
    addEmail("e-miss", "Are you free Thursday?");
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    await rejectReviewItems([getReviewState(T).items[0].id]);

    const ig = db.prepare("SELECT id FROM ignored_communications WHERE transaction_id=?").get(T) as { id: string };
    expect(await restoreRejectedToQueue(ig.id)).toBe(1);

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
    // Returns a COUNT now (0 = not a review rejection, so untouched).
    expect(await restoreRejectedToQueue("ig-old")).toBe(0);
    // Untouched by the review path — the old handler still owns it.
    expect(where().removed).toEqual(["e-old"]);
  });
});

describe("grouped restore (BACKLOG-2791) — the whole card comes back", () => {
  it("two rejections in ONE provider thread both re-queue from a single restore", async () => {
    // The founder's case: two recurring calendar invites, which the provider
    // threads into one conversation. Show removed groups by thread_id and hands
    // the restore ONE representative, so a short-circuit that handled a single
    // row restored one invite and left the other to reappear alone.
    addEmail("e-1", "Weekly sync");
    addEmail("e-2", "Weekly sync");
    db.prepare("UPDATE emails SET thread_id = 'th-recurring' WHERE id IN ('e-1','e-2')").run();

    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    expect(where().suggested).toEqual(["e-1", "e-2"]);

    const ids = getReviewState(T).items.map((i) => i.id);
    await rejectReviewItems(ids);
    expect(where()).toEqual({ suggested: [], linked: [], removed: ["e-1", "e-2"] });

    // ONE restore, on the representative the grouped card supplies.
    const rep = db.prepare(
      "SELECT id FROM ignored_communications WHERE transaction_id=? AND email_id='e-1'",
    ).get(T) as { id: string };
    const restored = await restoreRejectedToQueue(rep.id);

    expect(restored).toBe(2);
    // BOTH ids leave removed and land back in the queue — asserted as sets.
    expect(where()).toEqual({ suggested: ["e-1", "e-2"], linked: [], removed: [] });
  });

  it("a rejection with NO thread siblings still restores exactly one", async () => {
    addEmail("e-solo", "One off");
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    await rejectReviewItems([getReviewState(T).items[0].id]);

    const ig = db.prepare("SELECT id FROM ignored_communications WHERE transaction_id=?").get(T) as { id: string };
    expect(await restoreRejectedToQueue(ig.id)).toBe(1);
    expect(where()).toEqual({ suggested: ["e-solo"], linked: [], removed: [] });
  });

  it("thread siblings that are NOT review rejections are left alone", async () => {
    // A mixed thread: one review rejection, one ordinary removal. The ordinary
    // one keeps its shipped destination and must not be swept into the queue.
    addEmail("e-rej", "Weekly sync");
    addEmail("e-old", "Weekly sync");
    db.prepare("UPDATE emails SET thread_id = 'th-mixed' WHERE id IN ('e-rej','e-old')").run();

    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    const rejId = getReviewState(T).items.find((i) => i.email_id === "e-rej")!.id;
    await rejectReviewItems([rejId]);

    // e-old becomes an ORDINARY removal: drop it from the queue and write the
    // kind of suppression row the old unlink path writes. (An earlier draft
    // UPDATEd a row that did not exist yet, so e-old was never removed at all
    // and the test was asserting against a state it had not built.)
    db.prepare("DELETE FROM pending_review_communications WHERE email_id='e-old'").run();
    db.prepare(
      `INSERT INTO ignored_communications (id,user_id,transaction_id,email_id,reason,match_reason)
       VALUES ('ig-ordinary',?,?,'e-old','user_removed','address_missing')`,
    ).run(U, T);

    const rep = db.prepare(
      "SELECT id FROM ignored_communications WHERE transaction_id=? AND email_id='e-rej'",
    ).get(T) as { id: string };
    expect(await restoreRejectedToQueue(rep.id)).toBe(1);

    // Only the rejection came back; the ordinary removal is still removed.
    expect(where()).toEqual({ suggested: ["e-rej"], linked: [], removed: ["e-old"] });
  });
});

/**
 * INVARIANT 1, NAMED.
 *
 * Communication Lifecycle Contract: "nothing ever moves SUGGESTED -> LINKED
 * except T1's sync split or an explicit Confirm (T3) — never silently."
 *
 * It was already true, but only as a CONSEQUENCE of tests aimed at other
 * things: one test showed an address-missing email is not linked at discovery,
 * another showed approve links. Nothing asserted the gap between them — that no
 * OTHER operation can carry an item across. So a new write path (the class of
 * bug that produced the text-restore side door, where a rejected text came back
 * as an ordinary link and landed in the audit unapproved) would have to be
 * caught by a test that was not looking for it.
 *
 * This one looks for it: it drives every non-Confirm operation that touches
 * review state over a SUGGESTED email and asserts, by ID SET after each, that
 * `communications` never gains it — then approves, and shows the door opening.
 *
 * CONTROLS RUN (MEASURED, run with `-t "INVARIANT 1"` so the numbers describe
 * THIS block; the whole file's totals are given after each for context):
 *  1. Make `restoreRejectedToQueue` also link on restore — the historical side
 *     door                            -> RED, 1 of 2 here (6 of 12 file-wide).
 *  2. Drop the `!isConfident` branch in autoLinkService so discovery links the
 *     ambiguous half outright         -> RED, 2 of 2 here (8 of 12 file-wide).
 *
 * Control 2 taking down BOTH tests here is the point: if discovery stops
 * queueing, "SUGGESTED" has no occupants and the invariant is vacuous. A test
 * that stayed green under it would be asserting nothing.
 */
describe("INVARIANT 1 — SUGGESTED reaches LINKED through exactly two doors", () => {
  beforeEach(async () => {
    addEmail("e-miss", "Are you free Thursday?");
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    expect(where()).toEqual({ suggested: ["e-miss"], linked: [], removed: [] });
  });

  it("no re-sync, on any axis, ever links a suggested email", async () => {
    for (const reason of ["open", "background", "contact-change", "date-extended"] as const) {
      await syncReviewQueueForTransaction({ transactionId: T, reason });
      // Asserted after EVERY axis, not once at the end, so a failure names the
      // axis that opened the door.
      expect(where()).toEqual({ suggested: ["e-miss"], linked: [], removed: [] });
    }
  });

  it("a reject/restore round trip returns it to SUGGESTED and never to LINKED", async () => {
    const id = getReviewState(T).items[0].id;
    await rejectReviewItems([id]);
    expect(where()).toEqual({ suggested: [], linked: [], removed: ["e-miss"] });

    const ignoredId = (db
      .prepare("SELECT id FROM ignored_communications WHERE transaction_id=? AND email_id=?")
      .get(T, "e-miss") as { id: string }).id;
    await restoreRejectedToQueue(ignoredId);

    // Back where it started — NOT linked. It was never approved.
    expect(where()).toEqual({ suggested: ["e-miss"], linked: [], removed: [] });

    // And a sweep over the restored item still does not link it.
    await syncReviewQueueForTransaction({ transactionId: T, reason: "open" });
    expect(where().linked).toEqual([]);

    // THE DOOR: an explicit Confirm, and only that, moves it.
    await approveReviewItems([getReviewState(T).items[0].id]);
    expect(where()).toEqual({ suggested: [], linked: ["e-miss"], removed: [] });
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
