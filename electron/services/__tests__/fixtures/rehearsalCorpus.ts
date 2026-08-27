/**
 * @file The corpus seeded into the shipped-v2.27.0 rehearsal fixture, and the
 *       exact identities the rehearsal asserts survive the upgrade.
 *
 * Shared by:
 *   - `buildV2270Fixture.gen.ts` (the generator — writes the rows)
 *   - `databaseService.migrationChainRehearsal.test.ts` (asserts they survive)
 *
 * ===========================================================================
 * IDENTITY, NOT COUNTS
 * ===========================================================================
 * Every expectation below is an exact SET of ids. A row count cannot tell
 * "3 contacts survived" apart from "2 survived and a migration invented one",
 * and the failure mode this rehearsal exists to catch — a table rebuild that
 * copies columns positionally, or drops rows it could not map — is exactly the
 * kind that holds the count while changing the contents.
 *
 * ===========================================================================
 * WHY THE CORPUS LOOKS LIKE THIS
 * ===========================================================================
 * Each element is here because a migration in 56..62 touches it:
 *   - contacts from FIVE distinct `source` values, so v57's contact_source_links
 *     crosswalk and v60/v61's origin-vocabulary rebuild have more than one kind
 *     of row to classify. A single-source corpus would let a migration that
 *     collapses provenance pass.
 *   - contact_emails / contact_phones on overlapping but not identical contacts,
 *     so a join that silently inner-joins loses rows visibly.
 *   - TWO transactions with DIFFERENT, non-overlapping party sets, so a rebuild
 *     that cross-joins parties onto the wrong transaction is caught. A single
 *     transaction could not detect that.
 *   - ONE FROZEN (exported) transaction with `first_exported_at` set and one
 *     never-exported. The freeze stamp is write-once (BACKLOG-2013); a migration
 *     that rebuilds `transactions` positionally could shift it onto the wrong
 *     row or clear it, and an audit export would then be silently re-openable.
 *   - emails from both providers, one of which carries the columns v62's
 *     `bulk_mail_headers` sits beside.
 *   - text messages on both `sms` and `imessage`, one linked to a transaction.
 *   - external_contacts rows, which v58 alters.
 *
 * The SQL is plain INSERT rather than a service call on purpose: the SCHEMA is
 * what must come from the app's real init path (and it does — see the
 * generator), while the ROWS need to be pinned to exact literal ids so the
 * assertions can name them.
 */

/** `schema_version` of the shipped build the fixture represents (v2.27.0). */
export const EXPECTED_SHIPPED_VERSION = 55;

export const USER_ID = "u-2700-rehearsal";

/**
 * Every seeded contact id, with the `source` it was created under and — for the
 * BACKLOG-2859 rows — the `default_role` it carries.
 *
 * FAY / GUS / HAL / IVY EXIST TO MAKE MIGRATION v68 NON-VACUOUS. (BACKLOG-2859's
 * migration is 66 on its own branch, PR #2381, and was renumbered to 68 when it
 * landed on int/ui-polish-e behind 2814's 66 and 2857's 67.) Before they
 * were added, the shipped v2.27.0 corpus contained exactly two role values in
 * `transaction_contacts` (`buyer_agent` and `seller_agent`) and nothing else —
 * so four of v68's six operations matched ZERO ROWS and the rehearsal passed
 * while proving almost nothing about them. An UPDATE that matches nothing
 * succeeds; so does a DELETE. Each of the four covers a branch that had no
 * input:
 *
 *   fay  `listing_agent`                 the third legacy agent value
 *   gus  `buyer`  on the LISTING          a counterparty principal to delete
 *   hal  `seller` on the SALE             the other counterparty principal
 *   ivy  non-NULL `specific_role`         the second collapsed column — every
 *                                         pre-existing row has specific_role NULL
 *
 * fay also carries `default_role = 'seller_agent'`, the only input to the
 * `contacts.default_role` collapse. Sweep the branches, do not sample them.
 */
export const CONTACTS: ReadonlyArray<{
  id: string;
  source: string;
  default_role?: string;
}> = [
  { id: "c-2700-outlook-ann", source: "outlook" },
  { id: "c-2700-iphone-ben", source: "iphone" },
  { id: "c-2700-google-cara", source: "google_contacts" },
  { id: "c-2700-manual-dan", source: "manual" },
  { id: "c-2700-inferred-eve", source: "inferred" },
  { id: "c-2700-legacy-fay", source: "manual", default_role: "seller_agent" },
  { id: "c-2700-principal-gus", source: "manual", default_role: "buyer" },
  { id: "c-2700-principal-hal", source: "manual", default_role: "inspector" },
  { id: "c-2700-specific-ivy", source: "manual", default_role: "buyer_agent" },
];

export const CONTACT_IDS: readonly string[] = CONTACTS.map((c) => c.id);

export const TRANSACTION_OPEN = "t-2700-open";
export const TRANSACTION_FROZEN = "t-2700-frozen";
export const TRANSACTION_IDS: readonly string[] = [TRANSACTION_OPEN, TRANSACTION_FROZEN];

/**
 * The party set per transaction. Disjoint by construction: a rebuild that
 * cross-joined parties onto the wrong transaction would show up here and
 * nowhere else.
 */
/**
 * The party set per transaction AS SEEDED — before the chain runs.
 *
 * Distinct from PARTIES_BY_TRANSACTION below because migration v68 removes two
 * of these. The precondition test reads the fixture BEFORE the chain and must
 * assert what is actually on disk; post-chain assertions read the survivor set.
 * Collapsing the two would make the precondition tautological with the outcome.
 */
export const PARTIES_BY_TRANSACTION_SEEDED: Readonly<Record<string, readonly string[]>> = {
  [TRANSACTION_OPEN]: [
    "c-2700-outlook-ann",
    "c-2700-iphone-ben",
    "c-2700-legacy-fay",
    "c-2700-principal-gus",
  ],
  [TRANSACTION_FROZEN]: [
    "c-2700-google-cara",
    "c-2700-manual-dan",
    "c-2700-inferred-eve",
    "c-2700-principal-hal",
    "c-2700-specific-ivy",
  ],
};

export const PARTIES_BY_TRANSACTION: Readonly<Record<string, readonly string[]>> = {
  // gus and hal are ABSENT BY DESIGN, not by omission: migration v68 deletes
  // their assignments (see TRANSACTION_CONTACTS_REMOVED_BY_V68). This set is
  // what the chain leaves behind, and it is still an exact set — the assertion
  // was narrowed to name the two removals individually, never relaxed to a
  // count.
  [TRANSACTION_OPEN]: ["c-2700-outlook-ann", "c-2700-iphone-ben", "c-2700-legacy-fay"],
  [TRANSACTION_FROZEN]: [
    "c-2700-google-cara",
    "c-2700-manual-dan",
    "c-2700-inferred-eve",
    "c-2700-specific-ivy",
  ],
};

/** The freeze stamps on the exported transaction. Write-once (BACKLOG-2013). */
export const FROZEN_EXPORT_STAMPS = {
  id: TRANSACTION_FROZEN,
  first_exported_at: "2026-03-04 17:20:11",
  last_exported_at: "2026-05-19 09:02:44",
  export_status: "exported",
  export_format: "pdf",
  export_count: 2,
} as const;

export const EMAIL_IDS: readonly string[] = ["e-2700-gmail-1", "e-2700-outlook-1", "e-2700-gmail-2"];

export const MESSAGE_IDS: readonly string[] = ["m-2700-sms-1", "m-2700-imessage-1", "m-2700-sms-2"];

export const EXTERNAL_CONTACT_IDS: readonly string[] = ["x-2700-ext-1", "x-2700-ext-2"];

/**
 * Child-row identities. These matter as much as the parent ids: `id` on these
 * three tables is `TEXT PRIMARY KEY`, and a rebuild that regenerated ids — or
 * that wrote NULLs — would preserve every row count and every parent id while
 * destroying the identity the app links against.
 */
export const CONTACT_EMAIL_IDS: readonly string[] = [
  "ce-2700-ann",
  "ce-2700-cara",
  "ce-2700-dan-primary",
  "ce-2700-dan-alt",
];

export const CONTACT_PHONE_IDS: readonly string[] = [
  "cp-2700-ben",
  "cp-2700-dan",
  "cp-2700-eve",
];

/**
 * The transaction_contacts rows migration v68 DELETES — the counterparty
 * principals (BACKLOG-2859, founder-approved silent drop).
 *
 * Named individually and asserted as their own set. That is the point: the
 * survivor set below could have been made green by deleting the assertion or by
 * swapping it for a row count, and either would have hidden a migration that
 * deleted the wrong rows. Two exact sets that partition the seed cannot.
 */
export const TRANSACTION_CONTACTS_REMOVED_BY_V68: readonly string[] = [
  "tc-2700-open-gus",
  "tc-2700-frozen-hal",
];

/** Every transaction_contacts row SEEDED, before the chain runs. */
export const TRANSACTION_CONTACT_IDS_SEEDED: readonly string[] = [
  "tc-2700-open-ann",
  "tc-2700-open-ben",
  "tc-2700-open-fay",
  "tc-2700-open-gus",
  "tc-2700-frozen-cara",
  "tc-2700-frozen-dan",
  "tc-2700-frozen-eve",
  "tc-2700-frozen-hal",
  "tc-2700-frozen-ivy",
];

/** The rows that SURVIVE the chain: everything seeded, minus the v68 deletions. */
export const TRANSACTION_CONTACT_IDS: readonly string[] =
  TRANSACTION_CONTACT_IDS_SEEDED.filter(
    (id) => !TRANSACTION_CONTACTS_REMOVED_BY_V68.includes(id),
  );

/**
 * The exact role each surviving row holds AFTER the chain — the structural
 * probe for migration v68, in the style of the existing `v56 applied:` /
 * `v62 applied:` tests.
 *
 * Asserted by id so it cannot be satisfied by the right number of rows carrying
 * the wrong roles. Drop v68 from the chain and all four collapsed rows go red
 * at once.
 */
export const TRANSACTION_CONTACT_ROLES_AFTER_V68: Readonly<Record<string, string>> = {
  "tc-2700-open-ann": "agent", // was buyer_agent
  "tc-2700-open-ben": "inspector", // untouched — proves the collapse is narrow
  "tc-2700-open-fay": "agent", // was listing_agent
  "tc-2700-frozen-cara": "agent", // was seller_agent
  "tc-2700-frozen-dan": "escrow_officer", // untouched
  "tc-2700-frozen-eve": "other", // untouched
  "tc-2700-frozen-ivy": "agent", // was buyer_agent, in BOTH columns
};

/** `contacts.default_role` after the chain, by contact id (BACKLOG-2859). */
export const CONTACT_DEFAULT_ROLES_AFTER_V68: Readonly<Record<string, string | null>> = {
  "c-2700-outlook-ann": null,
  "c-2700-iphone-ben": null,
  "c-2700-google-cara": null,
  "c-2700-manual-dan": null,
  "c-2700-inferred-eve": null,
  "c-2700-legacy-fay": "agent", // was seller_agent — collapsed
  // `buyer`/`seller` default_roles are deliberately NOT migrated: unlike an
  // assignment row, a default_role that is no longer offered degrades safely to
  // the `client` baseline. Pinned so "left alone" is a tested decision.
  "c-2700-principal-gus": "buyer",
  "c-2700-principal-hal": "inspector",
  "c-2700-specific-ivy": "agent", // was buyer_agent — collapsed
};

/**
 * Per-table row counts, asserted ALONGSIDE the id sets (never instead of them).
 * These cover the tables whose ids are not individually enumerated above.
 */
export const EXPECTED_ROW_COUNTS: Readonly<Record<string, number>> = {
  users_local: 1,
  contacts: 9,
  contact_emails: 4,
  contact_phones: 3,
  transactions: 2,
  // 9 seeded minus the 2 counterparty-principal assignments v68 removes.
  // Asserted ALONGSIDE the id sets, never instead of them.
  transaction_contacts: 7,
  emails: 3,
  messages: 3,
  external_contacts: 2,
};

const q = (v: string | number | null): string =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replace(/'/g, "''")}'`;

/**
 * The seed statements, in FK-safe order: the user row first (contacts and
 * transactions reference it), then contacts, then everything that references a
 * contact.
 */
export const SEED_STATEMENTS: readonly string[] = [
  // --- root user -----------------------------------------------------------
  `INSERT INTO users_local (id, email, oauth_provider, oauth_id, first_name, last_name, display_name, license_type, created_at, updated_at)
   VALUES (${q(USER_ID)}, 'rehearsal@example.test', 'microsoft', 'oauth-2700', 'Rehearsal', 'User', 'Rehearsal User', 'individual', '2026-01-01 08:00:00', '2026-01-01 08:00:00')`,

  // --- contacts, five distinct sources -------------------------------------
  ...CONTACTS.map(
    (c, i) =>
      `INSERT INTO contacts (id, user_id, display_name, company, source, default_role, is_imported, total_messages, created_at, updated_at)
       VALUES (${q(c.id)}, ${q(USER_ID)}, ${q(`Contact ${c.id.split("-").pop()}`)}, ${q(`Firm ${i + 1}`)}, ${q(c.source)}, ${q(c.default_role ?? null)}, ${c.source === "manual" ? 0 : 1}, ${i * 3}, '2026-01-1${i} 08:00:00', '2026-02-1${i} 08:00:00')`,
  ),

  // --- contact_emails: ann, cara, dan (dan has two) ------------------------
  //
  // Ids are supplied EXPLICITLY. `id` here is `TEXT PRIMARY KEY`, and SQLite
  // permits NULL in a non-INTEGER primary key — so omitting it silently writes
  // a row with no identity at all, which the real app never does and which
  // would make the id-set assertions below vacuous.
  `INSERT INTO contact_emails (id, contact_id, email, is_primary, label, source, created_at) VALUES ('ce-2700-ann', 'c-2700-outlook-ann', 'ann@example.test', 1, 'work', 'import', '2026-01-20 08:00:00')`,
  `INSERT INTO contact_emails (id, contact_id, email, is_primary, label, source, created_at) VALUES ('ce-2700-cara', 'c-2700-google-cara', 'cara@example.test', 1, 'home', 'import', '2026-01-20 08:00:00')`,
  `INSERT INTO contact_emails (id, contact_id, email, is_primary, label, source, created_at) VALUES ('ce-2700-dan-primary', 'c-2700-manual-dan', 'dan@example.test', 1, 'work', 'manual', '2026-01-20 08:00:00')`,
  `INSERT INTO contact_emails (id, contact_id, email, is_primary, label, source, created_at) VALUES ('ce-2700-dan-alt', 'c-2700-manual-dan', 'dan.alt@example.test', 0, 'other', 'manual', '2026-01-20 08:00:00')`,

  // --- contact_phones: ben, dan, eve ---------------------------------------
  `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, is_primary, label, source, created_at) VALUES ('cp-2700-ben', 'c-2700-iphone-ben', '+14155550102', '(415) 555-0102', 1, 'mobile', 'import', '2026-01-21 08:00:00')`,
  `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, is_primary, label, source, created_at) VALUES ('cp-2700-dan', 'c-2700-manual-dan', '+14155550104', '(415) 555-0104', 1, 'mobile', 'manual', '2026-01-21 08:00:00')`,
  `INSERT INTO contact_phones (id, contact_id, phone_e164, phone_display, is_primary, label, source, created_at) VALUES ('cp-2700-eve', 'c-2700-inferred-eve', '+14155550105', '(415) 555-0105', 1, 'mobile', 'inferred', '2026-01-21 08:00:00')`,

  // --- transactions: one live, one FROZEN ----------------------------------
  `INSERT INTO transactions (id, user_id, property_address, property_city, property_state, transaction_type, status, export_status, export_count, message_count, created_at, updated_at)
   VALUES (${q(TRANSACTION_OPEN)}, ${q(USER_ID)}, '100 Live Street', 'Seattle', 'WA', 'purchase', 'active', 'not_exported', 0, 2, '2026-01-05 09:00:00', '2026-02-05 09:00:00')`,
  `INSERT INTO transactions (id, user_id, property_address, property_city, property_state, transaction_type, status, export_status, export_format, export_count, first_exported_at, last_exported_at, closed_at, message_count, created_at, updated_at)
   VALUES (${q(TRANSACTION_FROZEN)}, ${q(USER_ID)}, '200 Frozen Avenue', 'Tacoma', 'WA', 'sale', 'closed', ${q(FROZEN_EXPORT_STAMPS.export_status)}, ${q(FROZEN_EXPORT_STAMPS.export_format)}, ${FROZEN_EXPORT_STAMPS.export_count}, ${q(FROZEN_EXPORT_STAMPS.first_exported_at)}, ${q(FROZEN_EXPORT_STAMPS.last_exported_at)}, '2026-03-01 12:00:00', 1, '2026-01-02 09:00:00', '2026-03-04 17:20:11')`,

  // --- parties: disjoint sets ----------------------------------------------
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at, updated_at) VALUES ('tc-2700-open-ann', 't-2700-open', 'c-2700-outlook-ann', 'buyer_agent', 1, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at, updated_at) VALUES ('tc-2700-open-ben', 't-2700-open', 'c-2700-iphone-ben', 'inspector', 0, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at, updated_at) VALUES ('tc-2700-frozen-cara', 't-2700-frozen', 'c-2700-google-cara', 'seller_agent', 1, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at, updated_at) VALUES ('tc-2700-frozen-dan', 't-2700-frozen', 'c-2700-manual-dan', 'escrow_officer', 0, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at, updated_at) VALUES ('tc-2700-frozen-eve', 't-2700-frozen', 'c-2700-inferred-eve', 'other', 0, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,

  // --- BACKLOG-2859 inputs: the branches the shipped corpus never covered ---
  // t-2700-open is a `purchase` (a Listing), t-2700-frozen is a `sale`, so gus
  // and hal are the counterparty principal on each side respectively.
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at, updated_at) VALUES ('tc-2700-open-fay', 't-2700-open', 'c-2700-legacy-fay', 'listing_agent', 0, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at, updated_at) VALUES ('tc-2700-open-gus', 't-2700-open', 'c-2700-principal-gus', 'buyer', 0, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, is_primary, created_at, updated_at) VALUES ('tc-2700-frozen-hal', 't-2700-frozen', 'c-2700-principal-hal', 'seller', 0, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,
  // specific_role is the canonical column when present, and is NULL on every
  // pre-existing row — so without ivy the specific_role UPDATE never runs.
  `INSERT INTO transaction_contacts (id, transaction_id, contact_id, role, specific_role, is_primary, created_at, updated_at) VALUES ('tc-2700-frozen-ivy', 't-2700-frozen', 'c-2700-specific-ivy', 'buyer_agent', 'buyer_agent', 0, '2026-01-22 08:00:00', '2026-01-22 08:00:00')`,

  // --- emails, both providers ----------------------------------------------
  `INSERT INTO emails (id, user_id, external_id, source, account_id, direction, subject, body_plain, sender, recipients, thread_id, sent_at, message_id_header, ingest_source, created_at, updated_at)
   VALUES ('e-2700-gmail-1', ${q(USER_ID)}, 'ext-g-1', 'gmail', 'acct-g', 'inbound', 'Inspection scheduled', 'Body one', 'ann@example.test', '["rehearsal@example.test"]', 'thr-1', '2026-02-01 10:00:00', '<g1@example.test>', 'filter', '2026-02-10 08:00:00', '2026-02-10 08:00:00')`,
  `INSERT INTO emails (id, user_id, external_id, source, account_id, direction, subject, body_plain, sender, recipients, thread_id, sent_at, message_id_header, ingest_source, created_at, updated_at)
   VALUES ('e-2700-outlook-1', ${q(USER_ID)}, 'ext-o-1', 'outlook', 'acct-o', 'outbound', 'Closing docs', 'Body two', 'rehearsal@example.test', '["cara@example.test"]', 'thr-2', '2026-02-02 11:00:00', '<o1@example.test>', 'search_validated', '2026-02-10 08:00:00', '2026-02-10 08:00:00')`,
  `INSERT INTO emails (id, user_id, external_id, source, account_id, direction, subject, body_plain, sender, recipients, thread_id, sent_at, message_id_header, ingest_source, created_at, updated_at)
   VALUES ('e-2700-gmail-2', ${q(USER_ID)}, 'ext-g-2', 'gmail', 'acct-g', 'inbound', 'Re: Inspection scheduled', 'Body three', 'dan@example.test', '["rehearsal@example.test"]', 'thr-1', '2026-02-03 12:00:00', '<g2@example.test>', 'legacy', '2026-02-10 08:00:00', '2026-02-10 08:00:00')`,

  // --- text messages, one linked to the live transaction -------------------
  `INSERT INTO messages (id, user_id, external_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at, transaction_id, message_type, content_hash, created_at)
   VALUES ('m-2700-sms-1', ${q(USER_ID)}, 'msg-ext-1', 'sms', 'inbound', 'On my way to the walkthrough', '["+14155550102"]', '+14155550102', 'sms-thr-1', '2026-02-04 13:00:00', 't-2700-open', 'text', 'hash-m1', '2026-02-11 08:00:00')`,
  `INSERT INTO messages (id, user_id, external_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at, transaction_id, message_type, content_hash, created_at)
   VALUES ('m-2700-imessage-1', ${q(USER_ID)}, 'msg-ext-2', 'imessage', 'outbound', 'Thanks, see you there', '["+14155550104"]', '+14155550104', 'sms-thr-2', '2026-02-05 14:00:00', NULL, 'text', 'hash-m2', '2026-02-11 08:00:00')`,
  `INSERT INTO messages (id, user_id, external_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at, transaction_id, message_type, content_hash, created_at)
   VALUES ('m-2700-sms-2', ${q(USER_ID)}, 'msg-ext-3', 'sms', 'inbound', 'Sending the signed addendum', '["+14155550105"]', '+14155550105', 'sms-thr-3', '2026-02-06 15:00:00', NULL, 'attachment_only', 'hash-m3', '2026-02-11 08:00:00')`,

  // --- external contacts (v58 alters this table) ---------------------------
  `INSERT INTO external_contacts (id, user_id, name, phones_json, emails_json, company, source, external_record_id, synced_at)
   VALUES ('x-2700-ext-1', ${q(USER_ID)}, 'External Fran', '["+14155550106"]', '["fran@example.test"]', 'Firm X', 'iphone', 'ab-rec-1', '2026-02-12 08:00:00')`,
  `INSERT INTO external_contacts (id, user_id, name, phones_json, emails_json, company, source, external_record_id, synced_at)
   VALUES ('x-2700-ext-2', ${q(USER_ID)}, 'External Gus', '["+14155550107"]', '["gus@example.test"]', 'Firm Y', 'outlook', 'ab-rec-2', '2026-02-12 08:00:00')`,
];
