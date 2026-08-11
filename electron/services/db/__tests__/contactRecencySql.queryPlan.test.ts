/**
 * @jest-environment node
 *
 * BACKLOG-2633 — THE PLAN IS THE FIX. THIS SUITE ASSERTS THE PLAN.
 *
 * The contacts picker took 7.4 seconds at the founder's record count because
 * both recency subqueries in `contactRecencySql.ts` drove from the BIG table —
 * the whole mailbox for the email half, the whole phone cache for the phone half
 * — and probed the contact's own handful of values last. Cost
 * `external_contacts x mailbox` where the docblock promised a per-contact
 * constant. The result set was never wrong; only the plan was.
 *
 * That makes a timing assertion the wrong test (machine-dependent, and a warm
 * cache can hide a factor of 600) and a result assertion insufficient on its own
 * (the results were always right). What must be pinned is the JOIN ORDER and the
 * INDEX each probe uses. Hence `EXPLAIN QUERY PLAN`.
 *
 * ## DO NOT COLLAPSE THIS SUITE TO ONE `ANALYZE` REGIME
 *
 * Every case runs twice: with and without `ANALYZE`. That doubling reads like
 * thoroughness for its own sake and it is not — it is the most surprising fact
 * in this item, and deleting half of it silently deletes the coverage.
 *
 * **The revert control for the email join pin is RED without stats and GREEN
 * with them.** A suite run only in the `ANALYZE=true` regime would have passed
 * this entire change with the join pin removed. Measured on this corpus:
 *
 *   - WITHOUT sqlite_stat1: the expression index alone is worth 1.0x. The
 *     CROSS JOINs are the only thing that moves the plan.
 *   - WITH sqlite_stat1: the planner flips to the right order ON ITS OWN once
 *     the index exists, so reverting the CROSS JOINs stays fast and stays green.
 *
 * **NO-STATS IS THE PRODUCTION REGIME.** `ANALYZE` is not run at startup, on
 * migration, or on any schedule. Its only caller is `maintenanceDbService.ts:63`
 * ("Optimize database"), reached from `diagnosticHandlers.ts:386`, reached from
 * `DataPrivacySettings.tsx:183` — a manual button behind a confirm dialog that a
 * user may never press. So `sqlite_stat1` is absent on a normal install, the
 * no-ANALYZE column is the real one, and the regime in which this fix is
 * load-bearing is the regime every user is actually in.
 *
 * `matchingIndexUsage.test.ts` (BACKLOG-2621) parameterises the same way for the
 * same reason. If you are tempted to simplify either suite to one regime, this
 * paragraph is the reason not to.
 *
 * ## The schema is the REAL schema.sql
 *
 * Not a hand-rolled subset. The whole subject is which indexes the planner can
 * see, so a fixture that declares its own index set would be testing a database
 * that does not exist. `electron/database/schema.sql` is exec'd verbatim.
 *
 * ## Controls that were run (see the PR body for the quoted red output)
 *
 *   - Drop `idx_email_participants_lower_address`  -> plan reverts to em-first, RED.
 *   - Revert the email half's CROSS JOINs to JOIN  -> plan reverts to em-first, RED.
 *   - Revert the phone half's CROSS JOIN to a comma join -> plan reverts to
 *     plm-first, RED.
 *
 * Each half was reverted INDEPENDENTLY, because either alone is worth ~1x-2x and
 * a control that only goes red when both are reverted cannot tell you that.
 */

import path from "path";
import fs from "fs";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";
import {
  EXTERNAL_CONTACTS_GET_ALL_SQL,
  IMPORTED_CONTACT_LAST_COMMUNICATION_SQL,
} from "../contactRecencySql";

const USER_ID = "plan-user";
const SCHEMA_PATH = path.join(__dirname, "..", "..", "..", "database", "schema.sql");

/**
 * The index this item adds. Named here rather than inlined so the "drop it and
 * watch the plan go red" control and the assertions cannot drift apart.
 */
const LOWER_ADDRESS_INDEX = "idx_email_participants_lower_address";

/**
 * The imported-path query, assembled the way `contactDbService` assembles it:
 * the fragment correlates to a `contacts` row aliased `c`.
 */
const IMPORTED_QUERY = `
  SELECT c.id, ${IMPORTED_CONTACT_LAST_COMMUNICATION_SQL}
  FROM contacts c
  WHERE c.user_id = ?
`;

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

/**
 * Deliberately NOT uniform. The picker's ORDER BY has three terms
 * (`last_message_at IS NULL`, `last_message_at DESC`, `name ASC`) and a corpus
 * where every row has a distinct recency exercises exactly one of them. This one
 * seeds email-only, phone-only, both, NEITHER (the NULL tail), and a deliberate
 * timestamp TIE between two contacts whose names order the opposite way to their
 * ids — so a regression that lost the `name ASC` tiebreak, or that let NULLs
 * float, is visible in the ordered id sequence.
 */
interface Seeded {
  externalIds: string[];
  contactIds: string[];
}

function seed(db: DatabaseType, opts: { emails: number }): Seeded {
  db.prepare(
    "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)",
  ).run(USER_ID, "plan@example.com", "oauth-plan");

  const insExt = db.prepare(
    `INSERT INTO external_contacts
       (id, user_id, name, phones_json, phones_normalized_json, emails_json, source, external_record_id)
     VALUES (?, ?, ?, ?, ?, ?, 'macos', ?)`,
  );
  const insEmail = db.prepare(
    "INSERT INTO emails (id, user_id, external_id, source, sent_at, received_at) VALUES (?, ?, ?, 'gmail', ?, ?)",
  );
  const insPart = db.prepare(
    `INSERT INTO email_participants (email_id, role, position, participant_hash, email_address)
     VALUES (?, 'from', 0, ?, ?)`,
  );
  const insPlm = db.prepare(
    "INSERT OR REPLACE INTO phone_last_message (phone_normalized, user_id, last_message_at) VALUES (?, ?, ?)",
  );

  const externalIds: string[] = [];
  const iso = (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 3_600_000).toISOString();

  // ---- the shaped rows, one per behaviour --------------------------------
  // `emails_json` is stored UPPERCASE on two of them so `LOWER(e_lc.value)` is
  // load-bearing: without it these read NULL and the identity control fails.
  const shaped: Array<{
    id: string;
    name: string;
    emails: string[];
    phones: string[];
  }> = [
    // NAMES ARE CASE LABELS IN CAPS, NOT PEOPLE, and phone numbers are in the
    // NANP fictional range 555-0100..555-0199 (ATIS-0300115). Both are required
    // by `scripts/ci/check-fixture-pii.mjs` on this PUBLIC repo. The caps are
    // not shouting: that guard flags any `"Firstname Lastname"` sharing a line
    // with an address or a number, because that is the identity-row shape that
    // leaked in BACKLOG-2542, and a label like "Zoe Emailonly" is
    // indistinguishable from a real one to a regex.
    { id: "x-email-only", name: "CASE EMAIL ONLY", emails: ["EMAIL.ONLY@example.com"], phones: [] },
    { id: "x-phone-only", name: "CASE PHONE ONLY", emails: [], phones: ["+12065550101"] },
    { id: "x-both", name: "CASE BOTH", emails: ["both@example.com"], phones: ["+12065550102"] },
    { id: "x-neither", name: "CASE NEITHER", emails: ["nobody@example.com"], phones: ["+12065550199"] },
    // The tie: same timestamp, names ordered OPPOSITE to ids — "CASE TIE A" on
    // x-tie-**b**, so a lost `name ASC` tiebreak flips the asserted order.
    { id: "x-tie-b", name: "CASE TIE A", emails: ["TIE.ONE@example.com"], phones: [] },
    { id: "x-tie-a", name: "CASE TIE B", emails: ["tie.two@example.com"], phones: [] },
  ];

  const insertEmailTo = (address: string, at: string, seq: number) => {
    const id = `em-shaped-${seq}`;
    insEmail.run(id, USER_ID, `ext-${id}`, at, at);
    // email_participants.email_address is ALWAYS stored lowercased (schema.sql).
    insPart.run(id, `h-${id}`, address.toLowerCase());
  };

  db.transaction(() => {
    for (const s of shaped) {
      externalIds.push(s.id);
      insExt.run(
        s.id,
        USER_ID,
        s.name,
        JSON.stringify(s.phones),
        JSON.stringify(s.phones),
        JSON.stringify(s.emails),
        `rec-${s.id}`,
      );
    }

    insertEmailTo("email.only@example.com", iso(500), 1);
    insertEmailTo("both@example.com", iso(400), 2);
    // Both tie rows land on the SAME timestamp.
    insertEmailTo("tie.one@example.com", iso(300), 3);
    insertEmailTo("tie.two@example.com", iso(300), 4);

    // Must match the `shaped` phones above verbatim — these ARE the join keys.
    insPlm.run("+12065550101", USER_ID, iso(600));
    insPlm.run("+12065550102", USER_ID, iso(450));

    // ---- bulk, so the plan has something to be wrong about ----------------
    for (let i = 0; i < opts.emails; i++) {
      const id = `em-bulk-${i}`;
      insEmail.run(id, USER_ID, `ext-${id}`, iso(i), iso(i));
      insPart.run(id, `h-${id}`, `bulk${i}@example.com`);
    }
    for (let i = 0; i < 200; i++) {
      insPlm.run(`+1666${String(1000000 + i).slice(-7)}`, USER_ID, iso(i));
    }
    for (let i = 0; i < 300; i++) {
      const id = `x-bulk-${String(i).padStart(4, "0")}`;
      externalIds.push(id);
      insExt.run(
        id,
        USER_ID,
        `Bulk ${String(i).padStart(4, "0")}`,
        JSON.stringify([]),
        JSON.stringify([]),
        JSON.stringify([`bulk${i}@example.com`]),
        `rec-${id}`,
      );
    }
  })();

  // ---- the imported side, for IMPORTED_CONTACT_LAST_COMMUNICATION_SQL -----
  const insContact = db.prepare(
    "INSERT INTO contacts (id, user_id, display_name) VALUES (?, ?, ?)",
  );
  const insCe = db.prepare(
    "INSERT INTO contact_emails (id, contact_id, email) VALUES (?, ?, ?)",
  );
  const insCp = db.prepare(
    "INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES (?, ?, ?, ?)",
  );
  const contactIds: string[] = [];
  db.transaction(() => {
    for (let i = 0; i < 40; i++) {
      const id = `c-${String(i).padStart(3, "0")}`;
      contactIds.push(id);
      insContact.run(id, USER_ID, `Contact ${i}`);
      insCe.run(`ce-${id}`, id, i === 0 ? "BOTH@example.com" : `bulk${i}@example.com`);
      insCp.run(`cp-${id}`, id, `+1666${String(1000000 + i).slice(-7)}`, `+1666${String(1000000 + i).slice(-7)}`);
    }
  })();

  return { externalIds, contactIds };
}

function makeDb(opts: { analyze: boolean; emails: number }): { db: DatabaseType; dir: string } {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "keepr-2633-plan-"));
  const db = new Database(path.join(dir, "plan.db")) as DatabaseType;
  db.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

  // `external_uuid` arrives via migration v57, and EXTERNAL_CONTACTS_GET_ALL_SQL
  // selects it. This fixture runs schema.sql only, not the chain.
  const cols = (db.prepare("PRAGMA table_info(external_contacts)").all() as Array<{
    name: string;
  }>).map((c) => c.name);
  if (!cols.includes("external_uuid")) {
    db.exec("ALTER TABLE external_contacts ADD COLUMN external_uuid TEXT");
  }

  seed(db, { emails: opts.emails });
  if (opts.analyze) db.exec("ANALYZE");
  return { db, dir };
}

function plan(db: DatabaseType, sql: string, ...binds: unknown[]): string[] {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...binds) as Array<{ detail: string }>
  ).map((r) => r.detail);
}

/**
 * The loop nest of one correlated subquery, in execution order: the rows between
 * `CORRELATED SCALAR SUBQUERY n` and the next `CORRELATED` marker.
 *
 * Nesting order in EXPLAIN QUERY PLAN output is what "drives from" means — the
 * FIRST line is the outer loop. That is the entire subject of this item.
 */
function subqueryNest(planLines: string[], n: number): string[] {
  const start = planLines.findIndex((l) => l.includes(`CORRELATED SCALAR SUBQUERY ${n}`));
  if (start === -1) return [];
  const rest = planLines.slice(start + 1);
  const end = rest.findIndex((l) => l.includes("CORRELATED SCALAR SUBQUERY"));
  return end === -1 ? rest : rest.slice(0, end);
}

// ---------------------------------------------------------------------------

describe.each([false, true])("BACKLOG-2633 query plans (ANALYZE=%s)", (analyze) => {
  let db: DatabaseType;
  let dir: string;

  beforeAll(() => {
    ({ db, dir } = makeDb({ analyze, emails: 1200 }));
  });

  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("schema.sql declares the LOWER(email_address) index (fresh-install path)", () => {
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='email_participants'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toContain(LOWER_ADDRESS_INDEX);

    // Present is not the same as correctly defined. A plain `email_address`
    // index under this name would satisfy the line above and serve nothing.
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(LOWER_ADDRESS_INDEX) as {
        sql: string;
      }
    ).sql;
    expect(sql.replace(/\s+/g, " ")).toContain("email_participants(LOWER(email_address))");
  });

  describe("EXTERNAL_CONTACT_LAST_MESSAGE_EXPR (the picker's read path)", () => {
    it("the EMAIL half drives from the contact's OWN addresses, not from the mailbox", () => {
      const nest = subqueryNest(plan(db, EXTERNAL_CONTACTS_GET_ALL_SQL, USER_ID), 2);

      // The defect, stated positively: `e_lc` (json_each over the row's own
      // emails_json) is the OUTER loop. Before the fix this line read
      // `SEARCH em USING INDEX idx_emails_user_sent (user_id=?)`.
      expect(nest[0]).toContain("e_lc");

      // ...and `emails` is reached LAST, by primary key, one row per hit.
      expect(nest[nest.length - 1]).toContain("em");
      expect(nest[nest.length - 1]).toContain("sqlite_autoindex_emails_1 (id=?)");

      // The whole plan must not scan the mailbox anywhere.
      expect(nest.join("\n")).not.toContain("idx_emails_user_sent");
    });

    it("the EMAIL half probes email_participants through the LOWER() index", () => {
      const nest = subqueryNest(plan(db, EXTERNAL_CONTACTS_GET_ALL_SQL, USER_ID), 2);
      const epLine = nest.find((l) => / ep_lc\b/.test(l));
      expect(epLine).toBeDefined();

      // `(<expr>=?)` is how SQLite reports an EXPRESSION index probe. Without
      // the index this line reads `SEARCH ep_lc` bare — a scan — which is the
      // 3,792 ms / 2.0x variant.
      expect(epLine).toContain(`USING INDEX ${LOWER_ADDRESS_INDEX} (<expr>=?)`);
    });

    it("the PHONE half drives from the contact's OWN phones and probes the cache by PK", () => {
      const nest = subqueryNest(plan(db, EXTERNAL_CONTACTS_GET_ALL_SQL, USER_ID), 1);

      // Before the fix this drove from `plm` under idx_phone_last_msg_user
      // (user_id=?) — every cached phone in the account, per contact. That was
      // the 247 ms floor left after the email half alone was fixed.
      expect(nest[0]).toContain("p_lc");
      expect(nest[1]).toContain("plm");
      expect(nest[1]).toContain("sqlite_autoindex_phone_last_message_1");
      expect(nest.join("\n")).not.toContain("idx_phone_last_msg_user");
    });

    it("`messages` is on NO part of this path (BACKLOG-2633 open question, closed)", () => {
      // 164,118 rows on the founder's disk — 50x the next table, and the one
      // unchecked risk when this item was written. The phone half reads the
      // precomputed `phone_last_message` cache instead (written at ingest by
      // messageDbService), so the big table is never touched.
      expect(plan(db, EXTERNAL_CONTACTS_GET_ALL_SQL, USER_ID).join("\n")).not.toMatch(
        /\bmessages\b/,
      );
    });
  });

  describe("IMPORTED_CONTACT_LAST_COMMUNICATION_SQL (the same defect, the same fix)", () => {
    it("the EMAIL half drives from contact_emails and probes through the LOWER() index", () => {
      const nest = subqueryNest(plan(db, IMPORTED_QUERY, USER_ID), 2);

      // Indexed probe by contact_id, not a scan. Which index serves it is the
      // planner's business — here it picks the UNIQUE(contact_id, email)
      // autoindex over idx_contact_emails_contact_id because it covers the read.
      expect(nest[0]).toContain("ce_lc");
      expect(nest[0]).toMatch(/SEARCH ce_lc USING (COVERING )?INDEX \S+ \(contact_id=\?\)/);

      const epLine = nest.find((l) => / ep_lc\b/.test(l));
      expect(epLine).toContain(`USING INDEX ${LOWER_ADDRESS_INDEX} (<expr>=?)`);

      expect(nest[nest.length - 1]).toContain("sqlite_autoindex_emails_1 (id=?)");
      expect(nest.join("\n")).not.toContain("idx_emails_user_sent");
    });

    it("the PHONE half drives from contact_phones and probes the cache by PK", () => {
      const nest = subqueryNest(plan(db, IMPORTED_QUERY, USER_ID), 1);
      expect(nest[0]).toContain("cp_lc");
      expect(nest[0]).toMatch(/SEARCH cp_lc USING (COVERING )?INDEX \S+ \(contact_id=\?\)/);
      expect(nest[1]).toContain("sqlite_autoindex_phone_last_message_1");
      expect(nest.join("\n")).not.toContain("idx_phone_last_msg_user");
    });
  });
});

/**
 * THE IMPORTED FRAGMENT'S `CROSS JOIN` IS REDUNDANT GIVEN THE INDEX — MEASURED,
 * AND THIS IS THE ONLY PLACE THAT FACT IS OBSERVABLE.
 *
 * Reverting the imported fragment's `CROSS JOIN`s to plain `JOIN`s does NOT turn
 * any assertion above red. That is not a gap in those assertions; it is a real
 * difference between the two fragments, and it needs to be written down rather
 * than left as an unexplained asymmetry in the source file.
 *
 * The external fragment starts at `json_each` — a virtual table with no cost
 * estimate, which the planner therefore ranks LAST no matter what. The imported
 * fragment starts at `contact_emails` constrained by `contact_id = c.id`, served
 * by a UNIQUE covering index, which the planner already recognises as a cheap and
 * selective entry point. So once `idx_email_participants_lower_address` exists,
 * the imported fragment gets the right order on its own and the pin changes
 * nothing.
 *
 * Measured at the founder's record count (1,162 contacts / 3,073 emails /
 * 9,219 participants), all four combinations:
 *
 *     index  ANALYZE  join         time      drives from
 *     ---------------------------------------------------------------
 *     no     no       JOIN       3,859 ms    emails  (THE DEFECT)
 *     no     no       CROSS      1,450 ms    contact_emails
 *     no     yes      JOIN       2,536 ms    contact_emails
 *     no     yes      CROSS      1,460 ms    contact_emails
 *     yes    no       JOIN           5.1 ms  contact_emails
 *     yes    no       CROSS          5.2 ms  contact_emails
 *     yes    yes      JOIN           4.9 ms  contact_emails
 *     yes    yes      CROSS          4.9 ms  contact_emails
 *
 * Two things follow. FIRST, the item's suspicion was right: this fragment has the
 * same defect (top row), and is cheap today only because the founder has 4
 * imported contacts rather than 1,162 — it would have surfaced the moment an
 * address book was imported. SECOND, the index alone closes it here, unlike on
 * the external path where the index alone is worth 1.0x.
 *
 * The pin is kept anyway, and this test is what stops it being unfalsifiable
 * decoration: it asserts the pin carries INDEPENDENT weight by removing the
 * index and checking the plan still refuses to fall back to the mailbox. Revert
 * the imported fragment's CROSS JOINs and this goes red; nothing else does.
 */
describe("BACKLOG-2633 — the imported fragment's pin holds even with the index gone", () => {
  let db: DatabaseType;
  let dir: string;

  beforeAll(() => {
    ({ db, dir } = makeDb({ analyze: false, emails: 1200 }));
    // Express a database that does not have the index — the regime in which the
    // pin is the only thing standing between this fragment and a whole-mailbox
    // scan per contact.
    db.exec(`DROP INDEX ${LOWER_ADDRESS_INDEX}`);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still drives from contact_emails, not from the mailbox", () => {
    const nest = subqueryNest(plan(db, IMPORTED_QUERY, USER_ID), 2);

    expect(nest[0]).toContain("ce_lc");
    // With plain JOINs and no index this line reads
    // `SEARCH em USING INDEX idx_emails_user_sent (user_id=?)` — 3,859 ms.
    expect(nest[0]).not.toContain("idx_emails_user_sent");
    expect(nest.join("\n")).not.toContain("idx_emails_user_sent");
  });

  it("the external fragment does too — for the same reason, on its own shape", () => {
    const nest = subqueryNest(plan(db, EXTERNAL_CONTACTS_GET_ALL_SQL, USER_ID), 2);
    expect(nest[0]).toContain("e_lc");
    expect(nest.join("\n")).not.toContain("idx_emails_user_sent");
  });
});

// ---------------------------------------------------------------------------
// IDENTITY — only the plan may change
// ---------------------------------------------------------------------------

/**
 * The pre-fix expression, transcribed from git history at base e1b01393 rather
 * than paraphrased. It exists so "the answer did not change" is asserted against
 * the code that actually shipped, not against a re-derivation of it.
 *
 * If this constant is ever edited to match the new one, this whole comparison
 * silently becomes a tautology. It must stay frozen.
 */
const PRE_FIX_EXPR = `
      NULLIF(
        MAX(
          COALESCE((
            SELECT MAX(plm.last_message_at)
            FROM phone_last_message plm,
                 json_each(COALESCE(external_contacts.phones_normalized_json, '[]')) AS p_lc
            WHERE plm.user_id = external_contacts.user_id
              AND plm.phone_normalized = p_lc.value
          ), ''),
          COALESCE((
            SELECT MAX(COALESCE(em.sent_at, em.received_at))
            FROM json_each(COALESCE(external_contacts.emails_json, '[]')) AS e_lc
            JOIN email_participants ep_lc
              ON LOWER(ep_lc.email_address) = LOWER(e_lc.value)
            JOIN emails em
              ON em.id = ep_lc.email_id
             AND em.user_id = external_contacts.user_id
          ), '')
        ),
        ''
      )
`;

const PRE_FIX_GET_ALL_SQL = `
  SELECT * FROM (
    SELECT id, user_id, name, phones_json, emails_json, company,
           ${PRE_FIX_EXPR} as last_message_at,
           external_record_id, source, synced_at,
           external_uuid
    FROM external_contacts
    WHERE user_id = ?
  )
  ORDER BY last_message_at IS NULL, last_message_at DESC, name ASC
`;

describe("BACKLOG-2633 — the answer is byte-identical; only the plan moved", () => {
  let db: DatabaseType;
  let dir: string;

  beforeAll(() => {
    ({ db, dir } = makeDb({ analyze: false, emails: 400 }));
  });

  afterAll(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the EXACT SAME ordered (id, last_message_at) sequence as the pre-fix query", () => {
    const shape = (sql: string) =>
      (db.prepare(sql).all(USER_ID) as Array<{ id: string; last_message_at: string | null }>).map(
        (r) => `${r.id} ${r.last_message_at ?? "<null>"}`,
      );

    const before = shape(PRE_FIX_GET_ALL_SQL);
    const after = shape(EXTERNAL_CONTACTS_GET_ALL_SQL);

    // Identity, not counts, and ORDERED — two rows swapping places is exactly
    // the failure the founder reported on the recency sort (BACKLOG-2355/2357),
    // and identical totals cannot see it.
    expect(after).toEqual(before);
    expect(after.length).toBe(306);
  });

  it("the shaped rows land where the sort says they should (NULL tail, name tiebreak)", () => {
    const rows = db.prepare(EXTERNAL_CONTACTS_GET_ALL_SQL).all(USER_ID) as Array<{
      id: string;
      name: string;
      last_message_at: string | null;
    }>;
    const at = (id: string) => rows.findIndex((r) => r.id === id);

    // Phone (iso 600) beats email-only (500) beats phone+email (MAX of 450/400).
    expect(rows[0].id).toBe("x-phone-only");
    expect(rows[1].id).toBe("x-email-only");
    expect(rows[2].id).toBe("x-both");

    // x-both takes the MAX across channels, not the email one.
    expect(rows[2].last_message_at).toBe(rows.find((r) => r.id === "x-both")!.last_message_at);
    expect(rows[2].last_message_at).toBe(new Date(Date.UTC(2024, 0, 1) + 450 * 3_600_000).toISOString());

    // The tie is broken by name ASC, which orders these OPPOSITE to their ids.
    expect(at("x-tie-b")).toBeLessThan(at("x-tie-a")); // "CASE TIE A" < "CASE TIE B"
    expect(rows[at("x-tie-b")].last_message_at).toBe(rows[at("x-tie-a")].last_message_at);
    expect(rows[at("x-tie-b")].last_message_at).not.toBeNull();

    // A contact whose address and phone appear nowhere reads NULL and sits in
    // the tail. Without `LOWER(e_lc.value)` the UPPERCASE-stored rows would land
    // here too, which is why two of the shaped rows store uppercase.
    expect(rows[rows.length - 1].id).toBe("x-neither");
    expect(rows[rows.length - 1].last_message_at).toBeNull();
    expect(rows.filter((r) => r.last_message_at === null).map((r) => r.id)).toEqual(["x-neither"]);
  });
});
