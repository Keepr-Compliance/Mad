/**
 * @jest-environment node
 *
 * BACKLOG-3475 / BACKLOG-3910a — A FORCE RE-CACHE KEEPS AN EMAIL THAT IS ON
 * A CHECKLIST, AND THE CHECKLIST KEEPS ITS LINK.
 *
 * ===========================================================================
 * THE RULE CHANGED
 * ===========================================================================
 * 3475 shipped under the 2026-08-24 parity ruling: a force re-cache removed
 * checklist links exactly as it removed transaction links. The founder
 * reversed that on 2026-10-11 (BACKLOG-3910a): an email tied to a deal — by a
 * checklist member on the email OR on one of its attachments — is never
 * removed. It is refreshed in place (same id), so no ON DELETE CASCADE fires
 * and the AFTER DELETE group trigger never runs.
 *
 * Runs the REAL `precacheEmails(..., { force: true })` against the REAL
 * `schema.sql` on the REAL driver and compares exact id SETS.
 *
 * The cascade and trigger themselves are still pinned by the second test
 * (deleting the transaction / a group), which is the path that still uses them.
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
  getRawDatabase: () => db,
}));
const mockGetOAuthToken = jest.fn();
jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getOAuthToken: (...a: unknown[]) => mockGetOAuthToken(...a),
    upsertEmailAttachmentMetadata: jest.fn(),
  },
}));
const mockOutlookSearch = jest.fn();
jest.mock("../outlookFetchService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn().mockResolvedValue(true),
    searchEmails: (...a: unknown[]) => mockOutlookSearch(...a),
    searchAllFolders: jest.fn().mockResolvedValue([]),
    getAttachments: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../gmailFetchService", () => ({
  __esModule: true,
  default: {
    initialize: jest.fn().mockResolvedValue(false),
    searchEmails: jest.fn().mockResolvedValue([]),
    searchAllLabels: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock("../networkResilience", () => ({
  retryOnNetwork: (fn: () => Promise<unknown>) => fn(),
  networkResilienceService: {},
}));
jest.mock("../../utils/preferenceHelper", () => ({
  getEmailCacheDurationMonths: jest.fn().mockResolvedValue(12),
  computeEmailCacheSinceDate: jest.fn(() => new Date("2026-01-01T00:00:00Z")),
}));
jest.mock("../emailDerivationReprocessService", () => ({
  reprocessEmailDerivations: jest
    .fn()
    .mockResolvedValue({ scanned: 0, rewritten: 0, unchanged: 0, batches: 0 }),
}));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import emailSyncService from "../emailSyncService";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const USER = "user-force";

function providerEmail(n: number) {
  return {
    id: `ext-${n}`,
    subject: `Subject ${n}`,
    from: `sender${n}@example.com`,
    to: "me@example.com",
    cc: null,
    bcc: null,
    body: `<p>m${n}</p>`,
    bodyPlain: `m${n}`,
    date: new Date(`2026-03-0${n}T10:00:00Z`),
    threadId: `thread-${n}`,
    messageIdHeader: `<msg-${n}@example.com>`,
    hasAttachments: false,
    attachments: [],
    participants: [
      { role: "from", position: 0, email_address: `sender${n}@example.com`, display_name: null },
    ],
  };
}

function seedEmail(id: string, externalId: string, sentAt: string): void {
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, body_plain, sender, recipients, sent_at, received_at, message_id_header)
     VALUES (?, ?, ?, 'outlook', 'acct-outlook', ?, 'b', 's@example.com', 'me@example.com', ?, ?, ?)`,
  ).run(id, USER, externalId, `Seeded ${id}`, sentAt, sentAt, `<seed-${id}@example.com>`);
}

const rows = (q: string) => db.prepare(q).all() as Array<Record<string, unknown>>;
/** Exact `group:target` pairs that survive. */
const memberSet = () =>
  rows(
    `SELECT link_id || ':' || COALESCE(email_id, attachment_id) AS k FROM transaction_checklist_link_members ORDER BY k`,
  ).map((r) => r.k);
const linkSet = () => rows(`SELECT id FROM transaction_checklist_links ORDER BY id`).map((r) => r.id);
/** Members pointing at an email or attachment that no longer exists. */
const dangling = () =>
  (
    db.prepare(
      `SELECT COUNT(*) AS n FROM transaction_checklist_link_members m
        WHERE (m.email_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.id = m.email_id))
           OR (m.attachment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.id = m.attachment_id))`,
    ).get() as { n: number }
  ).n;

beforeEach(() => {
  db = new Database(":memory:") as unknown as DatabaseType;
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'me@example.com', 'microsoft', 'oid-1')`,
  ).run(USER);
  db.prepare(
    `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address) VALUES ('acct-outlook', ?, 'microsoft', 'mailbox', 'me@example.com')`,
  ).run(USER);
  mockGetOAuthToken.mockImplementation(async (_u: string, provider: string) =>
    provider === "microsoft"
      ? { id: "acct-outlook", access_token: "at", connected_email_address: "me@example.com" }
      : null,
  );
  // live-1 is in the force set (outlook, inside the 2026-01-01 window);
  // keep-1 is not (sent before the window), so it must survive untouched.
  seedEmail("live-1", "ext-1", "2026-03-01T10:00:00Z");
  seedEmail("keep-1", "ext-keep", "2025-06-01T10:00:00Z");
  db.prepare(`INSERT INTO transactions (id, user_id, property_address) VALUES ('txn-1', ?, '1 Main St')`).run(
    USER,
  );
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source) VALUES ('comm-1', ?, 'txn-1', 'live-1', 'manual'), ('comm-2', ?, 'txn-1', 'keep-1', 'manual')`,
  ).run(USER, USER);
  db.prepare(
    `INSERT INTO attachments (id, email_id, filename) VALUES ('att-1', 'live-1', 'offer.pdf'), ('att-keep', 'keep-1', 'keep.pdf')`,
  ).run();
  db.prepare(
    `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES ('c1', 'txn-1', 'tpl', 'Residential')`,
  ).run();
  db.prepare(
    `INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES ('i1', 'c1', 'Signed offer', 1)`,
  ).run();
  // L-mixed  two emails, one replaced by the force set and one outside it
  // L-gone   one email, entirely inside the force set -> group must disappear
  // L-att    an attachment of a replaced email
  // L-att-keep an attachment of a surviving email
  db.prepare(`INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES
      ('L-mixed', 'i1', 'email', 'thread'), ('L-gone', 'i1', 'email', 'single'),
      ('L-att', 'i1', 'attachment', 'offer.pdf'), ('L-att-keep', 'i1', 'attachment', 'keep.pdf')`).run();
  db.prepare(`INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id, attachment_id) VALUES
      ('m1', 'L-mixed', 'email', 'live-1', NULL), ('m2', 'L-mixed', 'email', 'keep-1', NULL),
      ('m3', 'L-gone', 'email', 'live-1', NULL),
      ('m4', 'L-att', 'attachment', NULL, 'att-1'), ('m5', 'L-att-keep', 'attachment', NULL, 'att-keep')`).run();
  // BACKLOG-3476 (F-2, regression cover): a SECOND checklist on the same
  // transaction. Its links die with the replaced email exactly like the
  // first's — there is no per-checklist code path; the cascade is per row.
  db.prepare(
    `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name, sort_order) VALUES ('c2', 'txn-1', 'tpl-2', 'Disclosures', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO transaction_checklist_items (id, checklist_id, title, is_required) VALUES ('i2', 'c2', 'Disclosure signed', 1)`,
  ).run();
  db.prepare(`INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES
      ('L-c2-gone', 'i2', 'email', 'single'), ('L-c2-keep', 'i2', 'email', 'kept')`).run();
  db.prepare(`INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id, attachment_id) VALUES
      ('m6', 'L-c2-gone', 'email', 'live-1', NULL), ('m7', 'L-c2-keep', 'email', 'keep-1', NULL)`).run();
});

afterEach(() => db.close());

describe("BACKLOG-3910a — email Force Re-cache keeps checklist members, their emails and attachments", () => {
  /**
   * MUTATION: drop the email-kind member arm from the keep-set -> L-gone loses
   * its member and the trigger drops the group, red. Drop the attachment-kind
   * arm -> nothing changes HERE (live-1 is also linked) — C11 below is the
   * control for that arm.
   */
  it("every member, group and attachment survives; the replaced email keeps its id; nothing dangles", async () => {
    const membersBefore = memberSet();
    const linksBefore = linkSet();
    mockOutlookSearch.mockResolvedValue([providerEmail(1)]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.error ?? null).toBeNull();
    expect(result.forceSwap).toBeDefined();
    // live-1 was refreshed in place (same id, fresh body), not replaced.
    expect(rows(`SELECT id, body_plain FROM emails ORDER BY id`)).toEqual([
      { id: "keep-1", body_plain: "b" },
      { id: "live-1", body_plain: "m1" },
    ]);
    expect(memberSet()).toEqual(membersBefore);
    expect(linkSet()).toEqual(linksBefore);
    expect(rows(`SELECT id, email_id FROM attachments ORDER BY id`)).toEqual([
      { id: "att-1", email_id: "live-1" },
      { id: "att-keep", email_id: "keep-1" },
    ]);
    expect(dangling()).toBe(0);
    expect(rows("SELECT id FROM transaction_checklist_items ORDER BY id")).toEqual([{ id: "i1" }, { id: "i2" }]);
  });

  /**
   * C11 — an email whose ONLY tie is an attachment on a checklist item is kept,
   * the member id is unchanged and the trigger does not drop the group.
   *
   * MUTATION: drop the attachment-kind arm from the keep-set -> att-only is
   * removed, att-only-1 cascades away, the group L-only goes with it, red.
   */
  it("C11: an email tied only by a checklist attachment is kept with its member and group", async () => {
    seedEmail("att-only", "ext-2", "2026-03-02T10:00:00Z");
    seedEmail("untied", "ext-3", "2026-03-03T10:00:00Z");
    db.prepare(`INSERT INTO attachments (id, email_id, filename) VALUES ('att-only-1', 'att-only', 'deed.pdf')`).run();
    db.prepare(
      `INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES ('L-only', 'i1', 'attachment', 'deed.pdf')`,
    ).run();
    db.prepare(
      `INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES ('m-only', 'L-only', 'attachment', 'att-only-1')`,
    ).run();
    mockOutlookSearch.mockResolvedValue([providerEmail(1), providerEmail(2), providerEmail(3)]);

    const result = await emailSyncService.precacheEmails(USER, undefined, { force: true });

    expect(result.error ?? null).toBeNull();
    const ids = rows(`SELECT id FROM emails ORDER BY id`).map((r) => r.id);
    expect(ids).toContain("att-only");
    expect(ids).not.toContain("untied");
    expect(rows(`SELECT id, link_id FROM transaction_checklist_link_members WHERE id = 'm-only'`)).toEqual([
      { id: "m-only", link_id: "L-only" },
    ]);
    expect(linkSet()).toContain("L-only");
    expect(dangling()).toBe(0);
  });

  it("removing a group, and deleting the transaction, still work with the trigger present", () => {
    db.prepare(`DELETE FROM transaction_checklist_links WHERE id = 'L-gone'`).run();
    // Four groups on the first checklist and two on the second (BACKLOG-3476).
    expect(`${linkSet().length}/${memberSet().length}`).toBe("5/6");

    db.prepare(`DELETE FROM transactions WHERE id = 'txn-1'`).run();
    const counts = [
      "transaction_checklists",
      "transaction_checklist_items",
      "transaction_checklist_links",
      "transaction_checklist_link_members",
    ]
      .map((t) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)
      .join(",");
    expect(counts).toBe("0,0,0,0");
  });
});
