/**
 * @jest-environment node
 */
/**
 * People found in the user's email — the producer's controls (BACKLOG-1717).
 *
 * ===========================================================================
 * WHY THIS SUITE USES `openTestDb` RATHER THAN REQUIRING THE DRIVER
 * ===========================================================================
 * `jest.config.js` maps `^better-sqlite3-multiple-ciphers$` to a MOCK. A suite
 * that imports the driver by package name gets that mock: every write appears
 * to succeed, every read returns nothing, and a producer test passes while
 * measuring NOTHING. The failure mode is a GREEN run, which is why this matters.
 *
 * `openTestDb` is the repo's answer: it resolves the real driver by a path
 * RELATIVE to this file — escaping the anchored mapper — and falls back to
 * `node:sqlite` when the shared binary is built for the Electron ABI and cannot
 * load under plain Node. Both are real SQLite running the real statements.
 *
 * An earlier version of this file required the driver by an ABSOLUTE path
 * lifted from a throwaway planning probe. It worked on the machine that wrote
 * it and failed on CI with `Cannot find module`, because that path exists on
 * exactly one computer. A test fixture is shipped code.
 *
 * Every `describe` below also asserts a NON-ZERO fixture row count before
 * asserting anything about the producer — a green run on an empty database is
 * the thing this file must not be able to produce.
 *
 * ===========================================================================
 * WHY THE FIXTURE IS NOT HAND-WRITTEN
 * ===========================================================================
 * Participants are produced by the REAL provider parsers
 * (`gmailFetchService._parseMessage`, `outlookFetchService._parseMessage`) on
 * provider-shaped messages, and stored by the REAL sync writer
 * (`prepareParticipantInsert`) against the REAL `schema.sql`. `emails.direction`
 * follows the rule transcribed from `emailSyncService.ts`. So the rows these
 * controls read are rows the app can actually emit — not a shape invented to
 * make a test pass.
 *
 * ===========================================================================
 * MUTATIONS
 * ===========================================================================
 * The candidate query is built by a function, so a mutation is applied to
 * `emailDerivedContactsSql.ts` ITSELF and this suite re-run — the shipped code
 * is what gets broken. The list of mutations, and the controls each one is
 * expected to redden, is in the PR body and the implementation handoff.
 */

import fs from "fs";
import path from "path";
import { prepareParticipantInsert } from "../emailSyncSql";
import { computeParticipantHash } from "../../../utils/emailAddress";
import gmailFetchService from "../../gmailFetchService";
import outlookFetchService from "../../outlookFetchService";
import { openTestDb, currentEngine } from "../../__tests__/helpers/syncSqliteDriver";
import {
  buildEmailDerivedCandidateQuery,
  runEmailDerivedQueryOn,
  emailDerivedRecordId,
  type EmailDerivedCandidateRow,
  type EmailDerivedProvider,
  type EmailDerivedRecord,
} from "../emailDerivedContactsSql";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "../../../database/schema.sql"),
  "utf-8",
);

const U = "user-1";
const OTHER_USER = "user-2";
const OWNER_OUTLOOK = "owner.outlook@example.com";
const OWNER_GMAIL = "owner.gmail@example.com";
const LOGIN = "login@example.com";

const BOTH: EmailDerivedProvider[] = ["outlook", "gmail"];
const OUTLOOK_ONLY: EmailDerivedProvider[] = ["outlook"];
const GMAIL_ONLY: EmailDerivedProvider[] = ["gmail"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function newDb(): Db {
  const db = openTestDb();
  db.exec(SCHEMA);
  return db;
}

function seedUser(
  db: Db,
  opts: { outlookAddress?: string | null; googleAddress?: string | null; userId?: string } = {},
): void {
  const userId = opts.userId ?? U;
  db.prepare(
    `INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?,?,?,?)`,
  ).run(userId, userId === U ? LOGIN : `${userId}@example.com`, "microsoft", `oid-${userId}`);
  if (opts.outlookAddress !== undefined || userId === U) {
    db.prepare(
      `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address) VALUES (?,?,?,?,?)`,
    ).run(
      `tok-ms-${userId}`,
      userId,
      "microsoft",
      "mailbox",
      opts.outlookAddress === undefined ? OWNER_OUTLOOK : opts.outlookAddress,
    );
  }
  if (opts.googleAddress !== undefined) {
    db.prepare(
      `INSERT INTO oauth_tokens (id, user_id, provider, purpose, connected_email_address) VALUES (?,?,?,?,?)`,
    ).run(`tok-g-${userId}`, userId, "google", "mailbox", opts.googleAddress);
  }
}

/** Real Gmail parse -> real participant insert. */
function storeGmail(
  db: Db,
  id: string,
  h: {
    from: string;
    to?: string;
    cc?: string;
    bcc?: string;
    date: string;
    /** When set, `sent_at` is NULL and only `received_at` carries the date. */
    receivedOnly?: boolean;
  },
  mailboxAddress: string | null,
  userId = U,
): void {
  const msg = {
    id,
    threadId: `t-${id}`,
    internalDate: String(Date.parse(h.date)),
    labelIds: [],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: h.from },
        { name: "To", value: h.to ?? "" },
        { name: "Cc", value: h.cc ?? "" },
        { name: "Bcc", value: h.bcc ?? "" },
        { name: "Subject", value: "s" },
        { name: "Date", value: h.date },
      ],
      body: { data: Buffer.from("b").toString("base64") },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = (gmailFetchService as any)._parseMessage(msg);
  storeParsed(db, id, parsed, "gmail", h.date, mailboxAddress, userId, h.receivedOnly);
}

function storeOutlook(
  db: Db,
  id: string,
  h: {
    from: string;
    fromName?: string | null;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    date: string;
    receivedOnly?: boolean;
  },
  mailboxAddress: string | null,
  userId = U,
): void {
  const rcp = (list?: string[]) =>
    (list ?? []).map((a) => ({ emailAddress: { address: a, name: null } }));
  const msg = {
    id,
    conversationId: `t-${id}`,
    subject: "s",
    from: { emailAddress: { address: h.from, name: h.fromName ?? null } },
    toRecipients: rcp(h.to),
    ccRecipients: rcp(h.cc),
    bccRecipients: rcp(h.bcc),
    sentDateTime: h.date,
    receivedDateTime: h.date,
    body: { contentType: "text", content: "b" },
    hasAttachments: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = (outlookFetchService as any)._parseMessage(msg);
  storeParsed(db, id, parsed, "outlook", h.date, mailboxAddress, userId, h.receivedOnly);
}

function storeParsed(
  db: Db,
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parsed: any,
  source: "gmail" | "outlook",
  date: string,
  mailboxAddress: string | null,
  userId: string,
  receivedOnly?: boolean,
): void {
  // Direction rule, transcribed from emailSyncService.ts: it needs the
  // mailbox address, so a mailbox with no stored address leaves it NULL.
  let direction: string | null = null;
  if (mailboxAddress && parsed.from) {
    const fromAddr = parsed.participants?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.role === "from",
    )?.email_address;
    direction = fromAddr === mailboxAddress.toLowerCase() ? "outbound" : "inbound";
  }
  db.prepare(
    `INSERT INTO emails (id, user_id, external_id, source, direction, subject, sender, sent_at, received_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    userId,
    id,
    source,
    direction,
    "s",
    parsed.from ?? null,
    receivedOnly ? null : date,
    date,
  );
  const stmt = prepareParticipantInsert(db, "live" as never);
  for (const p of parsed.participants ?? []) {
    stmt.run(
      id,
      p.role,
      p.position,
      computeParticipantHash(id, p.role, p.position, p.email_address),
      p.email_address,
      p.display_name,
    );
  }
}

function addSaved(
  db: Db,
  cid: string,
  name: string,
  email: string,
  opts: { imported?: number; removedAt?: string | null; userId?: string } = {},
): void {
  db.prepare(
    `INSERT INTO contacts (id, user_id, display_name, source, is_imported, removed_at) VALUES (?,?,?,?,?,?)`,
  ).run(
    cid,
    opts.userId ?? U,
    name,
    "manual",
    opts.imported ?? 1,
    opts.removedAt ?? null,
  );
  db.prepare(`INSERT INTO contact_emails (id, contact_id, email) VALUES (?,?,?)`).run(
    `${cid}-e`,
    cid,
    email,
  );
}

/**
 * Run the SHIPPED runner — the same function the worker and the main-thread
 * fallback both call — and return the folded records.
 */
function produce(
  db: Db,
  providers: EmailDerivedProvider[],
  userId = U,
): EmailDerivedRecord[] {
  return runEmailDerivedQueryOn(db, userId, providers);
}

const addresses = (records: EmailDerivedRecord[]): string[] =>
  records.map((r) => r.email).sort();

/**
 * THE ANTI-VACUITY GUARD (D8).
 *
 * Asserts the fixture actually landed before any control reads it. Without
 * this, a mapper change, a schema change or a typo in a helper turns every
 * control in the file into a test of an empty database — which passes.
 */
function assertFixtureLanded(db: Db, userId = U): void {
  const emails = db
    .prepare(`SELECT COUNT(*) AS n FROM emails WHERE user_id = ?`)
    .get(userId) as { n: number };
  const participants = db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_participants ep JOIN emails e ON e.id = ep.email_id WHERE e.user_id = ?`,
    )
    .get(userId) as { n: number };
  expect(emails.n).toBeGreaterThan(0);
  expect(participants.n).toBeGreaterThan(0);
}

describe("BACKLOG-1717 — people found in the user's email", () => {
  /**
   * THE HARNESS CONTROL (D8). Everything below is worthless if this suite is
   * talking to the jest mock rather than a database.
   *
   * The mock's `prepare().get()` returns undefined and its `all()` returns an
   * empty array, so it cannot compute `1 + 1` and cannot report an engine.
   */
  it("runs real SQL on a real engine, not the jest mock", () => {
    const db = newDb();
    expect(["better-sqlite3", "node:sqlite"]).toContain(currentEngine());
    expect(db.prepare("SELECT 1 + 1 AS sum").get()).toEqual({ sum: 2 });
    // and the real schema is loaded, not a convenient subset
    const cols = (
      db.prepare("PRAGMA table_info(email_participants)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toContain("email_address");
    expect(cols).toContain("display_name");
    db.close();
  });

  describe("the list the picker is handed", () => {
    let db: Db;

    beforeEach(() => {
      db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });

      // An Outlook correspondent whose name is carried on one mail and whose
      // address is carried AS the name on another — the real Graph shape.
      storeOutlook(
        db,
        "o1",
        { from: "avery@example.com", fromName: "Avery Example", to: [OWNER_OUTLOOK], date: "2026-03-02T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      storeOutlook(
        db,
        "o1b",
        { from: "avery@example.com", fromName: "avery@example.com", to: [OWNER_OUTLOOK], date: "2026-03-02T11:00:00Z" },
        OWNER_OUTLOOK,
      );
      // A correspondent whose mail never carried a name at all.
      storeOutlook(
        db,
        "o2",
        { from: "casey@example.com", to: [OWNER_OUTLOOK], date: "2026-03-01T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      // A Gmail correspondent.
      storeGmail(
        db,
        "g1",
        { from: "Gina Example <gina@example.com>", to: OWNER_GMAIL, date: "2026-02-20T10:00:00Z" },
        OWNER_GMAIL,
      );
      // Someone reachable only as a `to` recipient, never a sender.
      storeOutlook(
        db,
        "o3",
        { from: "avery@example.com", to: [OWNER_OUTLOOK, "toonly@example.com"], date: "2026-02-19T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      // bcc-only: must NOT appear (founder: skip bcc for now).
      storeGmail(
        db,
        "g2",
        { from: OWNER_GMAIL, to: "gina@example.com", bcc: "blake@example.com", date: "2026-02-18T10:00:00Z" },
        OWNER_GMAIL,
      );
      // The owner's own LOGIN address as a cc on Outlook mail.
      storeOutlook(
        db,
        "o4",
        { from: "avery@example.com", to: [OWNER_OUTLOOK], cc: [LOGIN], date: "2026-02-17T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      // A saved contact's address -> suppressed.
      addSaved(db, "c-saved", "Morgan Saved", "morgan@example.com");
      storeOutlook(
        db,
        "o5",
        { from: "morgan@example.com", to: [OWNER_OUTLOOK], date: "2026-02-16T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      // A REMOVED contact's address -> also suppressed (the user acted on them).
      addSaved(db, "c-removed", "Riley Gone", "riley@example.com", {
        removedAt: "2026-02-01T00:00:00Z",
      });
      storeOutlook(
        db,
        "o6",
        { from: "riley@example.com", to: [OWNER_OUTLOOK], date: "2026-02-15T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      // Same NAME as a saved contact, DIFFERENT address -> still shown.
      addSaved(db, "c-chen", "Michael Chen", "mchen.lender@example.com");
      storeOutlook(
        db,
        "o7",
        { from: "mchen.buyer@example.com", fromName: "Michael Chen", to: [OWNER_OUTLOOK], date: "2026-02-14T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      // Another user's mail must not leak into this user's list.
      seedUser(db, { userId: OTHER_USER, outlookAddress: "other.owner@example.com" });
      storeOutlook(
        db,
        "x1",
        { from: "stranger@example.com", to: ["other.owner@example.com"], date: "2026-03-05T10:00:00Z" },
        "other.owner@example.com",
        OTHER_USER,
      );

      assertFixtureLanded(db);
    });

    afterEach(() => db.close());

    /** K1 — the exact set, both mailboxes on. */
    it("K1: offers exactly the people the user has corresponded with", () => {
      expect(addresses(produce(db, BOTH))).toEqual([
        "avery@example.com",
        "casey@example.com",
        "gina@example.com",
        "mchen.buyer@example.com",
        "toonly@example.com",
      ]);
    });

    /** K2 — neither mailbox address nor the login address is a person. */
    it("K2: never offers the user their own addresses", () => {
      const found = addresses(produce(db, BOTH));
      expect(found).not.toContain(OWNER_OUTLOOK);
      expect(found).not.toContain(OWNER_GMAIL);
      expect(found).not.toContain(LOGIN);
    });

    /** K3b — bcc is excluded, and it is a real term: the row exists. */
    it("K3b: a person reachable only as bcc is not offered", () => {
      const bccRows = db
        .prepare(`SELECT COUNT(*) AS n FROM email_participants WHERE role = 'bcc'`)
        .get() as { n: number };
      expect(bccRows.n).toBeGreaterThan(0); // the exclusion is not a no-op
      expect(addresses(produce(db, BOTH))).not.toContain("blake@example.com");
    });

    /** K4 — a saved contact and a removed one both count as already known. */
    it("K4: hides an address a saved or removed contact already holds", () => {
      const found = addresses(produce(db, BOTH));
      expect(found).not.toContain("morgan@example.com");
      expect(found).not.toContain("riley@example.com");
    });

    /** K5 — suppression keys on the address, never on the name. */
    it("K5: still offers someone who shares a name with a saved contact", () => {
      expect(addresses(produce(db, BOTH))).toContain("mchen.buyer@example.com");
    });

    /** K6 — the read is scoped to this user. */
    it("K6: never offers people from another user's mail", () => {
      expect(addresses(produce(db, BOTH))).not.toContain("stranger@example.com");
    });

    /** K7 — the display name chosen for each address. */
    it("K7: names a person by the name their mail carried, or not at all", () => {
      const byAddress = new Map(produce(db, BOTH).map((r) => [r.email, r.name]));
      // The row whose "name" is the address again is ignored.
      expect(byAddress.get("avery@example.com")).toBe("Avery Example");
      // Never named -> offered by address alone.
      expect(byAddress.get("casey@example.com")).toBeNull();
      expect(byAddress.get("gina@example.com")).toBe("Gina Example");
    });

    /** K7b — the id is derived from the address, so it is stable. */
    it("K7b: gives a person the same id on every read", () => {
      const first = produce(db, BOTH).find((r) => r.email === "avery@example.com");
      const second = produce(db, BOTH).find((r) => r.email === "avery@example.com");
      expect(first?.id).toBe(emailDerivedRecordId("avery@example.com"));
      expect(first?.id).toBe(second?.id);
    });

    /** The record shape the picker needs, asserted by value. */
    it("carries the synthetic source and no address-book identity", () => {
      const record = produce(db, BOTH).find((r) => r.email === "avery@example.com");
      expect(record).toMatchObject({
        source: "email_derived",
        isFromDatabase: false,
        phone: null,
        company: null,
        allEmails: ["avery@example.com"],
        allPhones: [],
      });
      expect(record).not.toHaveProperty("externalRecordId");
      expect(record).not.toHaveProperty("externalSourceType");
    });

    /** K6g — the mailboxes selected decide who is offered. */
    it("K6g: offers only the mailboxes that are on", () => {
      expect(addresses(produce(db, OUTLOOK_ONLY))).not.toContain("gina@example.com");
      expect(addresses(produce(db, GMAIL_ONLY))).toEqual(["gina@example.com"]);
    });

    /** K10 — the plan shape that keeps the read fast. */
    it("K10: runs without a correlated subquery over the saved addresses", () => {
      const candidate = buildEmailDerivedCandidateQuery(U, BOTH);
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${candidate.sql}`)
        .all(...candidate.params) as Array<{ detail: string }>;
      const detail = plan.map((p) => p.detail).join(" | ");
      expect(detail.length).toBeGreaterThan(0);
      expect(detail).not.toContain("CORRELATED SCALAR SUBQUERY");
    });
  });

  describe("one person, two mailboxes", () => {
    let db: Db;

    beforeEach(() => {
      db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });
      storeOutlook(
        db,
        "o1",
        { from: "both@example.com", to: [OWNER_OUTLOOK], date: "2026-03-03T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      storeGmail(
        db,
        "g1",
        { from: "both@example.com", to: OWNER_GMAIL, date: "2026-03-04T10:00:00Z" },
        OWNER_GMAIL,
      );
      assertFixtureLanded(db);
    });

    afterEach(() => db.close());

    /** K-both — one row, and the count follows the enabled mailboxes. */
    it("K-both: offers one row, counted from the mailboxes that are on", () => {
      const both = produce(db, BOTH);
      expect(both).toHaveLength(1);
      expect(both[0].email).toBe("both@example.com");

      const candidate = buildEmailDerivedCandidateQuery(U, BOTH);
      const bothRows = db
        .prepare(candidate.sql)
        .all(...candidate.params) as EmailDerivedCandidateRow[];
      expect(bothRows[0].communication_count).toBe(2);
      expect(bothRows[0].last_communication_at).toContain("2026-03-04");

      const outlookQuery = buildEmailDerivedCandidateQuery(U, OUTLOOK_ONLY);
      const outlookRows = db
        .prepare(outlookQuery.sql)
        .all(...outlookQuery.params) as EmailDerivedCandidateRow[];
      expect(outlookRows).toHaveLength(1);
      // The Gmail mail contributes NOTHING to an Outlook-only view — not to
      // the count, and not to the date the list is sorted by.
      expect(outlookRows[0].communication_count).toBe(1);
      expect(outlookRows[0].last_communication_at).toContain("2026-03-03");
    });

    /** K4b (part 2) — an address in both mailboxes is suppressed ONCE. */
    it("K4b: a saved contact hides a both-mailbox address with no second row", () => {
      addSaved(db, "c1", "Both Saved", "both@example.com");
      expect(produce(db, BOTH)).toHaveLength(0);
    });
  });

  describe("the mailboxes the read covers", () => {
    /** K-afterLimit — the provider filter runs before the 200-row cut. */
    it("K-afterLimit: a busy Gmail mailbox cannot push Outlook people off the list", () => {
      const db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });
      // 250 Gmail correspondents, ALL newer than the five Outlook ones.
      for (let i = 0; i < 250; i++) {
        storeGmail(
          db,
          `g${i}`,
          {
            from: `gm${i}@example.com`,
            to: OWNER_GMAIL,
            date: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
          },
          OWNER_GMAIL,
        );
      }
      for (let i = 0; i < 5; i++) {
        storeOutlook(
          db,
          `o${i}`,
          { from: `ol${i}@example.com`, to: [OWNER_OUTLOOK], date: "2026-01-05T10:00:00Z" },
          OWNER_OUTLOOK,
        );
      }
      assertFixtureLanded(db);

      const outlookOnly = produce(db, OUTLOOK_ONLY);
      expect(outlookOnly).toHaveLength(5);
      expect(addresses(outlookOnly)).toEqual([
        "ol0@example.com",
        "ol1@example.com",
        "ol2@example.com",
        "ol3@example.com",
        "ol4@example.com",
      ]);
      db.close();
    });
  });

  describe("a mailbox that has lost its stored address", () => {
    /**
     * K9g — fail closed PER MAILBOX, plus the residual that rule cannot close.
     *
     * The Google token's address is NULL, which is a state the app really
     * reaches (nothing repairs a Google mailbox row, unlike the Outlook one).
     */
    it("K9g: drops the affected mailbox only, and leaves the other one working", () => {
      const db = newDb();
      seedUser(db, { googleAddress: null });
      storeOutlook(
        db,
        "o1",
        { from: "avery@example.com", to: [OWNER_OUTLOOK], date: "2026-03-02T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      // Gmail mail stored while the address was missing -> direction NULL.
      storeGmail(
        db,
        "g1",
        { from: "gina@example.com", to: OWNER_GMAIL, date: "2026-03-01T10:00:00Z" },
        null,
      );
      assertFixtureLanded(db);

      const directions = db
        .prepare(`SELECT id, direction FROM emails WHERE source = 'gmail'`)
        .all() as Array<{ id: string; direction: string | null }>;
      expect(directions).toHaveLength(1);
      expect(directions[0].direction).toBeNull(); // the state this control is about

      // The Gmail mailbox contributes nothing...
      expect(addresses(produce(db, GMAIL_ONLY))).toEqual([]);
      // ...and the Outlook one is untouched. A global rule would empty this too.
      expect(addresses(produce(db, OUTLOOK_ONLY))).toEqual(["avery@example.com"]);
      expect(addresses(produce(db, BOTH))).toEqual(["avery@example.com"]);
      db.close();
    });

    /**
     * K9g-residual — RECORDED, NOT FIXED. Asserted as current behaviour so a
     * later fix reddens deliberately rather than passing in silence.
     *
     * The user's own Gmail address arrives as a `cc` on an OUTLOOK mail while
     * the Google token holds no address. Excluding the Gmail provider cannot
     * remove an address sitting on Outlook's rows, and with no stored address
     * neither the token term nor the outbound term can name it. So the owner
     * appears as a person in the OUTLOOK list — the list the founder tests
     * first. Same residual class as an alias the user sends from.
     */
    it("K9g-residual: the owner's Gmail address can still show up in the Outlook list", () => {
      const db = newDb();
      seedUser(db, { googleAddress: null });
      storeOutlook(
        db,
        "o1",
        {
          from: "avery@example.com",
          to: [OWNER_OUTLOOK],
          cc: [OWNER_GMAIL],
          date: "2026-03-02T10:00:00Z",
        },
        OWNER_OUTLOOK,
      );
      assertFixtureLanded(db);

      expect(addresses(produce(db, OUTLOOK_ONLY))).toEqual([
        "avery@example.com",
        OWNER_GMAIL,
      ]);
      db.close();
    });

    /**
     * K11g — one NULL address must not empty BOTH lists.
     *
     * A NULL inside a `NOT IN` list makes the whole predicate NULL, so an
     * unfiltered own-address set returns nothing at all — for every mailbox,
     * including the healthy one.
     */
    it("K11g: a Google mailbox with no address does not blank the Outlook list", () => {
      const db = newDb();
      seedUser(db, { googleAddress: null });
      storeOutlook(
        db,
        "o1",
        { from: "avery@example.com", to: [OWNER_OUTLOOK], date: "2026-03-02T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      assertFixtureLanded(db);
      expect(addresses(produce(db, OUTLOOK_ONLY))).toEqual(["avery@example.com"]);
      expect(addresses(produce(db, BOTH))).toEqual(["avery@example.com"]);
      db.close();
    });

    /** K9 — the same rule on the Outlook side. */
    it("K9: an Outlook mailbox with no address offers no Outlook people", () => {
      const db = newDb();
      seedUser(db, { outlookAddress: null, googleAddress: OWNER_GMAIL });
      storeOutlook(
        db,
        "o1",
        { from: "avery@example.com", to: [OWNER_OUTLOOK], date: "2026-03-02T10:00:00Z" },
        null,
      );
      storeGmail(
        db,
        "g1",
        { from: "gina@example.com", to: OWNER_GMAIL, date: "2026-03-01T10:00:00Z" },
        OWNER_GMAIL,
      );
      assertFixtureLanded(db);
      expect(addresses(produce(db, OUTLOOK_ONLY))).toEqual([]);
      expect(addresses(produce(db, GMAIL_ONLY))).toEqual(["gina@example.com"]);
      db.close();
    });
  });

  describe("a mailbox the user has moved on from", () => {
    /** K12 / K12g — a former mailbox address is still the user's. */
    it("K12g: never offers an address the user used to send from", () => {
      const db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });
      // Sent from the OLD Gmail address, back when it was the mailbox.
      storeGmail(
        db,
        "g1",
        { from: "former.gmail@example.com", to: "gina@example.com", date: "2026-01-01T10:00:00Z" },
        "former.gmail@example.com",
      );
      storeGmail(
        db,
        "g2",
        { from: "Gina Example <gina@example.com>", to: OWNER_GMAIL, date: "2026-03-01T10:00:00Z" },
        OWNER_GMAIL,
      );
      assertFixtureLanded(db);

      const found = addresses(produce(db, GMAIL_ONLY));
      expect(found).toContain("gina@example.com");
      expect(found).not.toContain("former.gmail@example.com");
    });

    /**
     * K12 — and the union is NOT scoped to the mailboxes being read.
     *
     * A former OUTLOOK address turning up on GMAIL mail while only Gmail is
     * on. If the outbound union were narrowed to the providers in the read,
     * this would come back as a person.
     */
    it("K12: a former address of one mailbox is excluded from the other's list", () => {
      const db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });
      storeOutlook(
        db,
        "o1",
        { from: "former.outlook@example.com", to: ["someone@example.com"], date: "2026-01-01T10:00:00Z" },
        "former.outlook@example.com",
      );
      storeGmail(
        db,
        "g1",
        {
          from: "Gina Example <gina@example.com>",
          to: OWNER_GMAIL,
          cc: "former.outlook@example.com",
          date: "2026-03-01T10:00:00Z",
        },
        OWNER_GMAIL,
      );
      assertFixtureLanded(db);

      const found = addresses(produce(db, GMAIL_ONLY));
      expect(found).toContain("gina@example.com");
      expect(found).not.toContain("former.outlook@example.com");
    });
  });

  describe("addresses a saved contact holds", () => {
    /** K4b — the subquery is scoped to this user, and folds casing. */
    it("K4b: another user's saved contact does not hide this user's correspondent", () => {
      const db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });
      seedUser(db, { userId: OTHER_USER, outlookAddress: "other.owner@example.com" });
      storeOutlook(
        db,
        "o1",
        { from: "avery@example.com", to: [OWNER_OUTLOOK], date: "2026-03-02T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      // The OTHER user has this person saved. That is not our knowledge.
      addSaved(db, "c-other", "Avery Example", "avery@example.com", { userId: OTHER_USER });
      assertFixtureLanded(db);
      expect(addresses(produce(db, BOTH))).toEqual(["avery@example.com"]);
      db.close();
    });

    /**
     * K4b (casing) — a legacy saved address stored mixed-case and padded.
     *
     * INVENTED FIXTURE, and labelled: today's writers normalise on the way in,
     * so this row stands in for the legacy population that predates that. The
     * `LOWER(TRIM(...))` on the suppression side is what covers them.
     */
    it("K4b: a saved address stored mixed-case and padded still suppresses", () => {
      const db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });
      storeOutlook(
        db,
        "o1",
        { from: "avery@example.com", to: [OWNER_OUTLOOK], date: "2026-03-02T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      db.prepare(
        `INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?,?,?,?,1)`,
      ).run("c-legacy", U, "Avery Example", "manual");
      db.prepare(`INSERT INTO contact_emails (id, contact_id, email) VALUES (?,?,?)`).run(
        "c-legacy-e",
        "c-legacy",
        "  Avery@Example.com ",
      );
      assertFixtureLanded(db);
      expect(addresses(produce(db, BOTH))).toEqual([]);
      db.close();
    });
  });

  describe("the order people are offered in", () => {
    /**
     * PM addition 14 — order on `COALESCE(sent_at, received_at)`.
     *
     * Gmail is the likelier of the two to carry one and not the other: its
     * `sent_at` is the sender's own `Date:` header while `received_at` is
     * server delivery. On bare `sent_at` these people sort last.
     */
    it("orders by when the mail arrived, even with no sent date", () => {
      const db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });
      storeOutlook(
        db,
        "o1",
        { from: "older@example.com", to: [OWNER_OUTLOOK], date: "2026-03-01T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      storeGmail(
        db,
        "g1",
        { from: "newer@example.com", to: OWNER_GMAIL, date: "2026-03-09T10:00:00Z", receivedOnly: true },
        OWNER_GMAIL,
      );
      assertFixtureLanded(db);

      const sentAt = db
        .prepare(`SELECT sent_at, received_at FROM emails WHERE id = 'g1'`)
        .get() as { sent_at: string | null; received_at: string | null };
      expect(sentAt.sent_at).toBeNull(); // the state this control is about
      expect(sentAt.received_at).not.toBeNull();

      const records = produce(db, BOTH);
      expect(records.map((r) => r.email)).toEqual([
        "newer@example.com",
        "older@example.com",
      ]);
      db.close();
    });

    /**
     * D5 — the NAME tie-break uses the same COALESCE as the list order.
     *
     * Two names for one address, the newer arriving on a Gmail row with no
     * sent date. On bare `sent_at` that row loses every tie-break and the
     * person keeps the stale name while sorting correctly in the list.
     */
    it("D5: the most recent name wins even when it arrived with no sent date", () => {
      const db = newDb();
      seedUser(db, { googleAddress: OWNER_GMAIL });
      storeOutlook(
        db,
        "o1",
        { from: "dana@example.com", fromName: "Dana One", to: [OWNER_OUTLOOK], date: "2026-03-01T10:00:00Z" },
        OWNER_OUTLOOK,
      );
      storeGmail(
        db,
        "g1",
        {
          from: "Dana Uno <dana@example.com>",
          to: OWNER_GMAIL,
          date: "2026-03-08T10:00:00Z",
          receivedOnly: true,
        },
        OWNER_GMAIL,
      );
      assertFixtureLanded(db);

      const record = produce(db, BOTH).find((r) => r.email === "dana@example.com");
      expect(record?.name).toBe("Dana Uno");
      db.close();
    });
  });
});
