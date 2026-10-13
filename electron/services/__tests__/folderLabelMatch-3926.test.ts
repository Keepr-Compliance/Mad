/**
 * @jest-environment node
 */
/**
 * BACKLOG-3926 — Needs Review "Folder / label match".
 *
 * Real driver, real schema (`electron/database/schema.sql`). Run under the Electron
 * jest runner:
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 *
 * Provider fixtures are transcribed from the shapes the fetch services read:
 *   - Gmail `users.labels.list` -> `response.data.labels[]` {id, name, type, ...}
 *     (gmailFetchService.discoverLabels / listLabelCatalogSource)
 *   - Graph `/me/mailFolders` + `/childFolders` with
 *     `$select=id,displayName,parentFolderId,childFolderCount` -> `value[]`
 *     (outlookFetchService.discoverFolders), and the `$batch` of
 *     `GET /me/mailFolders/{wellKnownName}?$select=id` -> `responses[]{id,status,body:{id}}`
 *   - parsed messages: Gmail `labels` = `message.labelIds`; Outlook
 *     `parentFolderId` = `message.parentFolderId` (the parsers' fields)
 * Every name, id and address is invented.
 */
import fs from "fs";
import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const logCalls: unknown[][] = [];
jest.mock("../logService", () => {
  const rec = jest.fn((...args: unknown[]) => {
    logCalls.push(args);
    return Promise.resolve(undefined);
  });
  return { __esModule: true, default: { info: rec, warn: rec, error: rec, debug: rec } };
});

const gmailListLabels = jest.fn();
const gmailPeekLabels = jest.fn();
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    listLabelCatalogSource: (...a: unknown[]) => gmailListLabels(...a),
    peekLabelCatalogSource: () => gmailPeekLabels(),
  },
}));
const outlookListFolders = jest.fn();
const outlookPeekFolders = jest.fn();
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    listFolderCatalogSource: (...a: unknown[]) => outlookListFolders(...a),
    peekFolderCatalogSource: () => outlookPeekFolders(),
  },
}));

import { setDb } from "../db/core/dbConnection";
import { linkEmailToTransaction, resetExpansionWatermarksForTests } from "../autoLinkService";
import {
  getReviewState,
  queueFolderMatchesForTransaction,
  syncReviewQueueForTransaction,
} from "../reviewStateService";
import { __resetFullSweepGuardForTests } from "../autoLinkSweepGuard";
import { computeParticipantHash } from "../../utils/emailAddress";
import {
  __resetMailFolderCaptureForTests,
  CATALOG_REFRESH_MS,
  recordMailFoldersForFetchedEmails,
  refreshMailFolderCatalog,
} from "../mailFolderCaptureService";
import { replaceMailFolderCatalog } from "../db/mailFolderDb";
import { readAutoLinkInputToken, sameAutoLinkInputToken } from "../db/autoLinkInputTracker";
import * as Sentry from "@sentry/electron/main";
import { buildGmailCatalog, buildOutlookCatalog } from "../../utils/mailFolderCatalog";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");

const USER = "user-3926";
const USER_EMAIL = "agent@keepr.test";
const CONTACT = "contact-3926";
const CONTACT_EMAIL = "lender@example.test";
const STRANGER = "vendor@example.test";
const GMAIL_ACCT = "acct-gmail-3926";
const OUTLOOK_ACCT = "acct-outlook-3926";
const A = "txn-a-3926"; // "1428 Maple Ave, Springfield"
const B = "txn-b-3926"; // "100 Main St"
const IN_WINDOW = "2026-03-01T15:00:00.000Z";

/* ---------- provider responses (transcribed shapes, invented values) ---------- */

/** Gmail users.labels.list -> response.data.labels */
const GMAIL_LABELS = [
  { id: "INBOX", name: "INBOX", messageListVisibility: "hide", labelListVisibility: "labelShow", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
  { id: "Label_7", name: "Deals", messageListVisibility: "show", labelListVisibility: "labelShow", type: "user" },
  { id: "Label_12", name: "Deals/Maple Ave 1428", messageListVisibility: "show", labelListVisibility: "labelShow", type: "user" },
  { id: "Label_30", name: "Main St 100 old", type: "user" },
  { id: "Label_31", name: "Maple Ave", type: "user" }, // no number: never a match
];

/** Graph mailFolders walk -> value[] (top level + childFolders), flattened as discoverFolders returns it. */
const ROOT = "AAMkRoot==";
const OUTLOOK_FOLDERS = [
  { id: "AAMkInbox==", displayName: "Inbox", parentFolderId: ROOT, childFolderCount: 1 },
  { id: "AAMkSent==", displayName: "Sent Items", parentFolderId: ROOT, childFolderCount: 0 },
  // A well-known folder whose display name happens to read like the address: the
  // system flag (resolved by id), not the name, keeps it out.
  { id: "AAMkArchive==", displayName: "1428 Maple Ave", parentFolderId: ROOT, childFolderCount: 0 },
  { id: "AAMkMaple==", displayName: "1428 Maple", parentFolderId: "AAMkInbox==", childFolderCount: 1 },
  { id: "AAMkInspect==", displayName: "Inspection", parentFolderId: "AAMkMaple==", childFolderCount: 0 },
  { id: "AAMkOther==", displayName: "Receipts", parentFolderId: ROOT, childFolderCount: 0 },
];
/** $batch GET /me/mailFolders/{wellKnownName}?$select=id -> responses[].body.id (200s only). */
const OUTLOOK_SYSTEM_IDS = ["AAMkInbox==", "AAMkSent==", "AAMkArchive==", ROOT];

let db: DatabaseType;

function seedDeal(id: string, address: string, status = "not_submitted"): void {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
     VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', ?)`,
  ).run(id, USER, address, status);
  db.prepare(
    `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, 'buyer_agent')`,
  ).run(`tc-${id}`, id, CONTACT);
}

function insertEmail(
  id: string,
  externalId: string,
  source: "gmail" | "outlook",
  from: string,
  subject: string,
  body: string,
  sentAt = IN_WINDOW,
): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, account_id, sender, recipients, sent_at, subject, body_plain, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, USER, externalId, source, source === "gmail" ? GMAIL_ACCT : OUTLOOK_ACCT, from, USER_EMAIL, sentAt, subject, body, `th-${id}`);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'from', 0, ?, ?)`,
  ).run(id, computeParticipantHash(id, "from", 0, from), from);
  db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, 'to', 0, ?, ?)`,
  ).run(id, computeParticipantHash(id, "to", 0, USER_EMAIL), USER_EMAIL);
}

function seedBase(statusA = "not_submitted"): void {
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', 'o-1')`).run(USER, USER_EMAIL);
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address) VALUES (?, ?, 'google', 'mailbox', ?)`,
  ).run(GMAIL_ACCT, USER, USER_EMAIL);
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address) VALUES (?, ?, 'microsoft', 'mailbox', ?)`,
  ).run(OUTLOOK_ACCT, USER, USER_EMAIL);
  db.prepare(`INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, 'Lender')`).run(CONTACT, USER);
  db.prepare(`INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES ('ce-1', ?, ?, 1)`).run(CONTACT, CONTACT_EMAIL);
  seedDeal(A, "1428 Maple Ave, Springfield", statusA);
  seedDeal(B, "100 Main St");
}

/** Cached emails. None names the address in its subject/body unless stated. */
function seedCorpus(): void {
  insertEmail("e-ol-folder", "ol-1", "outlook", STRANGER, "Signed disclosures", "Four pages attached.");
  insertEmail("e-ol-nested", "ol-2", "outlook", STRANGER, "Inspection report", "See attached.");
  insertEmail("e-ol-archive", "ol-3", "outlook", STRANGER, "Newsletter", "Monthly update.");
  insertEmail("e-ol-other", "ol-4", "outlook", STRANGER, "Receipt", "Thanks.");
  insertEmail("e-gm-label", "gm-1", "gmail", STRANGER, "Re: Appraisal appointment", "Tuesday 9-11?");
  insertEmail("e-gm-parent", "gm-2", "gmail", STRANGER, "Pipeline", "Deals overview.");
  insertEmail("e-gm-nameonly", "gm-3", "gmail", STRANGER, "Street party", "Block party.");
  insertEmail("e-gm-unknown", "gm-4", "gmail", STRANGER, "Unknown label", "Nothing.");
  // Stranger naming the address AND filed in the folder: address pass + folder pass.
  insertEmail("e-both", "gm-5", "gmail", STRANGER, "Showing feedback for 1428 Maple Avenue", "Loved it.");
  // From the deal contact, naming nothing, filed in the label: contact route + folder.
  insertEmail("e-contact-folder", "gm-6", "gmail", CONTACT_EMAIL, "Quick question", "Call me.");
  // Filed in the label but outside the deal window.
  insertEmail("e-old", "gm-7", "gmail", STRANGER, "Old thread", "Last year.", "2025-06-01T00:00:00.000Z");
  // Filed in the label, rejected earlier by the user.
  insertEmail("e-rejected", "gm-8", "gmail", STRANGER, "Not this one", "Nope.");
}

/** The messages as the fetch services hand them to the store path. */
const FETCHED_OUTLOOK = [
  { id: "ol-1", parentFolderId: "AAMkMaple==", labels: [] },
  { id: "ol-2", parentFolderId: "AAMkInspect==", labels: ["Blue category"] },
  { id: "ol-3", parentFolderId: "AAMkArchive==" },
  { id: "ol-4", parentFolderId: "AAMkOther==" },
];
const FETCHED_GMAIL = [
  { id: "gm-1", labels: ["INBOX", "Label_12", "CATEGORY_UPDATES", "UNREAD"] },
  { id: "gm-2", labels: ["INBOX", "Label_7"] },
  { id: "gm-3", labels: ["Label_31"] },
  { id: "gm-4", labels: ["Label_999"] }, // id the label list does not contain
  { id: "gm-5", labels: ["INBOX", "Label_12"] },
  { id: "gm-6", labels: ["Label_12"] },
  { id: "gm-7", labels: ["Label_12"] },
  { id: "gm-8", labels: ["Label_12"] },
];

async function capture(): Promise<void> {
  await recordMailFoldersForFetchedEmails({ provider: "outlook", userId: USER, accountId: OUTLOOK_ACCT, emails: FETCHED_OUTLOOK });
  await recordMailFoldersForFetchedEmails({ provider: "gmail", userId: USER, accountId: GMAIL_ACCT, emails: FETCHED_GMAIL });
}

function pending(txn: string): string[] {
  return (
    db
      .prepare(
        `SELECT p.email_id || ':' || COALESCE(r.reason, '-') AS k
           FROM pending_review_communications p
           LEFT JOIN pending_review_match_reasons r
             ON r.transaction_id = p.transaction_id AND r.email_id = p.email_id
          WHERE p.transaction_id = ? AND p.email_id IS NOT NULL
          ORDER BY k`,
      )
      .all(txn) as Array<{ k: string }>
  ).map((r) => r.k);
}

beforeEach(() => {
  resetExpansionWatermarksForTests();
  __resetFullSweepGuardForTests();
  __resetMailFolderCaptureForTests();
  logCalls.length = 0;
  gmailListLabels.mockReset().mockResolvedValue(GMAIL_LABELS);
  outlookListFolders.mockReset().mockResolvedValue({ folders: OUTLOOK_FOLDERS, systemFolderIds: OUTLOOK_SYSTEM_IDS });
  gmailPeekLabels.mockReset().mockReturnValue(null);
  outlookPeekFolders.mockReset().mockReturnValue(null);
  db = new Database(":memory:") as DatabaseType;
  setDb(db);
});

afterEach(() => {
  db.close();
});

describe("catalogue: system detection, nested paths, label names", () => {
  it("Gmail: system labels (incl. CATEGORY_*) are flagged and never matchable; nested names keep their path", () => {
    const cat = buildGmailCatalog(GMAIL_LABELS);
    const byId = new Map(cat.map((e) => [e.folderId, e]));
    expect(byId.get("INBOX")).toMatchObject({ isSystem: true, segments: [] });
    expect(byId.get("CATEGORY_UPDATES")).toMatchObject({ isSystem: true, segments: [] });
    expect(byId.get("Label_12")).toEqual({
      folderId: "Label_12",
      displayPath: "Deals/Maple Ave 1428",
      segments: ["Deals", "Maple Ave 1428"],
      isSystem: false,
    });
  });

  it("Outlook: path from the parentFolderId chain; system folders flagged by id and left out of segments", () => {
    const cat = buildOutlookCatalog(OUTLOOK_FOLDERS, new Set(OUTLOOK_SYSTEM_IDS));
    const byId = new Map(cat.map((e) => [e.folderId, e]));
    expect(byId.get("AAMkMaple==")).toEqual({
      folderId: "AAMkMaple==",
      displayPath: "Inbox / 1428 Maple",
      segments: ["1428 Maple"],
      isSystem: false,
    });
    expect(byId.get("AAMkInspect==")).toEqual({
      folderId: "AAMkInspect==",
      displayPath: "Inbox / 1428 Maple / Inspection",
      segments: ["1428 Maple", "Inspection"],
      isSystem: false,
    });
    expect(byId.get("AAMkArchive==")).toMatchObject({ isSystem: true, segments: [] });
  });
});

describe("capture: refs for every fetched message, names per account", () => {
  it("stores Outlook parentFolderId and Gmail user label ids only; catalogue for both accounts", async () => {
    seedBase();
    await capture();
    const refs = (
      db.prepare(`SELECT account_id || '|' || external_id || '|' || folder_id AS k FROM mail_folder_refs ORDER BY k`).all() as Array<{ k: string }>
    ).map((r) => r.k);
    expect(refs).toEqual([
      `${GMAIL_ACCT}|gm-1|Label_12`,
      `${GMAIL_ACCT}|gm-2|Label_7`,
      `${GMAIL_ACCT}|gm-3|Label_31`,
      `${GMAIL_ACCT}|gm-4|Label_999`,
      `${GMAIL_ACCT}|gm-5|Label_12`,
      `${GMAIL_ACCT}|gm-6|Label_12`,
      `${GMAIL_ACCT}|gm-7|Label_12`,
      `${GMAIL_ACCT}|gm-8|Label_12`,
      `${OUTLOOK_ACCT}|ol-1|AAMkMaple==`,
      `${OUTLOOK_ACCT}|ol-2|AAMkInspect==`,
      `${OUTLOOK_ACCT}|ol-3|AAMkArchive==`,
      `${OUTLOOK_ACCT}|ol-4|AAMkOther==`,
    ]);
    const names = db.prepare(`SELECT COUNT(*) AS n FROM mail_folder_names`).get() as { n: number };
    expect(names.n).toBe(GMAIL_LABELS.length + OUTLOOK_FOLDERS.length);
  });

  it("a re-fetch replaces a message's set (moved out of the folder -> no row)", async () => {
    seedBase();
    await capture();
    await recordMailFoldersForFetchedEmails({
      provider: "outlook",
      userId: USER,
      accountId: OUTLOOK_ACCT,
      emails: [{ id: "ol-1", parentFolderId: "AAMkOther==" }],
    });
    const rows = db.prepare(`SELECT folder_id FROM mail_folder_refs WHERE external_id = 'ol-1'`).all();
    expect(rows).toEqual([{ folder_id: "AAMkOther==" }]);
  });

  it("logs no folder or label name", async () => {
    seedBase();
    await capture();
    const text = JSON.stringify(logCalls);
    for (const n of ["Maple", "Deals", "Receipts", "Inspection"]) expect(text).not.toContain(n);
  });
});

/** Every user-created folder / label name seeded above (system ones are not user data). */
const SEEDED_NAMES = ["Deals", "Maple Ave 1428", "Main St 100 old", "Maple Ave", "1428 Maple", "Inspection", "Receipts"];

describe("privacy: no folder or label name leaves the app (BACKLOG-3926 R1)", () => {
  it("after capture, the full sweep on both deals and getReviewState, no log line or Sentry call carries a seeded name", async () => {
    seedBase();
    seedCorpus();
    await capture();
    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });
    await syncReviewQueueForTransaction({ transactionId: B, reason: "open" });
    await queueFolderMatchesForTransaction(A);
    // Guard the guard: the discovery pass really ran and logged.
    expect(JSON.stringify(logCalls)).toContain("folder / label discovery");
    expect(getReviewState(A).items.some((i) => i.matchReason === "folder")).toBe(true);
    getReviewState(B);

    const seen = JSON.stringify([
      logCalls,
      (Sentry.addBreadcrumb as jest.Mock).mock.calls,
      (Sentry.captureException as jest.Mock).mock.calls,
      (Sentry.captureMessage as jest.Mock).mock.calls,
    ]);
    for (const n of SEEDED_NAMES) expect(seen).not.toContain(n);
  });
});

describe("catalogue is written only when it changes (BACKLOG-3926 R2)", () => {
  const entries = () => buildGmailCatalog(GMAIL_LABELS);

  it("an identical catalogue returns false and leaves the auto-link input token unchanged", () => {
    seedBase();
    expect(replaceMailFolderCatalog(USER, GMAIL_ACCT, "gmail", entries())).toBe(true);
    const before = readAutoLinkInputToken(db);
    expect(before).not.toBeNull();
    expect(replaceMailFolderCatalog(USER, GMAIL_ACCT, "gmail", entries())).toBe(false);
    expect(sameAutoLinkInputToken(before, readAutoLinkInputToken(db))).toBe(true);
  });

  it("a real change still writes and moves the token (the control is not vacuous)", () => {
    seedBase();
    replaceMailFolderCatalog(USER, GMAIL_ACCT, "gmail", entries());
    const before = readAutoLinkInputToken(db);
    const renamed = entries().map((e) => (e.folderId === "Label_31" ? { ...e, displayPath: "Maple Ave 2" } : e));
    expect(replaceMailFolderCatalog(USER, GMAIL_ACCT, "gmail", renamed)).toBe(true);
    expect(sameAutoLinkInputToken(before, readAutoLinkInputToken(db))).toBe(false);
  });

  it("a re-refresh after the throttle with an unchanged listing does not move the token", async () => {
    seedBase();
    const t0 = Date.now();
    await refreshMailFolderCatalog("gmail", USER, GMAIL_ACCT, t0);
    const before = readAutoLinkInputToken(db);
    await refreshMailFolderCatalog("gmail", USER, GMAIL_ACCT, t0 + CATALOG_REFRESH_MS + 1);
    expect(gmailListLabels).toHaveBeenCalledTimes(2);
    expect(sameAutoLinkInputToken(before, readAutoLinkInputToken(db))).toBe(true);
  });
});

describe("the catalogue throttle yields to a force re-cache and to a changed walk (BACKLOG-3926 fix round)", () => {
  // A folder created after the catalogue refreshed: same Graph shape as OUTLOOK_FOLDERS.
  const NEW_FOLDER = { id: "AAMkNewDeal==", displayName: "100 Main St", parentFolderId: "AAMkInbox==", childFolderCount: 0 };
  const WALK_AFTER = [...OUTLOOK_FOLDERS, NEW_FOLDER];
  const ids = () =>
    (db.prepare(`SELECT folder_id FROM mail_folder_names WHERE account_id = ? ORDER BY folder_id`).all(OUTLOOK_ACCT) as Array<{
      folder_id: string;
    }>).map((r) => r.folder_id);

  it("force re-cache within the throttle writes a folder created after the last refresh, from a walk made now", async () => {
    seedBase();
    const t0 = Date.now();
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0);
    expect(ids()).not.toContain(NEW_FOLDER.id);
    outlookListFolders.mockResolvedValue({ folders: WALK_AFTER, systemFolderIds: OUTLOOK_SYSTEM_IDS });
    const run = {};
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0 + 60_000, { forceRun: run });
    expect(ids()).toContain(NEW_FOLDER.id);
    expect(outlookListFolders).toHaveBeenCalledTimes(2);
    expect(outlookListFolders).toHaveBeenLastCalledWith(0);
    // Later batches of the same run are throttled again (walk unchanged).
    outlookPeekFolders.mockReturnValue(WALK_AFTER);
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0 + 90_000, { forceRun: run });
    expect(outlookListFolders).toHaveBeenCalledTimes(2);
  });

  it("a non-force fetch whose fresh walk differs refreshes within the throttle", async () => {
    seedBase();
    const t0 = Date.now();
    outlookPeekFolders.mockReturnValue(OUTLOOK_FOLDERS);
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0);
    outlookPeekFolders.mockReturnValue(WALK_AFTER);
    outlookListFolders.mockResolvedValue({ folders: WALK_AFTER, systemFolderIds: OUTLOOK_SYSTEM_IDS });
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0 + 60_000);
    expect(ids()).toContain(NEW_FOLDER.id);
    expect(outlookListFolders).toHaveBeenCalledTimes(2);
  });

  it("an unchanged walk within the throttle is not re-listed and writes nothing", async () => {
    seedBase();
    const t0 = Date.now();
    outlookPeekFolders.mockReturnValue(OUTLOOK_FOLDERS);
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0);
    const before = readAutoLinkInputToken(db);
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0 + 60_000);
    expect(outlookListFolders).toHaveBeenCalledTimes(1);
    expect(sameAutoLinkInputToken(before, readAutoLinkInputToken(db))).toBe(true);
  });

  it("Gmail: a label added after the last refresh is written when the fresh label list differs", async () => {
    seedBase();
    const t0 = Date.now();
    gmailPeekLabels.mockReturnValue(GMAIL_LABELS);
    await refreshMailFolderCatalog("gmail", USER, GMAIL_ACCT, t0);
    const after = [...GMAIL_LABELS, { id: "Label_40", name: "100 Main St", type: "user" }];
    gmailPeekLabels.mockReturnValue(after);
    gmailListLabels.mockResolvedValue(after);
    await refreshMailFolderCatalog("gmail", USER, GMAIL_ACCT, t0 + 60_000);
    const gm = (db.prepare(`SELECT folder_id FROM mail_folder_names WHERE account_id = ?`).all(GMAIL_ACCT) as Array<{
      folder_id: string;
    }>).map((r) => r.folder_id);
    expect(gm).toContain("Label_40");
  });
});

describe("an empty listing never replaces the stored catalogue (BACKLOG-3926 R3)", () => {
  const rows = (acct: string) =>
    db.prepare(`SELECT folder_id, display_path FROM mail_folder_names WHERE account_id = ? ORDER BY folder_id`).all(acct);

  it("Gmail: an empty label list leaves the stored rows intact", async () => {
    seedBase();
    const t0 = Date.now();
    await refreshMailFolderCatalog("gmail", USER, GMAIL_ACCT, t0);
    const stored = rows(GMAIL_ACCT);
    expect(stored.length).toBe(GMAIL_LABELS.length);
    gmailListLabels.mockResolvedValue([]);
    await refreshMailFolderCatalog("gmail", USER, GMAIL_ACCT, t0 + CATALOG_REFRESH_MS + 1);
    expect(gmailListLabels).toHaveBeenCalledTimes(2);
    expect(rows(GMAIL_ACCT)).toEqual(stored);
  });

  it("Outlook: an empty folder walk leaves the stored rows intact", async () => {
    seedBase();
    const t0 = Date.now();
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0);
    const stored = rows(OUTLOOK_ACCT);
    expect(stored.length).toBe(OUTLOOK_FOLDERS.length);
    outlookListFolders.mockResolvedValue({ folders: [], systemFolderIds: [] });
    await refreshMailFolderCatalog("outlook", USER, OUTLOOK_ACCT, t0 + CATALOG_REFRESH_MS + 1);
    expect(outlookListFolders).toHaveBeenCalledTimes(2);
    expect(rows(OUTLOOK_ACCT)).toEqual(stored);
  });
});

describe("match: folder / label named after the deal address", () => {
  it("queues exactly the folder / label matches for A, with reason folder, and their title-row text", async () => {
    seedBase();
    seedCorpus();
    await capture();
    db.prepare(
      `INSERT INTO ignored_communications (id, user_id, transaction_id, email_id, reason) VALUES ('ic-1', ?, ?, 'e-rejected', 'user_rejected')`,
    ).run(USER, A);

    const r = await queueFolderMatchesForTransaction(A);

    expect(pending(A)).toEqual([
      "e-both:folder",
      "e-contact-folder:folder",
      "e-gm-label:folder",
      "e-ol-folder:folder",
      "e-ol-nested:folder",
    ]);
    // Folders that matched: Label_12, AAMkMaple==, AAMkInspect== (nested under it).
    expect(r).toEqual({ queued: 5, folders: 3, candidates: 5 });
    // B ("100 Main St"): "Main St 100 old" names it.
    expect(pending(B)).toEqual([]);

    const state = getReviewState(A);
    const labels = Object.fromEntries(state.items.map((i) => [i.email_id, i.matchFolder ?? null]));
    expect(labels).toEqual({
      "e-both": "Gmail label: Deals/Maple Ave 1428",
      "e-contact-folder": "Gmail label: Deals/Maple Ave 1428",
      "e-gm-label": "Gmail label: Deals/Maple Ave 1428",
      "e-ol-folder": "Outlook folder: Inbox / 1428 Maple",
      "e-ol-nested": "Outlook folder: Inbox / 1428 Maple / Inspection",
    });
  });

  it("a system folder named like the address is never a match", async () => {
    seedBase();
    seedCorpus();
    await capture();
    await queueFolderMatchesForTransaction(A);
    expect(pending(A)).not.toContain("e-ol-archive:folder");
    expect(pending(A).some((k) => k.startsWith("e-ol-archive"))).toBe(false);
  });

  it("a label id the label list cannot resolve, or a label naming only the street, is not a match", async () => {
    seedBase();
    seedCorpus();
    await capture();
    await queueFolderMatchesForTransaction(A);
    const ids = pending(A).map((k) => k.split(":")[0]);
    expect(ids).not.toContain("e-gm-unknown");
    expect(ids).not.toContain("e-gm-nameonly");
    expect(ids).not.toContain("e-gm-parent");
  });

  it("no catalogue match -> nothing read, nothing queued", async () => {
    seedBase();
    seedCorpus();
    await capture();
    db.prepare(`UPDATE transactions SET property_address = '77 Nowhere Rd' WHERE id = ?`).run(A);
    expect(await queueFolderMatchesForTransaction(A)).toEqual({ queued: 0, folders: 0, candidates: 0 });
  });

  it("already linked is not queued", async () => {
    seedBase();
    seedCorpus();
    await capture();
    await linkEmailToTransaction("e-gm-label", A, "manual", 0.95, "user_confirmed");
    await queueFolderMatchesForTransaction(A);
    expect(pending(A).map((k) => k.split(":")[0])).not.toContain("e-gm-label");
  });
});

describe("precedence folder > address > contact", () => {
  it("full sweep: an email that is an address match AND in the folder shows folder; a contact-route email in the folder shows folder", async () => {
    seedBase();
    seedCorpus();
    await capture();

    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });

    const p = pending(A);
    expect(p).toContain("e-both:folder");
    expect(p).toContain("e-contact-folder:folder");
  });

  it("deal already swept, THEN folder ids arrive on a later fetch (no new email rows): the next open queues them", async () => {
    seedBase();
    seedCorpus();
    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });
    expect(pending(A).filter((k) => k.endsWith(":folder"))).toEqual([]);
    expect(pending(A)).toContain("e-both:address");

    await capture(); // writes refs + names only; the emails table is untouched

    await syncReviewQueueForTransaction({ transactionId: A, reason: "open" });
    const p = pending(A);
    expect(p).toContain("e-both:folder");
    expect(p).toContain("e-ol-folder:folder");
    expect(p).toContain("e-contact-folder:folder");
  });

  it("an existing address row is upgraded to folder (not double-queued)", async () => {
    seedBase();
    seedCorpus();
    const { queueEmailForReview } = await import("../reviewStateService");
    expect(await queueEmailForReview(A, "e-both", USER, "address")).toBe(true);
    await capture();
    const r = await queueFolderMatchesForTransaction(A);
    expect(pending(A)).toContain("e-both:folder");
    // 6 candidates here (no rejection seeded, so e-rejected counts); e-both already existed.
    expect(r).toEqual({ queued: 5, folders: 3, candidates: 6 });
  });
});

describe("locked deals", () => {
  it.each(["submitted", "under_review", "resubmitted", "approved"])("a %s deal: skipped before any read", async (status) => {
    seedBase(status);
    seedCorpus();
    await capture();
    expect(await queueFolderMatchesForTransaction(A)).toEqual({ queued: 0, folders: 0, candidates: 0, skipped: "locked" });
    expect(pending(A)).toEqual([]);
  });
});

describe("the candidate read runs on the dedicated query worker", () => {
  afterEach(() => jest.restoreAllMocks());

  it("pool up: the worker gets the pass's params; the main connection never prepares the statement", async () => {
    seedBase();
    seedCorpus();
    await capture();
    // What the worker would return, computed on the same statement here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../workers/contactWorkerPool") as typeof import("../../workers/contactWorkerPool");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cand = require("../db/folderMatchCandidatesDb") as typeof import("../db/folderMatchCandidatesDb");
    let seenParams: unknown[] | null = null;
    jest.spyOn(pool, "isPoolReady").mockReturnValue(true);
    const query = jest.spyOn(pool, "queryOnDedicatedWorker").mockImplementation((async (
      type: string,
      _user: string,
      _t: number,
      extras: { params: unknown[] },
    ) => {
      expect(type).toBe("folderMatchCandidates");
      seenParams = extras.params;
      return cand.readFolderMatchCandidatesOn(db, extras.params);
    }) as unknown as typeof pool.queryOnDedicatedWorker);
    const texts: string[] = [];
    const real = db.prepare.bind(db);
    jest.spyOn(db, "prepare").mockImplementation(((t: string) => {
      texts.push(String(t));
      return real(t);
    }) as typeof db.prepare);

    const r = await queueFolderMatchesForTransaction(A);

    expect(query).toHaveBeenCalledTimes(1);
    expect(seenParams).toHaveLength(cand.FOLDER_MATCH_CANDIDATE_PARAM_COUNT);
    // Only the worker (here: the spy, outside the main read path) ran the candidate statement.
    expect(texts.filter((t) => t === String(cand.FOLDER_MATCH_CANDIDATE_EMAILS_SQL))).toHaveLength(1);
    expect(r.queued).toBe(6);
  });

  it("worker could not start: the main thread reads, same result", async () => {
    seedBase();
    seedCorpus();
    await capture();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../workers/contactWorkerPool") as typeof import("../../workers/contactWorkerPool");
    jest.spyOn(pool, "isPoolReady").mockReturnValue(true);
    jest.spyOn(pool, "queryOnDedicatedWorker").mockRejectedValue(new pool.DedicatedWorkerError("x", "start_failed"));
    expect(await queueFolderMatchesForTransaction(A)).toEqual({ queued: 6, folders: 3, candidates: 6 });
  });

  it("any other worker failure fails the pass (the sweep retries)", async () => {
    seedBase();
    seedCorpus();
    await capture();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pool = require("../../workers/contactWorkerPool") as typeof import("../../workers/contactWorkerPool");
    jest.spyOn(pool, "isPoolReady").mockReturnValue(true);
    jest.spyOn(pool, "queryOnDedicatedWorker").mockRejectedValue(new pool.DedicatedWorkerError("x", "timeout"));
    await expect(queueFolderMatchesForTransaction(A)).rejects.toThrow();
  });
});
