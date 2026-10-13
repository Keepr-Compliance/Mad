/**
 * Pins for `db/emailForceSetSql` — BACKLOG-2989 commit A2, rewritten for
 * BACKLOG-3910a.
 *
 * The rule under test (founder 2026-10-11): a Force Re-cache replaces EVERY
 * email of the user — any account, provider, age, provider id or sent date —
 * except emails tied to a deal by one of four links. Asserted by EXECUTION on
 * the real driver against the whole `schema.sql`, comparing id SETS.
 *
 * The NULL case (C16) is the one to read first: `id NOT IN (list holding a
 * NULL)` is NULL for every row, so a keep-list written that way removes
 * nothing while the run reports success.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  deleteLiveForceSet,
  emailForceReadView,
  selectProtectedLiveEmails,
  type EmailForceSet,
} from "../emailForceSetSql";
import { STAGING_PREFIX, checkedStagingTable } from "../stagingDdlSql";
import { sql } from "../core/sqlText";
import { LOCKED_SUBMISSION_STATUSES } from "../../transactionEligibility";

const SCHEMA = path.join(__dirname, "..", "..", "..", "database", "schema.sql");
const USER = "user-2989-force";
const OTHER = "user-2989-force-other";

const SET: EmailForceSet = { userId: USER };

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

const addUser = (id: string): void => {
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)`,
  ).run(id, `${id}@example.test`, `oauth-${id}`);
};

const addEmail = (
  id: string,
  opts: {
    userId?: string;
    source?: string | null;
    externalId?: string | null;
    sentAt?: string | null;
    accountId?: string | null;
  } = {},
): void => {
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, sent_at, subject, account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.userId ?? USER,
    opts.externalId === undefined ? `ext-${id}` : opts.externalId,
    opts.source === undefined ? "gmail" : opts.source,
    opts.sentAt === undefined ? "2026-06-01T00:00:00Z" : opts.sentAt,
    `subject ${id}`,
    opts.accountId ?? null,
  );
};

const addDeal = (id: string, status = "not_submitted"): void => {
  db.prepare(
    `INSERT INTO transactions (id, user_id, property_address, submission_status) VALUES (?, ?, ?, ?)`,
  ).run(id, USER, `${id} Main St`, status);
};
const linkEmail = (commId: string, dealId: string, emailId: string): void => {
  db.prepare(
    `INSERT INTO communications (id, user_id, transaction_id, email_id, link_source) VALUES (?, ?, ?, ?, 'manual')`,
  ).run(commId, USER, dealId, emailId);
};
const rejectEmail = (id: string, dealId: string, emailId: string): void => {
  db.prepare(
    `INSERT INTO ignored_communications (id, user_id, transaction_id, email_id) VALUES (?, ?, ?, ?)`,
  ).run(id, USER, dealId, emailId);
};
/** A checklist on `dealId` with one item; returns the item id. */
const addChecklist = (dealId: string): string => {
  db.prepare(
    `INSERT INTO transaction_checklists (id, transaction_id, template_id, template_name) VALUES (?, ?, 'tpl', 'Residential')`,
  ).run(`ck-${dealId}`, dealId);
  db.prepare(
    `INSERT INTO transaction_checklist_items (id, checklist_id, title) VALUES (?, ?, 'Signed offer')`,
  ).run(`it-${dealId}`, `ck-${dealId}`);
  return `it-${dealId}`;
};
const addEmailMember = (linkId: string, itemId: string, emailId: string): void => {
  db.prepare(
    `INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES (?, ?, 'email', 'e')`,
  ).run(linkId, itemId);
  db.prepare(
    `INSERT INTO transaction_checklist_link_members (id, link_id, kind, email_id) VALUES (?, ?, 'email', ?)`,
  ).run(`m-${linkId}`, linkId, emailId);
};
const addAttachmentMember = (
  linkId: string,
  itemId: string,
  attachmentId: string,
  owner: { emailId: string } | { messageId: string },
): void => {
  db.prepare(
    `INSERT INTO attachments (id, email_id, message_id, filename) VALUES (?, ?, ?, 'offer.pdf')`,
  ).run(
    attachmentId,
    "emailId" in owner ? owner.emailId : null,
    "messageId" in owner ? owner.messageId : null,
  );
  db.prepare(
    `INSERT INTO transaction_checklist_links (id, item_id, kind, label) VALUES (?, ?, 'attachment', 'a')`,
  ).run(linkId, itemId);
  db.prepare(
    `INSERT INTO transaction_checklist_link_members (id, link_id, kind, attachment_id) VALUES (?, ?, 'attachment', ?)`,
  ).run(`m-${linkId}`, linkId, attachmentId);
};

const liveIds = (userId?: string): string[] =>
  (
    (userId
      ? db.prepare("SELECT id FROM emails WHERE user_id = ? ORDER BY id").all(userId)
      : db.prepare("SELECT id FROM emails ORDER BY id").all()) as Array<{ id: string }>
  ).map((r) => r.id);

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-force-"));
  db = new RealDatabase(path.join(tmpRoot, "mad.db"));
  db.exec(fs.readFileSync(SCHEMA, "utf8"));
  db.pragma("foreign_keys = ON");
  addUser(USER);
  addUser(OTHER);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("deleteLiveForceSet — every UNPROTECTED email of the user, nothing else (BACKLOG-3910a)", () => {
  /**
   * C4' (SQL half). Each removed row is one the OLD predicate spared: another
   * provider, out of window, NULL sent_at, NULL source, NULL provider id.
   * MUTATION: put back `AND sent_at >= ?` / `AND source IN (…)` /
   * `AND external_id IS NOT NULL` -> the matching row survives, red.
   */
  it("removes unprotected rows of any provider, age, account and provider id; other users untouched", () => {
    addEmail("u-gmail");
    addEmail("u-outlook", { source: "outlook" });
    addEmail("u-old", { sentAt: "2019-01-01T00:00:00Z" });
    addEmail("u-null-sent", { sentAt: null });
    addEmail("u-null-source", { source: null });
    addEmail("u-null-ext", { externalId: null });
    addEmail("o-1", { userId: OTHER });

    expect(deleteLiveForceSet(db as never, SET)).toBe(6);
    expect(liveIds()).toEqual(["o-1"]);
  });

  /**
   * C3 / C11 (SQL half): each of the four ties keeps its email, one row per arm.
   * MUTATION: drop any one arm -> that arm's row is removed, red.
   */
  it("keeps an email tied by ANY of the four links, and removes the untied one beside them", () => {
    addDeal("d1");
    const item = addChecklist("d1");
    addEmail("k-linked");
    addEmail("k-rejected");
    addEmail("k-email-member");
    addEmail("k-attachment-member");
    addEmail("gone");
    linkEmail("c1", "d1", "k-linked");
    rejectEmail("i1", "d1", "k-rejected");
    addEmailMember("L1", item, "k-email-member");
    addAttachmentMember("L2", item, "att-1", { emailId: "k-attachment-member" });

    expect(deleteLiveForceSet(db as never, SET)).toBe(1);
    expect(liveIds(USER)).toEqual(["k-attachment-member", "k-email-member", "k-linked", "k-rejected"]);
  });

  /**
   * C16 — the NULL-in-keep-list trap. A checklist attachment member whose
   * attachment is a TEXT attachment (`attachments.email_id` NULL) must not stop
   * the removal. Written as EXISTS per arm (SR S1), there is no NULL to trip.
   *
   * MUTATION: rewrite the attachment arm as `e.id NOT IN (SELECT a.email_id …)`
   * with no IS NOT NULL filter -> 0 rows removed, red.
   */
  it("C16: a text-attachment checklist member does not stop unprotected emails being removed", () => {
    addDeal("d1");
    const item = addChecklist("d1");
    db.prepare(`INSERT INTO messages (id, user_id, channel) VALUES ('msg-1', ?, 'imessage')`).run(USER);
    addAttachmentMember("L-text", item, "att-text", { messageId: "msg-1" });
    addEmail("gone-1");
    addEmail("gone-2", { source: "outlook" });

    expect(deleteLiveForceSet(db as never, SET)).toBe(2);
    expect(liveIds(USER)).toEqual([]);
  });

  /**
   * C9' (SQL half): a suggestion waiting in Needs Review is NOT a protecting
   * tie (founder ade2d364). Its row goes with the email.
   * MUTATION: add the pending-review table as a fifth keep arm -> the
   * pending-only email survives, red.
   */
  it("C9': a pending-review suggestion does not protect its email", () => {
    addDeal("d1");
    addEmail("pending-only");
    db.prepare(
      `INSERT INTO pending_review_communications (id, user_id, transaction_id, email_id) VALUES ('p1', ?, 'd1', 'pending-only')`,
    ).run(USER);

    expect(deleteLiveForceSet(db as never, SET)).toBe(1);
    expect(liveIds(USER)).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_review_communications`).get()).toEqual({ n: 0 });
  });
});

describe("selectProtectedLiveEmails — the kept set and its frozen flag", () => {
  const frozenOf = (): Record<string, number> =>
    Object.fromEntries(
      selectProtectedLiveEmails(db as never, SET, LOCKED_SUBMISSION_STATUSES).map((r) => [r.id, r.frozen]),
    );

  it("LOCKED_SUBMISSION_STATUSES is derived from the lock map: exactly the four locking statuses", () => {
    expect([...LOCKED_SUBMISSION_STATUSES].sort()).toEqual([
      "approved",
      "resubmitted",
      "submitted",
      "under_review",
    ]);
  });

  /**
   * C5 / C5c (SQL half): the gate reads `submission_status`.
   * MUTATION: freeze nothing (`CASE WHEN 0`) -> every locked row reads 0, red;
   * freeze everything -> the open rows read 1, red.
   */
  it("flags an email linked to a locked deal frozen, and one on an open deal not frozen", () => {
    const statuses = [
      "submitted",
      "under_review",
      "resubmitted",
      "approved",
      "not_submitted",
      "needs_changes",
      "rejected",
    ];
    for (const status of statuses) {
      addDeal(`d-${status}`, status);
      addEmail(`e-${status}`);
      linkEmail(`c-${status}`, `d-${status}`, `e-${status}`);
    }
    expect(frozenOf()).toEqual({
      "e-submitted": 1,
      "e-under_review": 1,
      "e-resubmitted": 1,
      "e-approved": 1,
      "e-not_submitted": 0,
      "e-needs_changes": 0,
      "e-rejected": 0,
    });
  });

  it("freezes via a locked deal's checklist (email-kind and attachment-kind), and via one locked link among open ones", () => {
    addDeal("open");
    addDeal("locked", "approved");
    const lockedItem = addChecklist("locked");
    addEmail("both");
    addEmail("cl-email");
    addEmail("cl-att");
    linkEmail("c1", "open", "both");
    linkEmail("c2", "locked", "both");
    addEmailMember("L1", lockedItem, "cl-email");
    addAttachmentMember("L2", lockedItem, "att-1", { emailId: "cl-att" });

    expect(frozenOf()).toEqual({ both: 1, "cl-email": 1, "cl-att": 1 });
  });

  /** SR R3(b): a rejection on a locked deal keeps the email but does not freeze it. */
  it("a rejected suggestion on a locked deal keeps the email without freezing it", () => {
    addDeal("locked", "submitted");
    addEmail("rej");
    rejectEmail("i1", "locked", "rej");
    expect(frozenOf()).toEqual({ rej: 0 });
  });

  it("refuses an empty locked-status list rather than freezing nothing", () => {
    expect(() => selectProtectedLiveEmails(db as never, SET, [])).toThrow(/no locked status/);
  });
});

describe("emailForceReadView — other users' rows UNION what this run staged", () => {
  const STAGING = checkedStagingTable(
    `${STAGING_PREFIX["email-recache"]}0123456789ab_emails`,
    "email-recache",
  );

  beforeEach(() => {
    db.exec(`CREATE TABLE "${STAGING}" AS SELECT * FROM emails WHERE 0`);
  });

  /**
   * Every live row of the user is hidden — protected or not, any provider or
   * age — so every fetched message is staged and the swap decides per row.
   * MUTATION: survivors predicate back to the old scope -> `mine-*` rows
   * appear, red.
   */
  it("hides EVERY live row of the user, and returns other users' rows plus staged rows", () => {
    addEmail("mine-gmail");
    addEmail("mine-old", { sentAt: "2019-01-01T00:00:00Z", source: "outlook" });
    addEmail("mine-null-ext", { externalId: null });
    addEmail("theirs", { userId: OTHER });
    db.prepare(`INSERT INTO "${STAGING}" (id, user_id, subject) VALUES ('staged-1', ?, 's')`).run(USER);

    const view = emailForceReadView(SET, STAGING, sql`id`);
    const ids = (
      db.prepare(`SELECT id FROM ${view.sql} ORDER BY id`).all(...view.params) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(ids).toEqual(["staged-1", "theirs"]);
    expect(view.params).toEqual([USER]);
  });
});

describe("the staging name is branded here too, not just in stagingDdlSql", () => {
  /**
   * A2's first revision took `stagingTable: string` and interpolated it into
   * `FROM "${stagingTable}"` under a docstring saying it "is checked at
   * construction". A comment is not a constraint, and the brand A1 spent two
   * rounds establishing was dropped one commit later — including on
   * `EmailForceStaging.emailsTable`, which widened it back to `string` between
   * a correct construction and a correct use.
   *
   * These directives fail the build if the brand is ever removed again, the
   * same control A1 uses. `type-check:tests` is where they bite; `type-check`
   * skips test files.
   */
  const SET2: EmailForceSet = { userId: "u" };

  it("refuses an unchecked staging table at the type level", () => {
    // `columns` is `sql`id`` and NOT the plain "id" it used to be. That matters:
    // a `@ts-expect-error` swallows EVERY error on its line, so once `columns`
    // became `SafeSql` a plain "id" here would satisfy the directive by itself
    // and these two lines would stop proving anything about the staging table.
    // With `columns` correct, the ONLY error left on each line is the one the
    // test is named for. (BACKLOG-3102 PR 2.)

    // @ts-expect-error a hostile raw string is not a StagingTableName
    expect(() => emailForceReadView(SET2, 'x"; DROP TABLE emails; --', sql`id`)).toBeDefined();

    // @ts-expect-error even a well-formed name is refused until it is checked
    expect(() => emailForceReadView(SET2, "staging_emailrecache_deadbeefcafe_emails", sql`id`)).toBeDefined();
  });

  it("accepts the checked form, so the brand is satisfiable and not merely obstructive", () => {
    // Without this, a brand so tight that nothing could satisfy it would also
    // pass the expect-error block above.
    const ok = checkedStagingTable(
      `${STAGING_PREFIX["email-recache"]}0123456789ab_emails`,
      "email-recache",
    );
    expect(emailForceReadView(SET2, ok, sql`id`).sql).toContain(ok);
  });
});

