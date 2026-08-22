/**
 * @jest-environment node
 *
 * A RECORD CONTRIBUTES VALUES ONLY WHEN IT IS LINKED (BACKLOG-2669)
 *
 * ===========================================================================
 * THE FOUNDER'S TRAIL, READ OUT OF HIS DATABASE ON 12 AUG
 * ===========================================================================
 * `Wendell Marchetti` was created by hand at 23:34:51 with ONE phone number the
 * founder typed. **His only crosswalk row is `origin`** — he is linked to no
 * source record at all. By 00:03 he held four more values, every one of them
 * `source='import'`, none of them his:
 *
 *     +15035550181             manual   23:34:51   the founder typed it
 *     bianca@example.com       import   23:50:33
 *     +15035550180             import   23:54:26
 *     bea.okafor@example.net   import   00:03:08
 *     bianca.reyes@example.org import   00:03:08
 *
 * **Every proposal involving those records was still `pending`.** Nothing was
 * refused, so this was never "the copy ignores verdicts" — the copy did not wait
 * for a verdict to exist.
 *
 * ===========================================================================
 * AND IT CASCADES, WHICH IS WHY A SINGLE-HOP TEST CANNOT SEE IT
 * ===========================================================================
 * The founder's typed `0301` content-matched a Bianca record; the backfill
 * copied THAT record's email onto Wendell; the new email then content-matched
 * FURTHER records, and more values copied. Each stolen value widens the match
 * surface, which steals more.
 *
 * So the cascade controls below run TWO sweeps. One sweep proves only that hop 1
 * was closed; the defect lives in hop 2, and hop 2 is reachable only through a
 * value hop 1 stole. Both directions are covered — a fixture entering through
 * the phone branch (the founder's, transcribed) and its mirror entering through
 * the email branch — because the deleted branches were two separate pieces of
 * SQL and neither generalises to the other.
 *
 * ===========================================================================
 * WHAT IS TRANSCRIBED AND WHAT IS A FIXTURE DECISION
 * ===========================================================================
 * Transcribed: the names, the five values, the arrival order, the origin-only
 * crosswalk, the `pending` proposals, and that the founder typed `0301` himself.
 * The names are his seeded test contacts (his words: "these are test contacts,
 * so no real data is affected") and are listed in `check-fixture-pii.mjs`
 * accordingly.
 *
 * REMAPPED, and it is the only edit to his data: his two numbers ended `0301`
 * and `0300`, outside the `555-0100..555-0199` block that
 * `scripts/ci/check-fixture-pii.mjs` reserves for fictional use. That gate
 * rejected them, so they are shifted to `…0181` (the number he typed) and
 * `…0180` (the one he was never given). Nothing in the defect depends on the
 * digits; it depends on the shape, and the shape is his.
 *
 * A fixture decision: WHICH record carried `+15035550180`. His trail records the
 * value arriving at 23:54:26 from a record he was linked to; it does not say
 * which. It is attached to `805AC73C` here. Nothing asserted below depends on
 * that choice — the claims are that the value does not arrive without a link and
 * does arrive with one.
 *
 * ===========================================================================
 * EXACT SETS, AND THE QUESTION SET TOO
 * ===========================================================================
 * Every assertion names the exact set it expects. Values AND pending questions:
 * two facts depend on the question set and a values-only suite can see neither —
 * that the ask SURVIVES this change (`805AC73C` is still asked about), and that
 * a manufactured question DISAPPEARS (`BEA0001` was only ever a candidate
 * because the defect had already put a stranger's email on Wendell).
 *
 * One shape that is correct and can read as a regression: `confirmProposal` has
 * an early return when the record was claimed by another contact between the
 * question being asked and answered (`contactLinkReview.ts` `linkedElsewhere`).
 * It returns `linked:false` and copies nothing, by design.
 *
 * NEGATIVE CONTROLS RUN — see the PR body for the mutations and their output.
 */

import path from "path";
import fs from "fs";
import os from "os";
import type { Database as DatabaseType } from "better-sqlite3";

// Bypass the jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock. This suite executes real SQL and real UNIQUE constraints,
// neither of which the mock evaluates.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

jest.mock("../../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { CONTACT_IDENTITY_SCHEMA } from "../../__tests__/helpers/contactIdentitySchema";
import { setDb, setDbPath, setEncryptionKey } from "../core/dbConnection";
import { CONTACT_SOURCE_RECORDS_SQL, type ContactSourceRecordRow } from "../contactSourceLinkSql";
import { recordContactOrigin } from "../contactOriginLink";
import { backfillContactEmailsSync, backfillContactPhonesSync } from "../contactDbService";
import { listPendingProposals } from "../contactLinkReviewDbService";
import { linkExternalContactsForUser } from "../../contactSourceLinker";
import { confirmProposal } from "../../contactLinkReview";
import { toLookupKey } from "../../../utils/phoneNormalization";

const USER = "user-2669";
const CURRENT_SYNC = "2026-08-12T00:00:00.000Z";

// The founder's card, transcribed. His own number first.
const WENDELL = "contact-wendell-marchetti";
const WENDELL_OWN_PHONE = "+15035550181";
const BIANCA_REC = "805AC73C";
const BIANCA_EMAIL = "bianca@example.com";
const NEVER_TYPED_PHONE = "+15035550180";
const BEA_REC = "BEA0001";
const BEA_EMAIL = "bea.okafor@example.net";
const REYES_EMAIL = "bianca.reyes@example.org";

describe("BACKLOG-2669 — a record contributes values only when it is linked", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = new RealDatabase(":memory:") as DatabaseType;
    db.exec(CONTACT_IDENTITY_SCHEMA);
    setDb(db);
    setDbPath(":memory:");
    setEncryptionKey("test-key");
    jest.clearAllMocks();
  });

  afterEach(() => {
    setDb(null as unknown as DatabaseType);
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  // -------------------------------------------------------------------------
  // SEED HELPERS
  // -------------------------------------------------------------------------

  /** Last 10 digits — the key `toLookupKey` produces and the schema stores. */
    // BACKLOG-2630: seeds through the SHARED helper rather than a local
  // transcription of the old last-ten rule. After migration v64 no database
  // holds an old-rule key, so a fixture written that way describes a state the
  // code can no longer emit — and the probe side would never meet it.
  const lookupKey = (phone: string): string => toLookupKey(phone);

  /**
   * `is_imported = 1` because that is the population BOTH writers walk
   * (`SELECT id FROM contacts WHERE user_id = ? AND is_imported = 1`), and the
   * founder's hand-typed contact was in it — he was backfilled.
   */
  function addContact(
    id: string,
    displayName: string,
    opts: {
      emails?: string[];
      phones?: string[];
      source?: string;
      /** How the contact's OWN values were recorded. The founder typed his. */
      valueSource?: "manual" | "import";
    } = {},
  ): string {
    const valueSource = opts.valueSource ?? "manual";
    db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, 1)",
    ).run(id, USER, displayName, opts.source ?? "manual");
    (opts.emails ?? []).forEach((e, i) => {
      db.prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, ?, ?)",
      ).run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0, valueSource);
    });
    (opts.phones ?? []).forEach((p, i) => {
      db.prepare(
        `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`${id}-p${i}`, id, p, lookupKey(p), i === 0 ? 1 : 0, valueSource);
    });
    // Written by the PRODUCTION function so the fixture cannot describe a
    // crosswalk shape the app does not produce. An origin row is deliberately
    // NOT a record-backed link — it is the founder's only crosswalk row.
    recordContactOrigin(USER, id, opts.source ?? "manual");
    return id;
  }

  function addExternal(
    recordId: string,
    name: string,
    opts: { source?: string; emails?: string[]; phones?: string[] } = {},
  ): void {
    const phones = opts.phones ?? [];
    db.prepare(
      `INSERT INTO external_contacts
         (id, user_id, name, phones_json, phones_normalized_json, emails_json,
          external_record_id, source, synced_at, external_uuid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      `ext-${opts.source ?? "macos"}-${recordId}`,
      USER,
      name,
      JSON.stringify(phones),
      JSON.stringify(phones.map(lookupKey)),
      JSON.stringify(opts.emails ?? []),
      recordId,
      opts.source ?? "macos",
      CURRENT_SYNC,
    );
  }

  // -------------------------------------------------------------------------
  // THE COPY, AS THE MAIN-THREAD WRITER PERFORMS IT
  // -------------------------------------------------------------------------

  /**
   * TRANSCRIBED, NOT INVENTED — `contactHandlers.ts` (the loop at
   * `backfillImportedContactsFromExternal`, reading `CONTACT_SOURCE_RECORDS_SQL`
   * and calling `backfillContactEmails`/`backfillContactPhones` per row).
   *
   * That function is not exported and pulls in the whole handler module, so the
   * loop is reproduced here against the REAL `backfillContact*Sync` functions it
   * calls. That keeps the assertions on `contact_emails` / `contact_phones`
   * themselves — the difference between proving no value was copied and proving
   * no row was selected. The worker twin is driven for real further down.
   */
  function runBackfillCopy(contactId: string): void {
    const externals = db
      .prepare(CONTACT_SOURCE_RECORDS_SQL)
      .all({ userId: USER, contactId }) as ContactSourceRecordRow[];
    for (const external of externals) {
      const emails: string[] = external.emails_json ? JSON.parse(external.emails_json) : [];
      const phones: string[] = external.phones_json ? JSON.parse(external.phones_json) : [];
      backfillContactEmailsSync(contactId, emails);
      backfillContactPhonesSync(contactId, phones);
    }
  }

  /** The whole sweep the founder triggered: the linking pass, then the backfill. */
  function runSweep(contactIds: string[]): void {
    linkExternalContactsForUser(USER);
    for (const id of contactIds) runBackfillCopy(id);
  }

  // -------------------------------------------------------------------------
  // READ HELPERS — exact sets, and provenance where it is load-bearing
  // -------------------------------------------------------------------------

  const emailsOf = (contactId: string): string[] =>
    (
      db
        .prepare("SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY email")
        .all(contactId) as Array<{ email: string }>
    ).map((r) => r.email);

  const phonesOf = (contactId: string): string[] =>
    (
      db
        .prepare("SELECT phone_e164 FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164")
        .all(contactId) as Array<{ phone_e164: string }>
    ).map((r) => r.phone_e164);

  /** `value[source]` — the form control 5 asserts, so a relabel is visible. */
  const phonesWithSourceOf = (contactId: string): string[] =>
    (
      db
        .prepare(
          "SELECT phone_e164, source FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164",
        )
        .all(contactId) as Array<{ phone_e164: string; source: string | null }>
    ).map((r) => `${r.phone_e164}[${r.source}]`);

  const emailsWithSourceOf = (contactId: string): string[] =>
    (
      db
        .prepare("SELECT email, source FROM contact_emails WHERE contact_id = ? ORDER BY email")
        .all(contactId) as Array<{ email: string; source: string | null }>
    ).map((r) => `${r.email}[${r.source}]`);

  /** `${source_type} ${source_record_id} (${reason})` for the pending queue. */
  const questionsFor = (contactId: string): string[] =>
    listPendingProposals(USER)
      .filter((p) => p.contact_id === contactId)
      .map((p) => `${p.source_type} ${p.source_record_id} (${p.reason})`)
      .sort();

  /** The record ids the backfill would copy from, in the order it reads them. */
  const copyPlanFor = (contactId: string): string[] =>
    (
      db.prepare(CONTACT_SOURCE_RECORDS_SQL).all({ userId: USER, contactId }) as ContactSourceRecordRow[]
    ).map((r) => `${r.matched_by}:${r.external_record_id}`);

  /** Seeds the founder's contact: one hand-typed number, origin row only. */
  function seedWendell(): string {
    return addContact(WENDELL, "Wendell Marchetti", {
      phones: [WENDELL_OWN_PHONE],
      valueSource: "manual",
    });
  }

  // =========================================================================
  describe("control 1 — no link, no value; and the question still gets asked", () => {
    /**
     * Two records, one per deleted branch, asserted separately. A single-channel
     * control would leave one restored branch invisible: restoring priority 2
     * only would not touch a contact who holds no email, and restoring priority
     * 3 only would not touch one who holds no phone.
     */
    it("a PHONE-matching record it has no link to contributes nothing", () => {
      seedWendell();
      addExternal(BIANCA_REC, "Bianca Okafor", {
        phones: [WENDELL_OWN_PHONE, NEVER_TYPED_PHONE],
        emails: [BIANCA_EMAIL],
      });

      const phonesBefore = phonesOf(WENDELL);
      const emailsBefore = emailsOf(WENDELL);

      runSweep([WENDELL]);

      // Identity, not count: `0300` and `0301` differ in one digit.
      expect(phonesOf(WENDELL)).toEqual(phonesBefore);
      expect(phonesOf(WENDELL)).toEqual([WENDELL_OWN_PHONE]);
      expect(emailsOf(WENDELL)).toEqual(emailsBefore);
      expect(emailsOf(WENDELL)).toEqual([]);
      // Nothing to copy from, because nothing is linked.
      expect(copyPlanFor(WENDELL)).toEqual([]);
      // THE ASK SURVIVES. This is the half that must not move.
      expect(questionsFor(WENDELL)).toEqual([`macos ${BIANCA_REC} (name_mismatch)`]);
    });

    it("an EMAIL-matching record it has no link to contributes nothing", () => {
      const casey = addContact("contact-casey-lane", "Casey Lane", {
        emails: ["casey.lane@example.com"],
        valueSource: "manual",
      });
      addExternal("MAC-PAT", "Pat Riverton", {
        emails: ["casey.lane@example.com", "pat.riverton@example.net"],
        phones: ["+15035550150"],
      });

      runSweep([casey]);

      expect(emailsOf(casey)).toEqual(["casey.lane@example.com"]);
      expect(phonesOf(casey)).toEqual([]);
      expect(copyPlanFor(casey)).toEqual([]);
      expect(questionsFor(casey)).toEqual(["macos MAC-PAT (name_mismatch)"]);
    });
  });

  // =========================================================================
  describe("control 2 — answering 'yes, same person' DOES deliver the values", () => {
    /**
     * The leg that fails if the fix is over-broad, and the one both SR reviews
     * on PR #2291 insisted on. The path is: the linker files the question ->
     * a human confirms -> `createLink` -> `applyLinkedSourceValues` -> and from
     * then on priority 1 keeps the contact up to date.
     */
    it("delivers the whole record through priority 1 once a human confirms", () => {
      seedWendell();
      addExternal(BIANCA_REC, "Bianca Okafor", {
        phones: [WENDELL_OWN_PHONE, NEVER_TYPED_PHONE],
        emails: [BIANCA_EMAIL],
      });

      runSweep([WENDELL]);
      expect(emailsOf(WENDELL)).toEqual([]);

      const pending = listPendingProposals(USER).filter((p) => p.contact_id === WENDELL);
      expect(pending.map((p) => p.source_record_id)).toEqual([BIANCA_REC]);

      const result = confirmProposal(USER, pending[0].id);
      expect(result).toEqual({ ok: true, linked: true, alsoRejected: 0 });

      // The values arrive AT THE LINK — not at the next app start.
      expect(emailsOf(WENDELL)).toEqual([BIANCA_EMAIL]);
      expect(phonesOf(WENDELL)).toEqual([NEVER_TYPED_PHONE, WENDELL_OWN_PHONE]);
      // And the record is now reachable by priority 1, so later sweeps keep it
      // current instead of the contact being frozen out.
      expect(copyPlanFor(WENDELL)).toEqual([`source_id:${BIANCA_REC}`]);
      expect(questionsFor(WENDELL)).toEqual([]);

      // A further sweep is a no-op rather than a second helping.
      runSweep([WENDELL]);
      expect(emailsOf(WENDELL)).toEqual([BIANCA_EMAIL]);
      expect(phonesOf(WENDELL)).toEqual([NEVER_TYPED_PHONE, WENDELL_OWN_PHONE]);
    });
  });

  // =========================================================================
  describe("control 3 — the cascade, both directions, TWO sweeps each", () => {
    /**
     * THE FOUNDER'S TRAIL. Hop 1 is the PHONE branch: he holds no email at
     * sweep 1, so priority 2 cannot match him and priority 3 is what fires. Hop
     * 2 is the EMAIL branch, reachable only through the address hop 1 stole.
     *
     * A single sweep proves only that hop 1 is closed. The second sweep is the
     * assertion that there is no second hop to take — it is why this control
     * exists in this shape.
     */
    it("phone-entry: a stolen email never opens the second hop", () => {
      seedWendell();
      // Hop 1: shares the number he typed, carries an address he never saw.
      addExternal(BIANCA_REC, "Bianca Okafor", {
        phones: [WENDELL_OWN_PHONE, NEVER_TYPED_PHONE],
        emails: [BIANCA_EMAIL],
      });
      // Hop 2: shares that address, carries two more. It matches Wendell ONLY
      // through a value hop 1 would have given him.
      addExternal(BEA_REC, "Bea Okafor", {
        emails: [BIANCA_EMAIL, BEA_EMAIL, REYES_EMAIL],
      });

      runSweep([WENDELL]);
      runSweep([WENDELL]);

      expect(phonesOf(WENDELL)).toEqual([WENDELL_OWN_PHONE]);
      expect(emailsOf(WENDELL)).toEqual([]);
      expect(copyPlanFor(WENDELL)).toEqual([]);
      // The manufactured half of his queue is gone: `BEA0001` shares nothing
      // with him and is never offered. Under the defect he was asked twice.
      expect(questionsFor(WENDELL)).toEqual([`macos ${BIANCA_REC} (name_mismatch)`]);
    });

    /**
     * THE MIRROR. Entry through the EMAIL branch, second hop through the PHONE
     * branch — the same defect with the two channels swapped, so that
     * reintroducing either branch is caught by a two-hop control and not only by
     * control 1.
     */
    it("email-entry: a stolen phone never opens the second hop", () => {
      const casey = addContact("contact-casey-lane", "Casey Lane", {
        emails: ["casey.lane@example.com"],
        valueSource: "manual",
      });
      // Hop 1: shares the address she typed, carries a number she never saw.
      addExternal("MAC-PAT", "Pat Riverton", {
        emails: ["casey.lane@example.com"],
        phones: ["+15035550150"],
      });
      // Hop 2: shares THAT number, carries another.
      addExternal("MAC-LEE", "Lee Park", {
        phones: ["+15035550150", "+15035550151"],
      });

      runSweep([casey]);
      runSweep([casey]);

      expect(emailsOf(casey)).toEqual(["casey.lane@example.com"]);
      expect(phonesOf(casey)).toEqual([]);
      expect(copyPlanFor(casey)).toEqual([]);
      expect(questionsFor(casey)).toEqual(["macos MAC-PAT (name_mismatch)"]);
    });
  });

  // =========================================================================
  describe("control 5 — what the user typed is never removed or overwritten", () => {
    it("keeps the hand-typed number, and keeps it marked manual, across sweeps", () => {
      seedWendell();
      addExternal(BIANCA_REC, "Bianca Okafor", {
        phones: [WENDELL_OWN_PHONE, NEVER_TYPED_PHONE],
        emails: [BIANCA_EMAIL],
      });

      expect(phonesWithSourceOf(WENDELL)).toEqual([`${WENDELL_OWN_PHONE}[manual]`]);

      runSweep([WENDELL]);
      runSweep([WENDELL]);

      // Unchanged, and STILL `manual` — a relabel would make a future
      // source-rejection sweep treat it as an import's contribution and delete
      // it (`removeUnlinkedSourceValues` spares only non-import rows).
      expect(phonesWithSourceOf(WENDELL)).toEqual([`${WENDELL_OWN_PHONE}[manual]`]);
      expect(emailsWithSourceOf(WENDELL)).toEqual([]);

      // And confirming the question adds without relabelling what he typed.
      const pending = listPendingProposals(USER).filter((p) => p.contact_id === WENDELL);
      confirmProposal(USER, pending[0].id);
      expect(phonesWithSourceOf(WENDELL)).toEqual([
        `${NEVER_TYPED_PHONE}[import]`,
        `${WENDELL_OWN_PHONE}[manual]`,
      ]);
    });
  });

  // =========================================================================
  describe("control 6 — the freeze gate is subsumed, not dropped (BACKLOG-2664)", () => {
    /**
     * 2664 stopped the content branches at the freeze. This change deletes the
     * branches, so the frozen case is covered by the stronger rule: no contact
     * gains anything from an unlinked content match.
     *
     * The 2664 suite's own founder cases are the primary evidence and pass
     * UNMODIFIED against this query. This case is here so the frozen shape is
     * asserted alongside the unfrozen one in the suite that owns the new rule.
     */
    function freezeViaJunction(txnId: string, contactId: string): void {
      db.prepare(
        "INSERT INTO transactions (id, user_id, property_address, first_exported_at) VALUES (?, ?, ?, ?)",
      ).run(txnId, USER, "571 Dale St N", "2026-08-11T20:20:00.000Z");
      db.prepare(
        "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
      ).run(`tc-${txnId}-${contactId}`, txnId, contactId, "buyer");
    }

    it("a contact on a filed transaction gains nothing, and is still asked", () => {
      seedWendell();
      freezeViaJunction("txn-filed", WENDELL);
      addExternal(BIANCA_REC, "Bianca Okafor", {
        phones: [WENDELL_OWN_PHONE, NEVER_TYPED_PHONE],
        emails: [BIANCA_EMAIL],
      });

      runSweep([WENDELL]);
      runSweep([WENDELL]);

      expect(phonesOf(WENDELL)).toEqual([WENDELL_OWN_PHONE]);
      expect(emailsOf(WENDELL)).toEqual([]);
      // The frozen refusal is the linker's, and it is unchanged by this diff.
      expect(questionsFor(WENDELL)).toEqual([`macos ${BIANCA_REC} (frozen_audit_contact)`]);
    });
  });
});
