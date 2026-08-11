/**
 * @jest-environment node
 *
 * A REFUSED RECORD'S VALUES MUST NOT REACH A FROZEN CONTACT (BACKLOG-2664)
 *
 * ===========================================================================
 * THE FOUNDER'S CASE, AND WHAT IT IS NOT
 * ===========================================================================
 * Gate 3, 11 Aug, clean database. One Dana Whitlock record (`+1 503 555-0130`)
 * was added to a transaction. A later sweep left her contact card holding THREE
 * numbers, and the same sweep filed all three source records as `pending`
 * questions with reason `frozen_audit_contact`.
 *
 *   declined the link, asked whether they are the same person,
 *   and copied their phone numbers anyway.
 *
 * The item predicted the copy ran on the content-match branch BEFORE the frozen
 * early-return in `contactSourceLinker.resolveSourceRecord`. IT DOES NOT.
 * `applyLinkedSourceValues` is called at that function's very end, 72 lines
 * after the frozen `return`, and it reads `contact_source_links JOIN
 * external_contacts` — crosswalk rows only. With no link there is nothing for it
 * to copy, and the first describe below pins that.
 *
 * The writer is the BACKFILL:
 *   `contactHandlers.backfillImportedContactsFromExternal` (main thread) and
 *   `contactQueryWorker.runBackfillQuery` (worker), which BOTH read
 *   `CONTACT_SOURCE_RECORDS_SQL` and copy every row it returns onto the contact.
 *
 * That query's priority-2 (email) and priority-3 (phone) branches match
 * `external_contacts` BY CONTENT ALONE — no link, no name check, no verdict
 * check and, until this ticket, no freeze check. They are gated only on the
 * contact having no record-backed crosswalk row.
 *
 * ===========================================================================
 * WHY A FREEZE-BLIND QUERY SELECTS FROZEN CONTACTS SPECIFICALLY
 * ===========================================================================
 * A contact on a filed transaction can NEVER acquire a record-backed crosswalk
 * row by content matching, because `resolveSourceRecord` refuses at the
 * `frozen_audit_contact` branch and files a question instead. So the fallback
 * gate stays permanently open for her, and every sweep re-copies every
 * content-matching record — including the ones just refused. An unfrozen contact
 * converges out of the fallback the first time a link is written, which is why
 * the founder's Priya Raman, swept in the same session against three records
 * that also content-matched and were also not linked, was untouched.
 *
 * The freeze is what holds the door open, and the door is the one thing that
 * never asks about the freeze.
 *
 * ===========================================================================
 * THE FIXTURE IS THE OBSERVED END-STATE, NOT AN INVENTION
 * ===========================================================================
 * The founder's database cannot be read from here, so WHICH of the two content
 * channels carried his case (a shared email, or records that also carried her
 * own number) is not established. What IS established by his evidence is the
 * end-state, and it is what this fixture reproduces:
 *
 *   - a contact frozen to a filed transaction, holding exactly `+15035550130`;
 *   - three content-matching records, ONE OF THEM HER OWN ORIGIN RECORD — which
 *     is the tell that she had no record-backed crosswalk row at sweep time,
 *     because `resolveSourceRecord` only reaches the frozen branch after the
 *     source-id step misses;
 *   - all three refused with `frozen_audit_contact`.
 *
 * The shared-email channel is used below. The fix closes both, and the
 * `phone-matched` block exercises the other one.
 *
 * ===========================================================================
 * EXACT SETS, NEVER COUNTS
 * ===========================================================================
 * Two of the three numbers differ only in their final digit, and `toHaveLength`
 * is equally satisfied by the wrong number arriving. Every assertion below names
 * the exact set it expects.
 *
 * NEGATIVE CONTROLS RUN — see the PR body for the observed output.
 */

import path from "path";
import type { Database as DatabaseType } from "better-sqlite3";

// Bypass the jest moduleNameMapper that rewrites better-sqlite3-multiple-ciphers
// to the auto-mock. This suite executes real SQL — a multi-branch UNION, a
// json_each walk over `other_contacts`, and UNIQUE-guarded inserts — none of
// which the mock evaluates.
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
import { FROZEN_CONTACT_EXISTS_SQL } from "../frozenContactSql";
import { isContactOnFrozenTransaction } from "../frozenContactDbService";
import { recordContactOrigin } from "../contactOriginLink";
import { backfillContactEmailsSync, backfillContactPhonesSync } from "../contactDbService";
import { listPendingProposals } from "../contactLinkReviewDbService";
import { createLink } from "../contactSourceLinkDbService";
import { linkExternalContactsForUser } from "../../contactSourceLinker";
import { rejectProposal } from "../../contactLinkReview";

const USER = "user-2664";

// The founder's card, transcribed. Her own number first.
const DANA = "contact-dana-whitlock";
const DANA_EMAIL = "dana.whitlock@example.com";
const DANA_OWN_PHONE = "+15035550130";
const NEVER_SELECTED_1 = "+15035550131";
const NEVER_SELECTED_2 = "+15035550132";

// The control that isolated the defect: swept in the same session, not frozen,
// untouched.
const PRIYA = "contact-priya-raman";
const PRIYA_EMAIL = "priya.raman@example.com";
const PRIYA_OWN_PHONE = "+15035550120";
const PRIYA_SECOND_PHONE = "+15035550121";

const CURRENT_SYNC = "2026-08-11T20:30:00.000Z";

describe("BACKLOG-2664 — the copy is a consequence of the link, never a sibling of it", () => {
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
  const lookupKey = (phone: string): string => phone.replace(/\D/g, "").slice(-10);

  function addContact(
    id: string,
    displayName: string,
    opts: { emails?: string[]; phones?: string[]; source?: string } = {},
  ): string {
    db.prepare(
      "INSERT INTO contacts (id, user_id, display_name, source, is_imported) VALUES (?, ?, ?, ?, 1)",
    ).run(id, USER, displayName, opts.source ?? "contacts_app");
    (opts.emails ?? []).forEach((e, i) => {
      db.prepare(
        "INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, ?, 'import')",
      ).run(`${id}-e${i}`, id, e, i === 0 ? 1 : 0);
    });
    (opts.phones ?? []).forEach((p, i) => {
      db.prepare(
        `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized, is_primary, source)
         VALUES (?, ?, ?, ?, ?, 'import')`,
      ).run(`${id}-p${i}`, id, p, lookupKey(p), i === 0 ? 1 : 0);
    });
    // Every contact gets an origin row the moment it is created (BACKLOG-2496),
    // written here by the PRODUCTION function so the fixture cannot describe a
    // crosswalk shape the app does not produce. An origin row is deliberately
    // NOT a record-backed link, so it leaves the content fallback open.
    recordContactOrigin(USER, id, opts.source ?? "contacts_app");
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

  /** File a transaction (export it) with the contact on the junction. */
  function freezeViaJunction(txnId: string, contactId: string): void {
    db.prepare(
      "INSERT INTO transactions (id, user_id, property_address, first_exported_at) VALUES (?, ?, ?, ?)",
    ).run(txnId, USER, "571 Dale St N", "2026-08-11T20:20:00.000Z");
    db.prepare(
      "INSERT INTO transaction_contacts (id, transaction_id, contact_id, role) VALUES (?, ?, ?, ?)",
    ).run(`tc-${txnId}-${contactId}`, txnId, contactId, "buyer");
  }

  // -------------------------------------------------------------------------
  // THE COPY, AS THE TWO WRITERS PERFORM IT
  // -------------------------------------------------------------------------

  /**
   * TRANSCRIBED, NOT INVENTED — `contactHandlers.ts:866-878`, whose worker twin
   * `contactQueryWorker.ts:119-131` plans the same rows from the same string.
   *
   * `backfillImportedContactsFromExternal` is not exported and pulls in the
   * whole handler module, so the loop is reproduced here against the REAL
   * `backfillContact*Sync` functions it calls. That keeps the assertions on
   * `contact_phones` / `contact_emails` themselves rather than on a query
   * result, which is the difference between proving no value was copied and
   * proving no row was selected.
   */
  function runBackfillCopy(contactId: string): { emailsAdded: number; phonesAdded: number } {
    const externals = db
      .prepare(CONTACT_SOURCE_RECORDS_SQL)
      .all({ userId: USER, contactId }) as ContactSourceRecordRow[];

    let emailsAdded = 0;
    let phonesAdded = 0;
    for (const external of externals) {
      const emails: string[] = external.emails_json ? JSON.parse(external.emails_json) : [];
      const phones: string[] = external.phones_json ? JSON.parse(external.phones_json) : [];
      emailsAdded += backfillContactEmailsSync(contactId, emails);
      phonesAdded += backfillContactPhonesSync(contactId, phones);
    }
    return { emailsAdded, phonesAdded };
  }

  /**
   * The whole sweep the founder triggered: the linking pass, then the backfill.
   *
   * Order is not load-bearing for this defect — the backfill's content fallback
   * reads no state the linker writes when the linker refuses — but running both
   * is what makes "declined the link AND copied the values" one observation
   * rather than two.
   */
  function runSweep(contactIds: string[]): void {
    linkExternalContactsForUser(USER);
    for (const id of contactIds) runBackfillCopy(id);
  }

  // -------------------------------------------------------------------------
  // READ HELPERS — exact sets
  // -------------------------------------------------------------------------

  const phonesOf = (contactId: string): string[] =>
    (
      db
        .prepare("SELECT phone_e164 FROM contact_phones WHERE contact_id = ? ORDER BY phone_e164")
        .all(contactId) as Array<{ phone_e164: string }>
    ).map((r) => r.phone_e164);

  const emailsOf = (contactId: string): string[] =>
    (
      db
        .prepare("SELECT email FROM contact_emails WHERE contact_id = ? ORDER BY email")
        .all(contactId) as Array<{ email: string }>
    ).map((r) => r.email);

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

  const linkedRecordsOf = (contactId: string): string[] =>
    (
      db
        .prepare(
          `SELECT source_type, source_record_id, match_method FROM contact_source_links
            WHERE contact_id = ? ORDER BY source_type, source_record_id`,
        )
        .all(contactId) as Array<{
        source_type: string;
        source_record_id: string;
        match_method: string;
      }>
    ).map((l) => `${l.source_type} ${l.source_record_id} (${l.match_method})`);

  // =========================================================================
  describe("the founder's case — frozen contact, three refused records", () => {
    /**
     * Her own record (`0130`) is in the fixture and in the queue, exactly as the
     * founder found it. Its presence is what proves she held no record-backed
     * crosswalk row: the source-id step would have claimed it otherwise, and the
     * frozen branch is only reachable after that step misses.
     */
    function seedDana(): void {
      addContact(DANA, "Dana Whitlock", { emails: [DANA_EMAIL], phones: [DANA_OWN_PHONE] });
      freezeViaJunction("txn-dana", DANA);

      addExternal("rec-0130", "Dana Whitlock", {
        source: "macos",
        emails: [DANA_EMAIL],
        phones: ["+1 (503) 555-0130"],
      });
      addExternal("rec-0131", "Dana Whitlock", {
        source: "macos",
        emails: [DANA_EMAIL],
        phones: ["+1 (503) 555-0131"],
      });
      addExternal("rec-0132", "Dana Whitlock", {
        source: "outlook",
        emails: [DANA_EMAIL],
        phones: ["+1 (503) 555-0132"],
      });
    }

    /**
     * CONTROL 1. The whole ticket.
     *
     * NEGATIVE CONTROL RUN: with the freeze gate absent from
     * `CONTACT_SOURCE_RECORDS_SQL` this fails on the PHONE EXACT SET —
     * `+15035550131` and `+15035550132` present — not on the link or the
     * question count, which pass either way. See the PR body for the output.
     */
    it("files three questions and copies NOTHING onto her", () => {
      seedDana();
      const before = phonesOf(DANA);

      runSweep([DANA]);

      // Refused, and refused for the stated reason.
      expect(questionsFor(DANA)).toEqual([
        "macos rec-0130 (frozen_audit_contact)",
        "macos rec-0131 (frozen_audit_contact)",
        "outlook rec-0132 (frozen_audit_contact)",
      ]);
      // No link was created — she keeps only the origin row she was made with.
      expect(linkedRecordsOf(DANA)).toEqual([`macos origin:${DANA} (origin)`]);

      // THE ASSERTION THIS TICKET IS ABOUT.
      expect(phonesOf(DANA)).toEqual([DANA_OWN_PHONE]);
      expect(phonesOf(DANA)).toEqual(before);
      expect(emailsOf(DANA)).toEqual([DANA_EMAIL]);
      // The exact set above is the guarantee. This names the two numbers it is
      // guarding against, so a failure says which of them arrived — they differ
      // from hers only in the final digit.
      expect(phonesOf(DANA)).toEqual(
        expect.not.arrayContaining([NEVER_SELECTED_1, NEVER_SELECTED_2]),
      );

      // And the plan the two backfill writers share selects nothing for her.
      expect(copyPlanFor(DANA)).toEqual([]);
    });

    /**
     * CONTROL 2. Answering "different people" must leave her exactly as she was.
     *
     * This is why the defect is worse than a silent link: the values arrived
     * attached to nothing, so no unlink path can find them and no answer removes
     * them. The guarantee is that there is nothing to remove.
     */
    it("leaves her values exactly as they were after answering 'different people'", () => {
      seedDana();
      runSweep([DANA]);

      const pending = listPendingProposals(USER).filter((p) => p.contact_id === DANA);
      expect(pending.map((p) => p.source_record_id).sort()).toEqual([
        "rec-0130",
        "rec-0131",
        "rec-0132",
      ]);
      for (const proposal of pending) {
        expect(rejectProposal(USER, proposal.id)).toEqual({
          ok: true,
          linked: false,
          alsoRejected: 0,
        });
      }

      // A second sweep, as the next sync would run it.
      runSweep([DANA]);

      expect(phonesOf(DANA)).toEqual([DANA_OWN_PHONE]);
      expect(emailsOf(DANA)).toEqual([DANA_EMAIL]);
      expect(linkedRecordsOf(DANA)).toEqual([`macos origin:${DANA} (origin)`]);
    });

    /**
     * The OTHER content channel. The founder's records each printed one phone,
     * so priority-3 (shared phone) may not be what carried his case — but it is
     * the same freeze-blind fallback and it must be closed too.
     */
    it("copies nothing through the phone fallback either", () => {
      addContact(DANA, "Dana Whitlock", { phones: [DANA_OWN_PHONE] });
      freezeViaJunction("txn-dana", DANA);
      // One record carrying her number AND a second one she never approved.
      addExternal("rec-pair", "Dana Whitlock", {
        source: "macos",
        phones: ["+1 (503) 555-0130", "+1 (503) 555-0131"],
      });

      runSweep([DANA]);

      expect(questionsFor(DANA)).toEqual(["macos rec-pair (frozen_audit_contact)"]);
      expect(phonesOf(DANA)).toEqual([DANA_OWN_PHONE]);
      expect(copyPlanFor(DANA)).toEqual([]);
    });
  });

  // =========================================================================
  describe("the positive control — an unfrozen contact still links AND copies", () => {
    /**
     * CONTROL 3, AND THE REASON THE FIX IS A GATE RATHER THAN A DELETION.
     *
     * A fix that simply stopped copying would pass control 1 and silently break
     * the feature for everyone. Priya is the founder's own fixture for the
     * difference: same sweep, same kind of records, not frozen.
     *
     * NEGATIVE CONTROL RUN, AND IT DID NOT GO RED — recorded because the reason
     * is the useful part. Gating priority 1 as well leaves this test green: her
     * copy comes from `applyLinkedSourceValues`, which the linker calls at the
     * link and which reads its own crosswalk query, not this one. So this test
     * proves "an unfrozen contact links AND copies" and defends nothing about
     * priority 1. The test below is what defends priority 1.
     */
    it("links the agreeing record and takes its values", () => {
      addContact(PRIYA, "Priya Raman", { emails: [PRIYA_EMAIL], phones: [PRIYA_OWN_PHONE] });
      addExternal("rec-0120", "Priya Raman", {
        source: "macos",
        emails: [PRIYA_EMAIL],
        phones: ["+1 (503) 555-0120", "+1 (503) 555-0121"],
      });

      runSweep([PRIYA]);

      expect(linkedRecordsOf(PRIYA)).toEqual([
        `macos origin:${PRIYA} (origin)`,
        "macos rec-0120 (email)",
      ]);
      // The copy followed the link — which is the rule, stated positively.
      expect(phonesOf(PRIYA)).toEqual([PRIYA_OWN_PHONE, PRIYA_SECOND_PHONE]);
      expect(questionsFor(PRIYA)).toEqual([]);
    });

    /**
     * PRIORITY 1 IS NOT GATED, AND THIS IS WHAT SAYS SO.
     *
     * The rule is "the copy is a consequence of the link", not "frozen contacts
     * receive nothing". A record the crosswalk claims has been agreed to — by
     * the user picking it at import, by confirming a question, or by linking a
     * source by hand — and its values must keep reaching the contact afterwards,
     * frozen or not. Refusing them would be a different defect wearing this
     * ticket's clothes, and until this test existed nothing here objected to it.
     *
     * NEGATIVE CONTROL RUN: adding the freeze gate to priority 1 as well fails
     * this on the phone exact set — `+15035550133` never arrives.
     */
    it("still copies from a LINKED record onto a FROZEN contact", () => {
      addContact(DANA, "Dana Whitlock", { emails: [DANA_EMAIL], phones: [DANA_OWN_PHONE] });
      freezeViaJunction("txn-dana", DANA);
      // Her own record, and it has since grown a second number.
      addExternal("rec-0130", "Dana Whitlock", {
        source: "macos",
        emails: [DANA_EMAIL],
        phones: ["+1 (503) 555-0130", "+1 (503) 555-0133"],
      });
      // The user's own choice of record, as `linkImportedContact` records it.
      createLink({
        userId: USER,
        contactId: DANA,
        sourceType: "macos",
        sourceRecordId: "rec-0130",
        matchMethod: "source_id",
      });

      runSweep([DANA]);

      expect(copyPlanFor(DANA)).toEqual(["source_id:rec-0130"]);
      expect(phonesOf(DANA)).toEqual([DANA_OWN_PHONE, "+15035550133"]);
      // Nothing was asked: the record was already claimed by the source-id step.
      expect(questionsFor(DANA)).toEqual([]);
    });

    /**
     * The legacy self-heal, preserved. An unfrozen contact with no record-backed
     * link still resolves through the content fallback — that is what carries a
     * pre-crosswalk contact's addresses, and the narrowing comment on this item
     * says not to restructure it.
     *
     * IT ALSO DOCUMENTS THE RESIDUAL: this record was REFUSED (the names
     * disagree) and its second number is copied anyway. Same rule broken, for an
     * unfrozen contact. Out of scope here — flagged on the item.
     */
    it("still resolves an unfrozen contact by content, even from a refused record", () => {
      // Two people sharing an office line, so the names disagree and the linker
      // refuses. BOTH NAMES ARE FROM `FICTIONAL_NAMES` in
      // `scripts/ci/check-fixture-pii.mjs`: this repository is public, and a
      // name beside a number is the identity-row shape that guard exists to
      // catch. It caught this line on its first run, against a name that was
      // not on that list — see the PR body.
      const robin = addContact("contact-robin-marsh", "Robin Marsh", {
        phones: ["+15035550140"],
      });
      addExternal("rec-office", "Pat Riverton", {
        source: "macos",
        phones: ["+1 (503) 555-0140", "+1 (503) 555-0141"],
      });

      runSweep([robin]);

      expect(questionsFor(robin)).toEqual(["macos rec-office (name_mismatch)"]);
      expect(copyPlanFor(robin)).toEqual(["phone:rec-office"]);
      expect(phonesOf(robin)).toEqual(["+15035550140", "+15035550141"]);
    });
  });

  // =========================================================================
  describe("parity — the SQL gate and isContactOnFrozenTransaction agree", () => {
    /**
     * The gate inside the query and the TypeScript predicate are built from ONE
     * constant, and this is what keeps that true: a second hand-written copy
     * would answer differently on exactly the shapes nobody remembers to copy —
     * the direct FK columns and the `other_contacts` JSON array.
     *
     * NEGATIVE CONTROL RUN: reduced the fragment's three-way body to the
     * junction check alone. Observed 1 failed / 7 passed, on
     * `[true, true, true]` receiving `[true, false, false]` — the FK and JSON
     * rows.
     *
     * AND NOTE WHICH ASSERTION CAUGHT IT. The agreement loop DID NOT FAIL, and
     * cannot: both sides are built from the one constant, so mutating it moves
     * them together and they keep agreeing — about the wrong answer. Only the
     * absolute expectations below it go red. A parity test over a shared
     * constant needs both halves, and the equality half is the weaker one.
     */
    const sqlSaysFrozen = (contactId: string): boolean =>
      db.prepare(`SELECT 1 AS hit WHERE ${FROZEN_CONTACT_EXISTS_SQL}`).get({ contactId }) !==
      undefined;

    function seedTransaction(
      id: string,
      opts: { exported: boolean; buyerAgentId?: string; otherContacts?: string[] },
    ): void {
      db.prepare(
        `INSERT INTO transactions (id, user_id, property_address, first_exported_at,
                                   buyer_agent_id, other_contacts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        USER,
        `${id} address`,
        opts.exported ? "2026-08-11T20:20:00.000Z" : null,
        opts.buyerAgentId ?? null,
        opts.otherContacts ? JSON.stringify(opts.otherContacts) : null,
      );
    }

    it("agrees on all three ways a contact reaches an exported transaction", () => {
      const byJunction = addContact("c-junction", "Junction Party");
      const byColumn = addContact("c-column", "Column Party");
      const byJson = addContact("c-json", "Json Party");
      const unfiled = addContact("c-unfiled", "Unfiled Party");
      const unrelated = addContact("c-unrelated", "Unrelated Party");

      freezeViaJunction("txn-junction", byJunction);
      seedTransaction("txn-column", { exported: true, buyerAgentId: byColumn });
      seedTransaction("txn-json", { exported: true, otherContacts: [byJson] });
      // Present on a transaction that has NOT been exported: not frozen.
      seedTransaction("txn-open", { exported: false, buyerAgentId: unfiled });

      for (const id of [byJunction, byColumn, byJson, unfiled, unrelated]) {
        expect(`${id}:${sqlSaysFrozen(id)}`).toBe(`${id}:${isContactOnFrozenTransaction(id)}`);
      }

      // And the answers themselves, so a fragment that returned a constant
      // could not satisfy the parity check above.
      expect([byJunction, byColumn, byJson].map(isContactOnFrozenTransaction)).toEqual([
        true,
        true,
        true,
      ]);
      expect([unfiled, unrelated].map(isContactOnFrozenTransaction)).toEqual([false, false]);
    });

    /**
     * BACKLOG-2366 — a removed party's details still went out in the filed
     * audit, so the freeze survives their removal. Pinned here because the gate
     * now depends on it too: filtering `removed_at` would re-open the copy path
     * for anyone taken off a filed deal.
     */
    it("keeps the freeze after a party is removed from the filed transaction", () => {
      const removed = addContact("c-removed", "Removed Party");
      freezeViaJunction("txn-removed", removed);
      db.prepare("UPDATE transaction_contacts SET removed_at = ? WHERE contact_id = ?").run(
        "2026-08-11T21:00:00.000Z",
        removed,
      );

      expect(isContactOnFrozenTransaction(removed)).toBe(true);
      expect(sqlSaysFrozen(removed)).toBe(true);
    });
  });
});
