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
  CONTACT_OWNER_AND_REMOVAL_SQL,
  CONTACT_ROW_FOR_COMPARE_SQL,
  EXTERNAL_RECORD_FOR_COMPARE_SQL,
  LINKED_RECORDS_FOR_CONTACT_SQL,
  LINKS_EXCLUDING_METHOD_SQL,
  LOCAL_MESSAGES_FOR_COMPARE_SQL,
  emailsForAddressesSql,
} from "./db/contactCompareSql";
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
import { extractDigits, formatPhoneNumber, toLookupKey } from "../utils/phoneNormalization";
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
  /**
   * WHAT A PERSON READS — NOT ALWAYS WHAT IS STORED (BACKLOG-2644).
   *
   * Emails and names are the stored value verbatim. PHONES ARE FORMATTED for
   * the screen (see `displayPhone`), because two spellings of one number on a
   * comparison screen was the defect this field carried.
   *
   * So this is a DISPLAY string, and it crosses the IPC boundary as one: do not
   * compare it, key off it, or send it back as an identifier. `matched` is
   * already decided here and the crosswalk row is `linkId`. No consumer does
   * any of those things today; this note exists so the next one does not start.
   */
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
  /**
   * The deals this column's person is on.
   *
   * `"contact"` and `"source"` both carry THE CONTACT'S transactions, because a
   * linked record is on those deals — through the contact it belongs to
   * (BACKLOG-2628). Only `"proposed"` is empty, and it is empty for a reason the
   * renderer states in words: nobody has imported that record yet.
   *
   * No column ever carries transactions "of its own". Deals hang off contacts;
   * an `external_contacts` row is never a party to one.
   */
  transactions: string[];
  recentCommunication: CompareCommItem[];
  /** False when the crosswalk row outlived its `external_contacts` row. */
  sourceRecordPresent: boolean;
}

export interface ContactCompareView {
  contactId: string;
  /** "Is this the same Casey Lane?" */
  title: string;
  /** Why these records were joined, in words. Never a score. */
  reason: string;
  /** `[0]` is always the contact. */
  columns: ContactCompareColumn[];
  /**
   * True when EVERY column carries the same name. Distinct from the per-value
   * `matched` flag on `name`: with three columns reading "Casey Lane", "Casey
   * Lane" and "Casey J. Lane", the first two are marked (the value is on two
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

/**
 * ONE SHAPE PER NUMBER, ON THE ONE SCREEN THAT EXISTS TO COMPARE THEM.
 * (BACKLOG-2644)
 *
 * ===========================================================================
 * THE REPORTED SCREEN
 * ===========================================================================
 * Founder, 11 Aug, comparing two records of one person:
 *
 *     Phone                          Phone
 *       +15035550130                   +1 (503) 555-0130
 *
 * Same number. Two shapes. The columns read different stores and this service
 * printed both verbatim: column 1 is `contact_phones.phone_e164`
 * (`getContactPhoneEntries` projects `phone_e164 AS phone`), normalised at
 * import; a record column is `external_contacts.phones_json`, which preserves
 * the address book's own punctuation on purpose (`contactValueDedup`'s "first
 * spelling wins", BACKLOG-2457). NEITHER STORE IS WRONG. The rendering was.
 *
 * The cost is asymmetric and permanent, which is why this is not cosmetic: a
 * user who cannot see that two numbers match answers *different people*, and a
 * `different_people` verdict is final — the matcher can never propose the pair
 * again. A punctuation difference becomes an irreversible wrong answer.
 *
 * ===========================================================================
 * WHY `formatPhoneNumber` ALONE IS NOT ENOUGH — AND WHY THIS WRAPPER EXISTS
 * ===========================================================================
 * `formatPhoneNumber` branches on DIGIT COUNT, so the same number stored two
 * ways still lands in two branches. Measured, not reasoned (the probe is now
 * `renders one shape ...` in `contactCompare.phoneFormat-2644.test.ts`):
 *
 *     "+12065550142"      -> "+1 (206) 555-0142"
 *     "(206) 555-0142"    -> "(206) 555-0142"        <- same number, still two shapes
 *
 * and `toLookupKey` says those two ARE one number, which is why this screen
 * already tags them `match`. A ten-digit spelling with no country code is the
 * ordinary address-book shape, and it was already pinned as expected output by
 * `contactCompare.test.ts` ("marks the same number written two ways") — the
 * founder's defect, preserved as an assertion.
 *
 * So a ten-digit run is canonicalised to the `+1` form before formatting.
 *
 * THIS ASSERTS NOTHING NEW. "Ten digits means NANP" is already claimed three
 * times upstream: by `toE164`'s ten-digit branch, by `contact_phones.phone_e164`
 * which is written through it, and by this screen's own `match` tag. The display
 * is being brought into line with a claim the screen already makes.
 *
 * ===========================================================================
 * THE `+` GUARD IS THE POINT, NOT A DEFENSIVE HABIT
 * ===========================================================================
 * A value like `+4405550142` states a country code AND carries exactly ten
 * digits. Without the guard this would print `+1 (440) 555-0142` — a US country
 * code invented over one the record actually stated, which is the one thing a
 * screen about identity must not do. With it, an explicitly-prefixed value
 * keeps `formatPhoneNumber`'s existing treatment (today, the US ten-digit
 * shape): neither improved nor made worse here, and owned by BACKLOG-2461 /
 * BACKLOG-2635.
 *
 * ===========================================================================
 * LOCAL, AND NOT IN `phoneNormalization.ts`
 * ===========================================================================
 * `formatPhoneNumber`'s output shape is load-bearing elsewhere — it is the
 * string `buildContactLabel` writes and the one `autoLinkNameGuard` compares
 * against (`phoneNormalization.formatPhoneNumber.lookupKeyInvariant-2620.test.ts`).
 * Widening it would move the linker. This is a rule about ONE SCREEN'S display
 * and it lives on that screen.
 *
 * DISPLAY-ONLY, AND THE BOUNDARY IS EXACT: every comparison on this screen —
 * `sharedPhoneKeys`, `dedupePhoneValues`, `phonesMatch` in `loadCommunications`
 * — runs on the RAW stored value. This function's output is read by nothing but
 * a person. It also preserves `toLookupKey` (the last ten of `"1" + d` is `d`),
 * asserted over a boundary sweep in the suite, so even a future caller that
 * compared the formatted string could not disagree with one that did not.
 */
const displayPhone = (raw: string): string => {
  const digits = extractDigits(raw);
  return digits.length === 10 && !raw.trim().startsWith("+")
    ? formatPhoneNumber("1" + digits)
    : formatPhoneNumber(raw);
};

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
    const rows = dbAll<{
      id: string;
      subject: string | null;
      sent_at: string | null;
      received_at: string | null;
      addr: string;
    }>(
      emailsForAddressesSql(allEmailKeys.length),
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
  /*
    THE MATCH INPUT. RAW, AND NO TEST WILL CATCH YOU CHANGING THAT.

    BACKLOG-2644 formats phones for the screen; these values are not for the
    screen, they are what `phonesMatch` compares against `participants_flat`.
    Formatting here was RUN as a control and left all 102 tests green, because
    `phonesMatch` normalises both sides through `toE164` — so the mistake is
    invisible to behaviour today and would only surface when someone later
    changed the formatter. Display goes on the way OUT (`matchedIdentifier`
    below), never on the way IN.
  */
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
      LOCAL_MESSAGES_FOR_COMPARE_SQL,
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
          /*
            THE THIRD PLACE A NUMBER IS PRINTED ON THIS SCREEN (BACKLOG-2644).

            `hit` is one of THIS column's stored phones — the number the message
            reached — and `CommRow` prints it under every communication line.
            Left raw it would read "text · 4 Aug · +12065550142" directly beneath
            a Phone row reading "+1 (206) 555-0142": the same defect, two rows
            lower, on the same column.

            Formatted HERE and not in the bundle above: `phonesByBundle` is the
            match input, and `phonesMatch(p, t)` compares it against
            `participants_flat` tokens. Formatting what is matched ON, rather
            than what is reported, would put display in the match path.

            The EMAIL branch is deliberately untouched — `r.addr` is an address,
            already lower-cased-and-trimmed by the query that found it.
          */
          matchedIdentifier: displayPhone(hit),
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
  /**
   * BACKLOG-2502 R8 — THE CONTACT IS ONE SIDE OF THE QUESTION, ON THE REVIEW
   * ROUTE.
   *
   * Founder, 2026-08-09, after seeing four columns for one question: a contact
   * holding two linked records plus one candidate drew four columns, three of
   * which were his own records — so the screen looked like a four-way
   * comparison when it was asking one thing. Collapsed, it reads as it should:
   * *this person* against *this candidate*.
   *
   * A FLAG, NOT AN INFERENCE FROM `proposedSource`. Today the review queue is
   * the only caller passing a candidate, so the two would be indistinguishable
   * — and that is exactly why it is stated: this is a decision about what one
   * screen MEANS, not a consequence of having a candidate, and the next reader
   * should not have to know that one implies the other.
   *
   * CLIENTS & CONTACTS DOES NOT SET IT. There, one column per source IS the
   * feature (PR C) — it is how a user sees which record contributed what, and
   * how they unlink the wrong one.
   */
  options?: { collapseContactSources?: boolean },
): Promise<ContactCompareView | null> {
  const contact = dbGet<{
    user_id: string;
    display_name: string | null;
    company: string | null;
    removed_at: string | null;
  }>(
    CONTACT_ROW_FOR_COMPARE_SQL,
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
    LINKED_RECORDS_FOR_CONTACT_SQL,
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

  /*
    R8 — ON THE REVIEW ROUTE THE CONTACT'S OWN RECORDS ARE NOT OPPONENTS.

    Collapsed, every non-origin row stops being a column and its VALUES join
    column 1 instead (below). Uncollapsed, this is the expression it has always
    been and the contact route is untouched.
  */
  const collapseContactSources = options?.collapseContactSources === true;
  const sourceRows = collapseContactSources
    ? []
    : nonOrigin.filter((l) => l.id !== absorbedSourceId?.id);

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
        EXTERNAL_RECORD_FOR_COMPARE_SQL,
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
  /**
   * The contact's deals, addressed. ONE projection, read by column 1 and by
   * every LINKED record's column (BACKLOG-2628).
   *
   * Hoisted rather than repeated: the defect this fixes was one screen making
   * two different claims about one record, and two `.map(...).filter(...)`
   * expressions is how that comes back. A record that is linked is on these
   * deals; there is no second list to derive.
   */
  const transactionAddresses = transactions
    .map((t) => t.property_address)
    .filter((a): a is string => !!a);

  /*
    THE UNION, NOT THE FIRST ONE FOUND.

    A collapsed column that showed only `contact_emails` / `contact_phones` would
    quietly drop any address or number that lives on a linked record and was
    never copied across — and a value disappearing off this screen is the one
    failure the founder has already been bitten by. So the contact's own values
    LEAD (they are the saved truth and the ones the rest of the app uses) and
    every record it is assembled from adds what it has.

    OVER `links` RATHER THAN `nonOrigin` — AND THE TWO ARE THE SAME SET TODAY.
    Corrected after SR review (2026-08-09): the earlier note here said the origin
    row is one of the contact's own records and so contributes values. It cannot.
    Its `source_record_id` is the synthetic `origin:<contactId>`
    (`db/contactOriginLink.ts`) and its `source_type` comes from the origin
    vocabulary rather than one of the five external sources, so the LEFT JOIN
    above cannot match on it: `ec_emails_json` / `ec_phones_json` are always NULL
    there and `parseValueArray(null)` is `[]`. Run: swapping every `links` below
    for `nonOrigin` leaves all 54 tests green, and no fixture can tell the two
    apart without an `external_contacts` row keyed `origin:…`, which nothing
    writes — so there is no test to add here, only this comment to get right.

    `links` is kept because the exclusion of origin rows is a statement about
    COLUMNS — drawing the address book a contact came from as its own opponent is
    noise — and that reasoning does not transfer to values. If an origin row ever
    pointed at a real record, its values would belong in this union, and this
    expression already carries them.

    Deduped by `dedupeEmailValues` / `dedupePhoneValues`, the same keys every
    other column is built with, so "the same number" means one thing here.
  */
  const collapsedEmails = collapseContactSources
    ? dedupeEmailValues([
        ...contactEmails,
        ...links.flatMap((l) => parseValueArray(l.ec_emails_json)),
      ])
    : dedupeEmailValues(contactEmails);
  const collapsedPhones = collapseContactSources
    ? dedupePhoneValues([
        ...contactPhones,
        ...links.flatMap((l) => parseValueArray(l.ec_phones_json)),
      ])
    : dedupePhoneValues(contactPhones);
  /*
    Company is ONE value on both sides, so there is no union to show. The
    contact's own wins when it has one; when it has none, a record's company is
    taken rather than left blank — the case where collapsing would otherwise
    make a company vanish from the screen entirely.
  */
  const collapsedCompany =
    contact.company?.trim() ||
    (collapseContactSources
      ? (links.map((l) => l.ec_company?.trim()).find((c) => !!c) ?? null)
      : null);

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
      emails: collapsedEmails,
      phones: collapsedPhones,
      company: collapsedCompany,
      transactions: transactionAddresses,
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
      /*
        A LINKED RECORD IS ON THE CONTACT'S DEALS (BACKLOG-2628).

        This was `[]`, under FOUNDER DECISION D5's reading that a source record
        "has no transactions of its own". That sentence is still true and is no
        longer the right one to act on: the founder saw a column tagged `linked
        record`, offering `Unlink`, whose Transactions cell read "not a contact
        yet" two rows below — one column asserting two opposite things about one
        record. D5's wording was written for a record belonging to NOBODY, and it
        keeps that job on the `proposed` column below.

        A linked record does not hold deals independently; it is on these deals,
        through the contact. That is what the same list in both columns says, and
        it is what linking did.
      */
      transactions: transactionAddresses,
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
      /*
        EMPTY, AND THE ONLY COLUMN THAT IS (BACKLOG-2628).

        Nobody has imported this record, so it is not a party to a deal — the
        renderer writes "not imported yet" over this emptiness, which is the
        statement it carries. Do not "fix" this to match the source rows above:
        they are linked and this one is not, and that difference is the entire
        question this screen asks.

        A LOOKUP THROUGH THE CONTACT THAT CLAIMS THIS RECORD WAS BUILT AND
        DISCARDED (11 Aug). It is genuinely reachable — `duplicate_source_record`
        (`contactSourceLinker.ts:678`) proposes records another contact holds,
        and `contactLinkReview.ts:360` handles confirming one — so the query
        would have had real answers. The founder chose the static label over it.
        Recorded so nobody rebuilds it from the intermediate decision.
      */
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
  // with "Casey Lane", "Casey Lane" and "Casey J. Lane" the first two are
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

  /**
   * `display` FORMATS, `key` COMPARES, AND THEY ARE GIVEN THE SAME RAW INPUT.
   *
   * BACKLOG-2644. `matched` is computed from the STORED value and only `value`
   * is rewritten for the screen. Formatting first and keying off the formatted
   * string would be the same code with the bug back in it: two normalisations
   * of "the same number" in one function, which is the shape this file's
   * `CompareValue` docblock exists to forbid.
   */
  const mark = (
    values: string[],
    keys: Set<string>,
    key: (v: string) => string,
    display: (v: string) => string = (v) => v,
  ): CompareValue[] =>
    values.map((value) => ({ value: display(value), matched: keys.has(key(value)) }));

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
    phones: mark(c.phones, sharedPhoneKeys, phoneKey, displayPhone),
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

  const sharedPhoneRaw = firstShared((c) => c.phones, phoneKey, sharedPhoneKeys);

  /*
    Over LINKS, not columns — `nonOrigin`, which includes the row column 1
    absorbed. See the field's docblock; confirming only the rendered columns
    would make this unreachable.

    BACKLOG-2502 — TWO GUARDS IN FRONT OF THE QUANTIFIER, NOT A NEW QUANTIFIER.

    `every` over the existing links answers "is everything already linked also
    already confirmed". That is the right question on the contact route, and it
    is the wrong answer to "is there anything left to decide" in two ways the
    review-queue route hits immediately:

      1. AN OPEN PROPOSAL IS NOT A LINK. The candidate column is by definition
         unlinked, so it cannot make the predicate false. A contact whose
         existing links are all confirmed therefore reads confirmed while an
         unanswered question stands against it, and `ContactCompareSources`
         renders "You have confirmed these records are the same person" in
         place of the decision buttons — asserting a decision the user never
         made, and offering no way to make one.
      2. `[].every(...)` IS `true`, so a contact with no non-origin links would
         read confirmed on a vacuous quantifier rather than on a decision.

    ONLY GUARD 1 CAN FIRE, AND THE FOUNDER'S CASE IS FIXED BY IT ALONE.
    Corrected here after SR review (2026-08-09): the version of this note that
    presented reason 2 as a second LIVE defect was wrong, and a false comment
    outlives the code it describes. Guard 2 is unreachable as this function
    stands —

      `sourceRows` is either `[]` (collapsed) or a filter of `nonOrigin`, so
      `sourceRows.length <= nonOrigin.length`. The null-return ~200 lines above
      ends the function unless `sourceRows.length + (proposedRecord ? 1 : 0)`
      is non-zero. So `nonOrigin.length === 0` reaches this line ONLY when a
      `proposedRecord` exists — which is exactly when the candidate column was
      pushed, so `proposedColumnPresent` is true and GUARD 1 HAS ALREADY FORCED
      `false`. Run: dropping `nonOrigin.length > 0` leaves 54/54 green.

    KEPT ANYWAY, and not as superstition. "Everything already linked is also
    already confirmed" is not a claim you can make about nothing, and guard 2 is
    what makes this expression say that on its own terms — without depending on
    a `return null` two hundred lines away that was written for a different
    reason and may move for a different reason again. Delete it and `isConfirmed`
    is correct only by coincidence of where that return sits.

    Both guards sit IN FRONT of the quantifier, so the absorbed-row case the
    docblock below protects is untouched: with links present and no proposal,
    this is the same expression it has always been.

    `proposedColumnPresent` is read off the columns actually built rather than
    re-deriving it from `proposedSource`/`proposedRecord`, so it cannot come to
    disagree with whether the candidate is on screen.
  */
  const proposedColumnPresent = columns.some((c) => c.kind === "proposed");
  const isConfirmed =
    !proposedColumnPresent &&
    nonOrigin.length > 0 &&
    nonOrigin.every((l) =>
      hasMustLink(userId, contactId, l.source_type as ExternalContactSource, l.source_record_id),
    );

  return {
    contactId,
    isConfirmed,
    title: `Is this the same ${contact.display_name?.trim() || "person"}?`,
    reason: buildReason(
      columns,
      /*
        THE SENTENCE PRINTS THE SAME SHAPE THE COLUMNS DO (BACKLOG-2644).

        `firstShared` returns the RAW stored value — it searches `raw`, whose
        values are the ones `sharedPhoneKeys` was built from, and that is
        correct: the search must key on what the marking keyed on. But the
        result is then printed two rows above the columns it names. Left
        unformatted it would read "Both records list the phone number
        +12065550142" over a column reading "+1 (206) 555-0142" — this bug,
        one line higher, on the sentence whose whole job is to name the value
        the user is being asked to check.
      */
      sharedPhoneRaw === null ? null : displayPhone(sharedPhoneRaw),
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
    CONTACT_OWNER_AND_REMOVAL_SQL,
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
    LINKS_EXCLUDING_METHOD_SQL,
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
