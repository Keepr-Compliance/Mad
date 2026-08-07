/**
 * The compare screen's columns — every record a contact is assembled from, side
 * by side, READ-ONLY (BACKLOG-2471 PR C)
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE FILE FROM `contactProvenance.ts`
 * ===========================================================================
 * `getContactProvenance` exists to EXCLUDE origin rows, in SQL, and its docblock
 * explains at length why: its two callers both want "records I could detach",
 * and counting origin rows opened the Sources panel on ordinary single-address-
 * book contacts listing "Mac address book" twice.
 *
 * This reader wants the opposite — the saved contact is column 1, and the row
 * that says where the contact came from is what labels it. Putting a filter and
 * its negation in one module is how the next person breaks both, so the filter
 * over there is NOT relaxed and this reader states its own rule.
 *
 * ===========================================================================
 * THE ONE THING THIS FILE MUST NEVER DO
 * ===========================================================================
 * WRITE. PR C is the read-only half of the compare screen: no verdict, no link,
 * no value copy, no tombstone. `Unlink` and `Confirm` arrive in PR D and are
 * the reason `linkId` is carried out to the renderer. If a write appears in
 * this file, that is the bug.
 */

import { dbAll, dbGet, dbTransaction } from "./db/core/dbConnection";
import {
  getContactEmailEntries,
  getContactPhoneEntries,
  getTransactionsByContact,
} from "./db/contactDbService";
import {
  hasMustLink,
  listPendingProposals,
  recordVerdict,
  resolveProposal,
} from "./db/contactLinkReviewDbService";
import type { ExternalContactSource } from "./db/externalContactDbService";
import type {
  ContactLinkSourceType,
  ContactMatchMethod,
} from "./db/contactSourceLinkDbService";
import { ORIGIN_MATCH_METHOD } from "./db/contactIdentitySchemaSql";
import { matchMethodDescription, sourceLabel } from "./contactLinkEvidence";
import { dedupeEmailValues, dedupePhoneValues } from "../utils/contactValueDedup";
import { toLookupKey } from "../utils/phoneNormalization";
import { phonesMatch } from "./messageMatchingService";
import { isReactionRow } from "../utils/reactionUtils";
import logService from "./logService";

/** How many communications each column shows. The mock draws two and one. */
const RECENT_COMMUNICATION_LIMIT = 3;

/** One email or text, as a column shows it. Headers only — never a body. */
export interface CompareCommItem {
  id: string;
  channel: "email" | "text";
  /** Subject for an email; the first line of the body for a text. */
  title: string;
  occurredAt: string | null;
  /** The address or number of THIS column that the message reached. */
  matchedIdentifier: string | null;
}

/**
 * One value, and whether another column carries it too.
 *
 * `matched` IS DECIDED HERE, NOT IN THE RENDERER, and that is a boundary rule
 * rather than a preference: the keys are `toLookupKey` (last ten digits) and
 * lower-cased trim, both of which live in `electron/`. A renderer cannot import
 * them — `src/` may not value-import from `electron/` — so a renderer that
 * marked values would have to re-implement the comparison, and two
 * implementations of "the same number" is precisely how the Sources panel and
 * the value backfill would come to disagree about what a phone number is.
 */
export interface CompareValue {
  value: string;
  matched: boolean;
}

export interface ContactCompareColumn {
  /**
   * The crosswalk row id. One identifier, not two: it is this column's test id
   * here and the target `contacts:unlink-source` already takes in PR D.
   */
  linkId: string;
  /**
   * `"proposed"` is the review queue's candidate — a record that is NOT linked
   * yet (BACKLOG-2502). It is deliberately a third value rather than a flag on
   * `"source"`, because two shipped behaviours are already gated on
   * `kind === "source"` and both are correct to withhold here: PR D's `Unlink`
   * (there is nothing to unlink) and PR C's "linked record" tag (it is not one).
   * Adding the value gets both right with no new conditionals.
   */
  kind: "contact" | "source" | "proposed";
  /** "Mac address book", "Added by you". Never assembled in the renderer. */
  columnLabel: string;
  /** `null` when the record carries no name — the cell then reads "none". */
  name: CompareValue | null;
  /** Kept plain for the header and the reason sentence. */
  displayName: string | null;
  emails: CompareValue[];
  phones: CompareValue[];
  company: string | null;
  /** Kind "source" is ALWAYS empty — a source record has no transactions. */
  transactions: string[];
  recentCommunication: CompareCommItem[];
  /** False when the crosswalk row outlived its `external_contacts` row. */
  sourceRecordPresent: boolean;
}

export interface ContactCompareView {
  contactId: string;
  /** "Is this the same Paul Dorian?" */
  title: string;
  /** Why these records were joined, in words. Never a score. */
  reason: string;
  /** `[0]` is always the contact. */
  columns: ContactCompareColumn[];
  /**
   * True when EVERY column carries the same name. Distinct from the per-value
   * `matched` flag on `name`: with three columns reading "Paul Dorian", "Paul
   * Dorian" and "Paul J. Dorian", the first two are marked (the value is on two
   * columns) while this is false (they are not all the same) — which is why the
   * sentence does not claim the names match.
   */
  namesMatch: boolean;
  /**
   * Has the user said, in as many words, that these records are one person?
   * (BACKLOG-2471 PR D)
   *
   * True when EVERY non-origin link carries a latest `same_person` verdict —
   * links, not columns. The `source_id` row column 1 absorbed has no column of
   * its own and still counts, because absorption is a RENDERING decision about
   * where a row appears, not a statement that the row is not a link. Confirming
   * only what is on screen would leave this permanently false.
   *
   * PR F routes on this. NOTE FOR PR F: this is a single-contact field, and a
   * list needs a SET. Reading it per row would be one pass over the crosswalk
   * per contact per render; the shape to add there is a set-based reader beside
   * `getRejectedSourceKeys`, which already windows latest-verdict-per-pair in
   * one query.
   */
  isConfirmed: boolean;
}

/** What a `Confirm` press actually did. (BACKLOG-2471 PR D) */
export interface ConfirmSourcesOutcome {
  ok: boolean;
  error?: string;
  /** Links given a fresh `same_person` verdict by this call. */
  confirmed: number;
  /** Links that already carried one — skipped, so the call is idempotent. */
  alreadyConfirmed: number;
  /**
   * Pending review-queue proposals retired by this call.
   *
   * Counted from `resolveProposal`'s RETURN VALUE, never from the number of
   * rows we intended to touch: a proposal answered from the queue in another
   * window between the read and the write must not be reported as resolved
   * here. `confirmProposal` gates its own side effects the same way.
   */
  proposalsResolved: number;
  /**
   * BACKLOG-2502 — did a LINK actually get created?
   *
   * Only meaningful on the proposal route. `confirmProposal` returns
   * `ok: true, linked: false` when the record is already claimed by a different
   * contact: the verdict stands, no link is made, and the sibling rejection is
   * skipped. A caller that reads `ok` alone tells the user two records were
   * joined when they were not. `undefined` on the contact route, where every
   * link already exists.
   */
  linked?: boolean;
}

interface LinkRow {
  id: string;
  source_type: ContactLinkSourceType;
  source_record_id: string;
  match_method: ContactMatchMethod;
  matched_at: string | null;
  ec_id: string | null;
  ec_name: string | null;
  ec_emails_json: string | null;
  ec_phones_json: string | null;
  ec_company: string | null;
}

const emailKey = (email: string): string => email.trim().toLowerCase();
const phoneKey = (phone: string): string => toLookupKey(phone);
const nameKey = (name: string): string =>
  name.trim().replace(/\s+/g, " ").toLowerCase();

function parseValueArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "")
      : [];
  } catch {
    return [];
  }
}

/**
 * What to write under a column's name.
 *
 * `sourceLabel` is used verbatim for record-backed columns even though the mock
 * draws the shorter "Outlook" where the shipped vocabulary says "Outlook
 * contacts". ONE VOCABULARY BEATS A DRAWING: the Sources panel two clicks away
 * already uses these words, and a second set of source names is how two screens
 * start disagreeing about what the user's address book is called.
 *
 * The origin-only types are the exception, and only because `sourceLabel`
 * phrases them possessive-ready for a sentence ("contacts you added yourself"),
 * which is not a column header. `matchMethodDescription` is the sentence form
 * and stays where it is — this is the two-word form of the same fact.
 */
function columnLabelFor(
  sourceType: ContactLinkSourceType,
  matchMethod: ContactMatchMethod,
): string {
  if (matchMethod === ORIGIN_MATCH_METHOD) {
    switch (sourceType) {
      case "manual":
        return "Added by you";
      case "email":
      case "inferred":
        return "Found in your email";
      case "sms":
        return "Found in your text messages";
      default:
        return sourceLabel(sourceType);
    }
  }
  return sourceLabel(sourceType);
}

/** The first line of a text, for a row that has no subject. */
function firstLine(body: string | null): string {
  const line = (body ?? "").split("\n").find((l) => l.trim().length > 0);
  if (!line) return "";
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}

interface AddressBundle {
  emails: string[];
  phones: string[];
}

/**
 * Every column's recent communication, in ONE pass over each table.
 *
 * ===========================================================================
 * THE FINDING THIS RESTS ON
 * ===========================================================================
 * The app never finds a contact's messages BY CONTACT ID. It finds them by
 * ADDRESS VALUE — `getEmailsForContact` matches `email_participants.email_address`
 * against the contact's own addresses, and `getMessagesForContact` scans
 * `messages.participants_flat`. So "this source record's OWN messages" is the
 * same match path with the record's `emails_json` / `phones_json` in place of
 * the contact's. No new join, no schema change.
 *
 * ===========================================================================
 * WHY NOT CALL `getEmailsForContact` / `getMessagesForContact`
 * ===========================================================================
 * They hydrate a full `Communication` — `body_html` and `body_plain` for EVERY
 * matching email — and they do not cap. This screen renders three header lines
 * per column. Reusing them would push megabytes across IPC for nine lines, once
 * per column. The match path is reused; the projection deliberately is not.
 *
 * A message can land in more than one column's bucket. That is correct: it
 * reached both records, and that overlap is the fact the user is judging.
 */
function loadCommunications(
  userId: string,
  bundles: AddressBundle[],
): CompareCommItem[][] {
  const buckets: CompareCommItem[][] = bundles.map(() => []);

  // ---- emails -------------------------------------------------------------
  const emailKeysByBundle = bundles.map((b) => new Set(b.emails.map(emailKey)));
  const allEmailKeys = [...new Set(emailKeysByBundle.flatMap((s) => [...s]))];
  if (allEmailKeys.length > 0) {
    const placeholders = allEmailKeys.map(() => "?").join(", ");
    const rows = dbAll<{
      id: string;
      subject: string | null;
      sent_at: string | null;
      received_at: string | null;
      addr: string;
    }>(
      `SELECT e.id, e.subject, e.sent_at, e.received_at,
              LOWER(TRIM(ep.email_address)) AS addr
         FROM email_participants ep
         JOIN emails e ON e.id = ep.email_id
        WHERE e.user_id = ?
          AND LOWER(TRIM(ep.email_address)) IN (${placeholders})`,
      [userId, ...allEmailKeys],
    );
    rows.forEach((r) => {
      emailKeysByBundle.forEach((keys, i) => {
        if (!keys.has(r.addr)) return;
        buckets[i].push({
          id: r.id,
          channel: "email",
          title: r.subject?.trim() || "(no subject)",
          occurredAt: r.sent_at ?? r.received_at,
          matchedIdentifier: r.addr,
        });
      });
    });
  }

  // ---- texts --------------------------------------------------------------
  const phonesByBundle = bundles.map((b) => b.phones.filter((p) => p.trim() !== ""));
  if (phonesByBundle.some((p) => p.length > 0)) {
    const rows = dbAll<{
      id: string;
      subject: string | null;
      body_text: string | null;
      participants_flat: string | null;
      sent_at: string | null;
      received_at: string | null;
      associated_message_type: number | null;
    }>(
      `SELECT m.id, m.subject, m.body_text, m.participants_flat, m.sent_at,
              m.received_at, m.associated_message_type
         FROM messages m
        WHERE m.user_id = ?
          AND m.channel IN ('sms', 'imessage')
          AND m.duplicate_of IS NULL`,
      [userId],
    );
    rows.forEach((r) => {
      // BACKLOG-2280: tapbacks ride along on this query. They are not messages
      // anyone wants to read as "recent communication".
      if (isReactionRow(r)) return;
      const tokens = (r.participants_flat || "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      if (tokens.length === 0) return;
      phonesByBundle.forEach((phones, i) => {
        const hit = phones.find((p) => tokens.some((t) => phonesMatch(p, t)));
        if (!hit) return;
        buckets[i].push({
          id: r.id,
          channel: "text",
          title: r.subject?.trim() || firstLine(r.body_text),
          occurredAt: r.sent_at ?? r.received_at,
          matchedIdentifier: hit,
        });
      });
    });
  }

  // Newest first, deduped by id, capped. `""` sorts last, which is where a row
  // with neither timestamp belongs.
  return buckets.map((items) => {
    const seen = new Set<string>();
    return items
      .filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)))
      .sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""))
      .slice(0, RECENT_COMMUNICATION_LIMIT);
  });
}

/**
 * The reason sentence.
 *
 * `summaryForReason` CANNOT be reused: it takes a `LinkProposalReason` and
 * exists for a withheld PROPOSAL. These records are already linked, so there is
 * no proposal and no reason code — the sentence is derived from what the columns
 * actually share.
 *
 * IDENTIFIERS ARE SHOWN IN FULL HERE, AND `maskEmail` / `maskPhone` ARE
 * DELIBERATELY NOT USED. A future reader who knows those helpers exist will
 * read this as an oversight and "fix" it, so: masking exists for the review
 * queue, which the docblock on `contactLinkEvidence.ts` describes as "a screen
 * the user may have open while sharing their display". THIS screen prints the
 * same address in full, in every column, two rows below this sentence — that is
 * its entire job. Masking it here would hide nothing and would leave the
 * sentence unable to name the value the user is being asked to check.
 */
function buildReason(
  columns: ContactCompareColumn[],
  sharedPhone: string | null,
  sharedEmail: string | null,
  namesMatch: boolean,
  fallbackMethod: { method: ContactMatchMethod; source: ContactLinkSourceType } | null,
): string {
  const count = columns.length;
  const countWord =
    ["", "", "Both", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"][
      count
    ] ?? String(count);

  let shared: string | null = null;
  if (sharedPhone) {
    shared =
      count === 2
        ? `Both records list the phone number ${sharedPhone}`
        : `${countWord} records share the phone number ${sharedPhone}`;
  } else if (sharedEmail) {
    shared =
      count === 2
        ? `Both records list the email address ${sharedEmail}`
        : `${countWord} records share the email address ${sharedEmail}`;
  }

  if (shared) return namesMatch ? `${shared}, and the names match.` : `${shared}.`;
  if (namesMatch) return "The names match.";
  if (fallbackMethod) {
    return `${matchMethodDescription(fallbackMethod.method, fallbackMethod.source)}.`;
  }
  return "These records are linked to one contact.";
}

/**
 * Every column the compare screen shows, or `null` when there is nothing to
 * compare.
 *
 * ===========================================================================
 * WHICH LINKS BECOME COLUMNS — the question `contactSourceAffordances.ts`
 * explicitly left to this build
 * ===========================================================================
 * THE CONTACT IS ALWAYS COLUMN 1, AND IT ABSORBS ONE `source_id` ROW — the
 * record it was created FROM. Every other non-origin link is its own column.
 *
 * Column 1's VALUES are always the contact's own. The absorbed row supplies only
 * a label, and the `origin` row supplies it in preference when there is one
 * (origin rows are filtered out of the source set in SQL upstream, so they never
 * competed for a column).
 *
 * The consequence is the cheap way to check the rule, and it is asserted by
 * test rather than by this comment:
 *
 *   `Compare sources` is visible exactly when `showSourcesPanel(sourceList)` is
 *   true — the predicate that already gates the Sources panel.
 *
 * THAT EQUIVALENCE HOLDS ONLY BECAUSE `getContactProvenance` FILTERS ORIGIN IN
 * SQL, so the renderer's `sourceList` never contains an origin row. If that
 * filter is ever relaxed, `showSourcesPanel` starts counting a row this reader
 * absorbs, the two sides drift, and the button appears on contacts with nothing
 * to compare. The premise is load-bearing; it is not incidental.
 *
 * Why not the two alternatives:
 *   - "attached records only" makes a collapsed import (two `source_id` rows
 *     from one pick, BACKLOG-2458) unreachable — the exact two-record contact
 *     the wrong-merge screen exists for.
 *   - "every non-origin link" draws the address book the contact came from
 *     twice: once as column 1's label, once as its own column.
 *
 * ===========================================================================
 * A RECORD CANNOT BE HELD TWICE, SO `sourceRecordPresent` IS THE COMPLETE SET
 * ===========================================================================
 * `contact_source_links` carries `UNIQUE (user_id, source_type,
 * source_record_id)` (`contactIdentitySchemaSql.ts`), so a source record is
 * claimed by at most one contact — there is no state where a record is both
 * held by a removed contact and live on another. The only partial state is a
 * crosswalk row that outlived its `external_contacts` row, which is why the
 * join below is a LEFT JOIN and why that column still renders, marked absent.
 */
export async function getContactCompareColumns(
  userId: string,
  contactId: string,
  /**
   * BACKLOG-2502 — the review queue's candidate, rendered as one more column.
   *
   * It has NO crosswalk row, so the query below cannot reach it at all: it is
   * read straight from `external_contacts`. Absent for every other caller, and
   * absent means the view is exactly what PR C/D returned.
   */
  proposedSource?: { sourceType: string; sourceRecordId: string },
): Promise<ContactCompareView | null> {
  const contact = dbGet<{
    user_id: string;
    display_name: string | null;
    company: string | null;
    removed_at: string | null;
  }>(
    `SELECT user_id, display_name, company, removed_at FROM contacts WHERE id = ?`,
    [contactId],
  );
  // The tombstone guard is stated HERE rather than inherited. `getContactById`
  // deliberately still returns removed contacts, and `getContactProvenance`
  // never joins `contacts` at all — so nothing upstream stops a removed contact
  // reaching this screen (BACKLOG-2410 R4).
  if (!contact || contact.user_id !== userId || contact.removed_at) return null;

  // `getContactProvenance`'s query, minus the origin exclusion, plus the value
  // columns the columns need. LEFT JOIN for the same reason it uses one.
  const links = dbAll<LinkRow>(
    `SELECT l.id, l.source_type, l.source_record_id, l.match_method, l.matched_at,
            ec.id AS ec_id, ec.name AS ec_name, ec.emails_json AS ec_emails_json,
            ec.phones_json AS ec_phones_json, ec.company AS ec_company
       FROM contact_source_links l
       LEFT JOIN external_contacts ec
         ON ec.user_id = l.user_id
        AND ec.source = l.source_type
        AND ec.external_record_id = l.source_record_id
      WHERE l.user_id = ? AND l.contact_id = ?
      ORDER BY l.source_type, l.source_record_id`,
    [userId, contactId],
  );

  const originRow = links.find((l) => l.match_method === ORIGIN_MATCH_METHOD) ?? null;
  const nonOrigin = links.filter((l) => l.match_method !== ORIGIN_MATCH_METHOD);

  // WHAT THE CONTACT'S COLUMN ABSORBS FROM THE SOURCE SET IS ONE `source_id`
  // ROW — not the origin row, which never competed for a column in the first
  // place (it is filtered out of `sourceList` too, in SQL).
  //
  // An imported contact carries BOTH: an origin row saying where it came from,
  // and a `source_id` row for the card it was made from. Absorbing only the
  // origin row drew that address book TWICE — once as column 1's label and once
  // as its own column, values identical — which is the "Mac address book listed
  // twice" noise `getContactProvenance`'s filter exists to prevent. Caught by
  // the enumeration test, not by reading.
  //
  // WHICH `source_id` ROW, WHEN THERE ARE TWO: the first in the query's own
  // order (`source_type, source_record_id`), which is also the order the columns
  // render in. NOT the earliest `matched_at`, which was the first thing I wrote
  // and is not an order at all here — `matched_at` defaults to CURRENT_TIMESTAMP
  // at one-second granularity, and a collapsed import (BACKLOG-2458) writes both
  // rows inside the same second, so the tie fell through to a random UUID and
  // the absorbed record changed between runs. A nondeterministic column set is
  // worse than an arbitrary one: the same contact would compare differently on
  // two openings.
  const absorbedSourceId =
    nonOrigin.find((l) => l.match_method === "source_id") ?? null;

  /** Which row LABELS column 1. The origin row says it best when there is one. */
  const labelRow = originRow ?? absorbedSourceId;

  const sourceRows = nonOrigin.filter((l) => l.id !== absorbedSourceId?.id);

  /*
    BACKLOG-2502 R1 — THE CANDIDATE IS READ BEFORE THE GUARD, BECAUSE THE GUARD
    COUNTS COLUMNS THE VIEW WILL RENDER.

    Founder, 7 Aug: clicking Compare on a Possible-duplicates row landed on
    "this contact has only one record, so there is nothing to compare" — and it
    landed there for exactly the contacts the review queue is about. A contact
    proposed as a duplicate usually has ONE source record; that is WHY an
    unlinked external record looked like a match. Counting `sourceRows` alone
    discarded the candidate before it was ever appended (~60 lines below), so
    Compare worked only on contacts that already had two or more linked records
    — never on the ones being reviewed.

    The lookup therefore moves ABOVE the guard rather than the guard moving
    below the append: the guard must know whether the candidate column will
    actually RENDER, and it renders only if the record still exists. A
    `proposedSource` pointing at a vanished record is still a one-column view
    and must still return null — which is why this counts `proposedRecord`, not
    `proposedSource`.
  */
  const proposedRecord = proposedSource
    ? dbGet<{
        name: string | null;
        emails_json: string | null;
        phones_json: string | null;
        company: string | null;
      }>(
        `SELECT name, emails_json, phones_json, company
           FROM external_contacts
          WHERE user_id = ? AND source = ? AND external_record_id = ?`,
        [userId, proposedSource.sourceType, proposedSource.sourceRecordId],
      ) ?? null
    : null;

  // Column 1 is the contact itself and always renders, so a comparison needs
  // exactly one more: an attached source row, or the queue's candidate. Zero
  // means a genuinely empty view, and that still returns null.
  if (sourceRows.length + (proposedRecord ? 1 : 0) === 0) return null;

  const contactEmails = getContactEmailEntries(contactId).map((e) => e.email);
  const contactPhones = getContactPhoneEntries(contactId).map((p) => p.phone);
  const transactions = await getTransactionsByContact(contactId);

  // Raw values first, marks second — a value cannot know whether it is shared
  // until every column has been read.
  interface RawColumn {
    linkId: string;
    kind: ContactCompareColumn["kind"];
    columnLabel: string;
    displayName: string | null;
    emails: string[];
    phones: string[];
    company: string | null;
    transactions: string[];
    sourceRecordPresent: boolean;
  }
  const raw: RawColumn[] = [
    {
      linkId: labelRow?.id ?? `contact:${contactId}`,
      kind: "contact" as const,
      columnLabel: labelRow
        ? columnLabelFor(labelRow.source_type, labelRow.match_method)
        : "Your contact",
      displayName: contact.display_name?.trim() || null,
      emails: dedupeEmailValues(contactEmails),
      phones: dedupePhoneValues(contactPhones),
      company: contact.company?.trim() || null,
      transactions: transactions.map((t) => t.property_address).filter((a): a is string => !!a),
      sourceRecordPresent: true,
    },
    ...sourceRows.map((r) => ({
      linkId: r.id,
      kind: "source" as const,
      columnLabel: columnLabelFor(r.source_type, r.match_method),
      displayName: r.ec_name?.trim() || null,
      emails: dedupeEmailValues(parseValueArray(r.ec_emails_json)),
      phones: dedupePhoneValues(parseValueArray(r.ec_phones_json)),
      company: r.ec_company?.trim() || null,
      // A source record has no transactions of its own — only the saved contact
      // does. FOUNDER DECISION D5: the cell says so in words rather than sitting
      // empty, and the renderer owns that string.
      transactions: [] as string[],
      sourceRecordPresent: !!r.ec_id,
    })),
  ];

  /*
    BACKLOG-2502 — the candidate, appended as the last column.

    Read straight from `external_contacts`: it has no crosswalk row, so the
    query above cannot reach it. Keyed `proposed:<type>:<record>` because there
    is no `linkId` to key it by, and that shape cannot collide with a UUID.

    A MISSING RECORD YIELDS NO COLUMN RATHER THAN A BLANK ONE. It cannot happen
    through the queue — `PENDING_JOIN` inner-joins `external_contacts` — so a
    miss here means a stale renderer, and an empty column would invite a
    decision about a record that is not there.
  */
  if (proposedSource && proposedRecord) {
    raw.push({
      linkId: `proposed:${proposedSource.sourceType}:${proposedSource.sourceRecordId}`,
      kind: "proposed" as const,
      columnLabel: sourceLabel(proposedSource.sourceType as ContactLinkSourceType),
      displayName: proposedRecord.name?.trim() || null,
      emails: dedupeEmailValues(parseValueArray(proposedRecord.emails_json)),
      phones: dedupePhoneValues(parseValueArray(proposedRecord.phones_json)),
      company: proposedRecord.company?.trim() || null,
      transactions: [] as string[],
      sourceRecordPresent: true,
    });
  }

  // A value is MARKED when it appears on two or more columns, by the same keys
  // the rest of the system compares values with — `emailKey`/`phoneKey` in
  // `contactSourceValues.ts`, and what `contact_phones.phone_normalized` is
  // built from. Two places must not mean two different things by "same value".
  //
  // The name is marked the SAME way rather than only when all columns agree:
  // with "Paul Dorian", "Paul Dorian" and "Paul J. Dorian" the first two are
  // the match the founder asked to see highlighted, and requiring unanimity
  // would mark none of them.
  const sharedKeys = (pick: (c: (typeof raw)[number]) => string[], key: (v: string) => string) => {
    const seen = new Map<string, number>();
    raw.forEach((col) => {
      new Set(pick(col).map(key).filter((k) => k !== "")).forEach((k) =>
        seen.set(k, (seen.get(k) ?? 0) + 1),
      );
    });
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  };

  const sharedEmailKeys = sharedKeys((c) => c.emails, emailKey);
  const sharedPhoneKeys = sharedKeys((c) => c.phones, phoneKey);
  const sharedNameKeys = sharedKeys((c) => (c.displayName ? [c.displayName] : []), nameKey);

  const mark = (values: string[], keys: Set<string>, key: (v: string) => string): CompareValue[] =>
    values.map((value) => ({ value, matched: keys.has(key(value)) }));

  const comms = loadCommunications(
    userId,
    raw.map((c) => ({ emails: c.emails, phones: c.phones })),
  );

  const columns: ContactCompareColumn[] = raw.map((c, i) => ({
    linkId: c.linkId,
    kind: c.kind,
    columnLabel: c.columnLabel,
    displayName: c.displayName,
    name: c.displayName
      ? { value: c.displayName, matched: sharedNameKeys.has(nameKey(c.displayName)) }
      : null,
    emails: mark(c.emails, sharedEmailKeys, emailKey),
    phones: mark(c.phones, sharedPhoneKeys, phoneKey),
    company: c.company,
    transactions: c.transactions,
    recentCommunication: comms[i],
    sourceRecordPresent: c.sourceRecordPresent,
  }));

  const names = raw.map((c) => nameKey(c.displayName ?? ""));
  const namesMatch = names.every((n) => n !== "" && n === names[0]);

  const firstShared = (
    pick: (c: (typeof raw)[number]) => string[],
    key: (v: string) => string,
    keys: Set<string>,
  ): string | null => {
    for (const col of raw) {
      const hit = pick(col).find((v) => keys.has(key(v)));
      if (hit) return hit;
    }
    return null;
  };

  const fallback = sourceRows[0]
    ? { method: sourceRows[0].match_method, source: sourceRows[0].source_type }
    : null;

  // Over LINKS, not columns — `nonOrigin`, which includes the row column 1
  // absorbed. See the field's docblock; confirming only the rendered columns
  // would make this unreachable.
  const isConfirmed = nonOrigin.every((l) =>
    hasMustLink(userId, contactId, l.source_type as ExternalContactSource, l.source_record_id),
  );

  return {
    contactId,
    isConfirmed,
    title: `Is this the same ${contact.display_name?.trim() || "person"}?`,
    reason: buildReason(
      columns,
      firstShared((c) => c.phones, phoneKey, sharedPhoneKeys),
      firstShared((c) => c.emails, emailKey, sharedEmailKeys),
      namesMatch,
      fallback,
    ),
    columns,
    namesMatch,
  };
}

/**
 * "Yes — these records are all this person." (BACKLOG-2471 PR D)
 *
 * ===========================================================================
 * ONE VERDICT PER NON-ORIGIN LINK, NOT PER COLUMN
 * ===========================================================================
 * PR C's column rule absorbs one `source_id` row into the contact's own column,
 * so that row has NO column of its own. Confirming only what is on screen is the
 * intuitive reading and it is wrong: `isConfirmed` quantifies over LINKS, so the
 * absorbed row would never carry a verdict, the contact would read unconfirmed
 * forever, and once PR F lands the screen would re-open on every click. The user
 * would press this button and nothing would change.
 *
 * The set written is exactly the set `getContactProvenance` returns.
 *
 * ORIGIN ROWS NEVER GET A VERDICT. `contact_link_verdicts.source_type` admits
 * only the five external sources, and `RecordVerdictInput.sourceType` is typed
 * `ExternalContactSource`, so the compiler refuses the origin vocabulary
 * (`manual | email | sms | inferred`) before SQLite's CHECK does.
 *
 * ===========================================================================
 * A VERDICT ALONE DOES NOT TAKE THE QUESTION OFF THE QUEUE
 * ===========================================================================
 * THIS IS THE PART THAT LOOKS FINISHED WHEN IT IS NOT.
 *
 * `PENDING_JOIN` (contactLinkReview.ts) selects on `p.status = 'pending'` and
 * nothing else — it reads neither `contact_link_verdicts` nor
 * `contact_source_links`. So writing `same_person` leaves any pending proposal
 * for that pair exactly where it was, and "Review N possible duplicates" does
 * not move. Every unit test about verdicts would still pass.
 *
 * So this also RESOLVES the pending proposals for the pairs it confirms. Only
 * `resolveProposal` — the link already exists, so `confirmProposal`'s other work
 * (create the link, apply the source values) would be a no-op and must not run.
 *
 * A pending proposal CAN exist for an already-linked pair, by ordering alone:
 * `resolveSourceRecord` step 1 resolves by existing link and will not propose
 * for one, but a proposal written on an earlier sync survives a link made
 * afterwards. That is the case this button meets.
 *
 * Matching is BY PAIR, never by producer or cluster key — `proposeLink` has two
 * production callers, `resolveSourceRecord` AND `fileNameQuestion` (the
 * unique-exact-name rule, which writes `cluster_key: name:<name>`). Filtering to
 * `record:%` would silently leave every name-rule question standing.
 *
 * ===========================================================================
 * TRANSACTIONAL, AND CI CANNOT TELL YOU SO
 * ===========================================================================
 * `writeAtomicity.guard.test.ts` (BACKLOG-2530) scans `DB_DIR =
 * electron/services/db`. This is a COMPOSITION service, alongside
 * `contactLinkReview.ts` and `contactProvenance.ts`, and sits outside that scan
 * by the same deliberate layering — a guard's directory constant must not
 * dictate architecture (SR ruling, BACKLOG-2426; the standing gap is
 * BACKLOG-2584).
 *
 * `contactCompare.rollback.test.ts` is therefore the ONLY check that this
 * transaction is here. It covers removal of `dbTransaction` FROM THIS FUNCTION
 * AS WRITTEN; it does NOT cover a new multi-write added to this file later
 * without its own crash test.
 *
 * Without it, a crash between the verdicts and the resolutions leaves a contact
 * half-confirmed: some links carrying `same_person` and the rest not, so the
 * contact still reads unconfirmed and re-opens this screen — while the queue has
 * already been told the question is settled.
 */
export function confirmContactSources(
  userId: string,
  contactId: string,
): ConfirmSourcesOutcome {
  const contact = dbGet<{ user_id: string; removed_at: string | null }>(
    `SELECT user_id, removed_at FROM contacts WHERE id = ?`,
    [contactId],
  );
  // Stated here, not inherited from the reader. A writer that trusts a sibling's
  // guard is one refactor away from having none.
  if (!contact || contact.user_id !== userId || contact.removed_at) {
    return {
      ok: false,
      error: "That contact is no longer available.",
      confirmed: 0,
      alreadyConfirmed: 0,
      proposalsResolved: 0,
    };
  }

  const links = dbAll<{
    source_type: ContactLinkSourceType;
    source_record_id: string;
    match_method: ContactMatchMethod;
  }>(
    `SELECT source_type, source_record_id, match_method
       FROM contact_source_links
      WHERE user_id = ? AND contact_id = ? AND match_method <> ?
      ORDER BY source_type, source_record_id`,
    [userId, contactId, ORIGIN_MATCH_METHOD],
  );

  if (links.length === 0) {
    return { ok: true, confirmed: 0, alreadyConfirmed: 0, proposalsResolved: 0 };
  }

  return dbTransaction<ConfirmSourcesOutcome>(() => {
    let confirmed = 0;
    let alreadyConfirmed = 0;

    for (const link of links) {
      const sourceType = link.source_type as ExternalContactSource;
      // IDEMPOTENT IN THE SERVICE, not only behind a disabled button.
      // `recordVerdict` appends, so a second press would add duplicate
      // `same_person` rows — harmless to behaviour (latest wins) but they enter
      // `listVerdicts`, which exists to be a calibration set. Two identical
      // unprompted confirmations would read as two decisions.
      if (hasMustLink(userId, contactId, sourceType, link.source_record_id)) {
        alreadyConfirmed += 1;
        continue;
      }
      recordVerdict({
        userId,
        contactId,
        sourceType,
        sourceRecordId: link.source_record_id,
        identityVerdict: "same_person",
        reason: "compare_confirm",
        matchedOn: link.match_method,
        // A THIRD ROUTE TO THE SAME CONCLUSION, and `decidedBy` exists to keep
        // the three apart: `provenance_unlink` is a correction, `manual_link` is
        // a search-and-attach, and this is a human reading the columns and
        // agreeing. A calibration set that cannot tell them apart reads an
        // unprompted confirmation as a prompted one.
        decidedBy: "compare_confirm",
      });
      confirmed += 1;
    }

    const pairs = new Set(links.map((l) => `${l.source_type}:${l.source_record_id}`));
    let proposalsResolved = 0;
    for (const proposal of listPendingProposals(userId)) {
      if (proposal.contact_id !== contactId) continue;
      if (!pairs.has(`${proposal.source_type}:${proposal.source_record_id}`)) continue;
      if (resolveProposal(proposal.id, "confirmed")) proposalsResolved += 1;
    }

    logService.info(
      `[Contacts] a contact's sources were confirmed from the compare screen; ` +
        `${confirmed} verdict(s) written, ${alreadyConfirmed} already stood, and ` +
        `${proposalsResolved} pending question(s) retired`,
      "Contacts",
    );

    return { ok: true, confirmed, alreadyConfirmed, proposalsResolved };
  });
}
