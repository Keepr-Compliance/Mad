/**
 * Contact Ingestion Funnel — BACKLOG-2391
 *
 * Every number between "the macOS address book" and "what the user sees in the
 * import picker" used to be invisible in production. File discovery was logged
 * at `debug`; production runs at `info`, so a reporter's 1 MB log contained ZERO
 * lines mentioning ContactsService, abcddb or AddressBook. Three separate
 * investigations could not distinguish "never read" from "lost in processing"
 * from "hidden in rendering", because none of those counts existed anywhere.
 *
 * This module is the single place where each stage's counters are both STORED
 * and FORMATTED, so the structured object and the log line can never disagree.
 *
 * Two consumers:
 *   1. The log — one info line per stage, so a support log answers "where did
 *      the contacts go?" without touching the code.
 *   2. `getContactIngestionFunnel()` — the structured snapshot the diagnostics
 *      block (BACKLOG-2394) attaches to every support ticket. Callers read the
 *      numbers directly; nobody has to parse the log text.
 *
 * HARD RULE — NO PII. These lines are written on the assumption that they will
 * be pasted verbatim into a public issue. Counts, states and home-relative
 * redacted paths only: never a contact name, phone number, email address, or
 * any absolute path (absolute paths contain the user's account name).
 *
 * PERFORMANCE — counters, not per-row logging. These stages run on every sync
 * with ~1000+ contacts; a per-contact line is both a disk problem and a way to
 * bury the signal that matters.
 */

import path from "path";
import logService from "./logService";

// ============================================
// TYPES
// ============================================

/**
 * Why a discovered address book was NOT read.
 *
 * BACKLOG-2392: `below-threshold` and `not-selected` are gone along with the
 * selection rule that produced them — every readable book is now read. There is
 * no `duplicate-path` either: the directory walk cannot return the same file
 * twice (`Dirent.isFile()` is false for a symlink, so a symlinked book is never
 * even discovered). The realpath guard that stops the default path being read a
 * second time is live and covered, but it silently declines to re-add a book
 * rather than reporting it as skipped — there is nothing for a support log to
 * learn from "we did not do the wrong thing".
 *
 * `read-error` and `load-error` remain deliberately distinct (BACKLOG-2391 SR
 * review), and the distinction is a DIAGNOSIS rather than bookkeeping:
 *   - `read-error` — the book could not be opened at all. Signature of a
 *     permissions problem (Full Disk Access), or a store that vanished
 *     underneath us.
 *   - `load-error` — it opened fine and then threw partway through the read.
 *     Signature of a CORRUPT or partially-readable store.
 * One says "grant access", the other says "this account's database is damaged".
 * Collapsing them sends the user to the wrong fix.
 */
export type AddressBookSkipReason = "read-error" | "load-error";

/** One `.abcddb` file found during discovery. */
export interface AddressBookCandidate {
  /** Redacted, base/home-relative path. NEVER absolute — see redactAddressBookPath. */
  path: string;
  /** ABPerson rows parsed out of this book, or null when it could not be read. */
  recordCount: number | null;
  /**
   * BACKLOG-2392: true for every book actually parsed — which is now every
   * readable book, not a single winner. (Was `selected`.)
   */
  read: boolean;
  /** Present on every book that was NOT read. */
  skipReason?: AddressBookSkipReason;
}

/**
 * Stage 1 — which address books exist, and which of them we read.
 *
 * BACKLOG-2392: macOS stores ONE database per account, so this stage answers
 * "how many accounts did we ingest", not "which single file won".
 *
 * `readCount` and `failedCount` exist so that **"read 2 of 3" is
 * distinguishable from "read 2 of 2"**. A partially-ingested address book is
 * precisely the failure this instrumentation exists to catch; it must never
 * render as a clean run.
 */
export interface DiscoveryStage {
  /** How many `.abcddb` files were found under the AddressBook base dir. */
  found: number;
  candidates: AddressBookCandidate[];
  /** Books successfully parsed. */
  readCount: number;
  /** Books discovered but unreadable (locked, corrupt, no Full Disk Access). */
  failedCount: number;
  /** True when discovery found nothing usable and the hard-coded default path was tried. */
  usedFallback: boolean;
}

/**
 * Stage 2 — rows read out of EVERY address book, and what survived.
 *
 * BACKLOG-2392: these are totals across all books read, not one book's numbers.
 */
export interface ParseStage {
  /** How many address books contributed rows to these totals. */
  books: number;
  /** ABPerson rows returned across all books. */
  rowsRead: number;
  /** ZABCDRECORD rows that were groups/containers/info, excluded from `rowsRead`. */
  nonPersonRows: number;
  /** Rows with no ZUNIQUEID — unkeyable, therefore not importable. Expect 0. */
  missingUniqueId: number;
  /** ZABCDPHONENUMBER rows returned. */
  phoneRows: number;
  /** ZABCDEMAILADDRESS rows returned. */
  emailRows: number;
  /**
   * Person rows read that did NOT become a distinct contact in the output:
   * `rowsRead - usable`.
   *
   * Renamed from `droppedNoName` — it has nothing to do with names any more,
   * and BACKLOG-2392 removed the name gate entirely, so calling it that
   * invited exactly the misreading below.
   *
   * MEASURED, never asserted. It was briefly a hard-coded literal `0`: a
   * regression sentinel that could not fire, reporting success
   * unconditionally. Two things make it non-zero, and they need different
   * responses:
   *   - a reintroduced drop (any gate on any field) — a BUG;
   *   - two books containing the same ZUNIQUEID, collapsed by the merge —
   *     benign, but worth seeing, since a store's UUID half should be unique
   *     per account and a collision means an assumption is wrong.
   */
  droppedRows: number;
  /**
   * Person rows with no first name, no last name and no organisation.
   *
   * The import-everything population: exactly what the old gate discarded (18
   * of 1123 on a verified store). Unlike `droppedNoName` this is EXPECTED to be
   * non-zero — it says how many contacts are riding on the email/phone label
   * fallback. Zero here on a large address book means the fallback is not being
   * exercised and the counter above is proving nothing.
   */
  nameless: number;
  /** Rows that became a person. Post-2392 this equals `rowsRead`. */
  usable: number;
  /** Of `usable`: has at least one phone. */
  withPhone: number;
  /** Of `usable`: no phone, at least one email. */
  emailOnly: number;
  /** Of `usable`: neither phone nor email (name-only records). */
  neither: number;
  /** Of `usable`: had no name, so the label fell back to an email or phone. */
  labelFromContact: number;
  /** Of `usable`: no name, no email, no phone — imported with an empty label. */
  unlabelled: number;
}

/** Stage 3 — what the external_contacts shadow table sync actually did. */
export interface ShadowSyncStage {
  source: string;
  /** Record ids that did not exist for this source before the sync. */
  inserted: number;
  /** Existing records where at least one written column changed. */
  updated: number;
  /** Existing records byte-identical on every written column. */
  unchanged: number;
  /** Rows removed as stale — already scoped to `source` (BACKLOG-2385). */
  deleted: number;
  /** Total rows for the user across all sources after the sync. */
  total: number;
}

/** Stage 4 — how the picker narrowed those rows down to what is on screen. */
export interface PickerStage {
  /** Unimported rows from the local contacts table (iPhone sync path). */
  dbRowsIn: number;
  /** Rows read from the external_contacts shadow table. */
  externalRowsIn: number;
  /** dbRowsIn + externalRowsIn. */
  rowsIn: number;
  /** Dropped because their source is switched off in preferences. */
  sourceDisabled: number;
  /** Dropped because a strong identifier matches an already-imported contact. */
  alreadyImported: number;
  /** Dropped as a duplicate of a row already in the list. */
  duplicateSuppressed: number;
  /**
   * BACKLOG-2458 — of the `duplicateSuppressed` records, how many handed their
   * SOURCE IDENTITY to the row that absorbed them.
   *
   * A suppressed record is no longer discarded: the row that collapsed it
   * carries its `(source_type, source_record_id)` pair, and importing that row
   * writes a `source_id` crosswalk entry for every one of them. Published
   * because the whole defect was invisible — the picker knew two records were
   * one person, threw the conclusion away, and the next sync re-derived it by
   * content matching as though the user had never chosen anything.
   *
   * `duplicateSuppressed - collapsedIdentitiesCarried` is the set whose
   * identity genuinely could not be carried: rows from the local `contacts`
   * table have no source record behind them. Optional so funnel snapshots
   * written before this shipped still read back.
   */
  collapsedIdentitiesCarried?: number;
  /** What the renderer receives. */
  shown: number;
}

/**
 * Identity crosswalk stage (BACKLOG-2401).
 *
 * There is deliberately NO one-time backfill for contacts that predate
 * `contact_source_links`; they are linked opportunistically as syncs run. That
 * choice is only defensible if convergence is OBSERVABLE rather than assumed —
 * which is what this stage is for. `idMatched` climbing while `contentMatched`
 * falls towards zero is the system converging; `contentMatched` staying high
 * means ids are churning (a device change, or an unstable id), and `flagged`
 * above zero means real conflicts are waiting on a human.
 *
 * Counted separately ON PURPOSE: a link resolved from a source id and a link
 * inferred from a phone number are not the same claim, and collapsing them into
 * one number is exactly how a silent degradation stays silent.
 */
export interface LinkStage {
  /** Source records offered to the linker. */
  recordsIn: number;
  /** Resolved by source id — already linked. The healthy steady state. */
  idMatched: number;
  /** Newly linked via the deterministic content fallback (email, then phone). */
  contentMatched: number;
  /** Suspect matches WITHHELD for review — never silently applied. */
  flagged: number;
  /** Matched nothing: a genuinely new person. */
  unmatched: number;
  /**
   * BACKLOG-2410 — content matches REFUSED because the user has already
   * answered "different people" about that exact pair.
   *
   * Its own counter, not folded into `unmatched`, for the reason this whole
   * epic turns on: "nothing found" and "never looked" must stay
   * distinguishable, and here the third state is "asked, and answered". A
   * support engineer reading `unmatched 40` cannot tell a user whose address
   * book is full of new people from one who has rejected forty bad suggestions
   * — those need opposite responses.
   *
   * OPTIONAL, so a caller written before this field still type-checks and the
   * arithmetic note below stays honest about older snapshots.
   */
  declined?: number;
}

/**
 * The structured snapshot. Every field is optional because a stage is only
 * present once it has run in this process (e.g. a picker open with a warm
 * shadow table never re-reads the address book, so discovery/parse stay from
 * the last real read).
 */
export interface ContactIngestionFunnel {
  discovery?: DiscoveryStage & { at: string };
  parse?: ParseStage & { at: string };
  shadowSync?: ShadowSyncStage & { at: string };
  picker?: PickerStage & { at: string };
  links?: LinkStage & { at: string };
}

// ============================================
// PATH REDACTION
// ============================================

/**
 * A path segment that is (or contains) a long hex/UUID blob — the per-account
 * AddressBook source directories look like
 * `0CA70C1F-1234-5678-9ABC-DEF012345678`.
 */
const UUID_ISH = /^[0-9A-Fa-f]{8}[0-9A-Fa-f-]*$/;

/** Shorten a UUID-ish directory name so the line stays readable and unlinkable. */
function shortenSegment(segment: string): string {
  if (segment.length > 8 && UUID_ISH.test(segment)) {
    return `${segment.slice(0, 5)}…`;
  }
  return segment;
}

/**
 * Turn an absolute `.abcddb` path into something safe to print.
 *
 * Absolute paths contain the account name (`/Users/margaret/…`), so they are
 * never emitted. Preference order:
 *   1. relative to the AddressBook base dir  -> `Sources/0CA70…/AddressBook-v22.abcddb`
 *   2. relative to $HOME                     -> `~/Library/…`
 *   3. neither                               -> `<outside-home>/<basename>`
 *
 * UUID-ish segments are truncated in every case: two books under two different
 * account directories still read as two distinct entries, but the full
 * identifier never lands in a public issue.
 */
export function redactAddressBookPath(
  fullPath: string,
  baseDir?: string,
): string {
  const shorten = (p: string): string =>
    p.split(path.sep).map(shortenSegment).join("/");

  if (baseDir) {
    const rel = path.relative(baseDir, fullPath);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return shorten(rel);
    }
  }

  const home = process.env.HOME;
  if (home) {
    const relHome = path.relative(home, fullPath);
    if (relHome && !relHome.startsWith("..") && !path.isAbsolute(relHome)) {
      return `~/${shorten(relHome)}`;
    }
  }

  return `<outside-home>/${shortenSegment(path.basename(fullPath))}`;
}

// ============================================
// FORMATTERS (pure — testable on composed output)
// ============================================

/**
 * ```
 * address books found: 3, read: 2, failed: 1
 *   read: AddressBook-v22.abcddb (3 records)
 *   read: Sources/0CA70…/AddressBook-v22.abcddb (857 records)
 *   FAILED: Sources/AAAAA…/AddressBook-v22.abcddb (could not open — check Full Disk Access)
 * ```
 *
 * BACKLOG-2392: the header carries read/failed explicitly. A support log must
 * answer "did we get ALL her accounts?" without the reader having to count the
 * lines underneath and hope none were omitted.
 */
export function formatDiscoveryLines(stage: DiscoveryStage): string[] {
  const lines: string[] = [
    `[ContactsService] address books found: ${stage.found},` +
      ` read: ${stage.readCount}, failed: ${stage.failedCount}` +
      `${stage.usedFallback ? " (default path fallback)" : ""}`,
  ];

  for (const c of stage.candidates) {
    if (c.read) {
      lines.push(`[ContactsService]   read: ${c.path} (${c.recordCount} records)`);
      continue;
    }
    // The two failure modes name their own remedy — see AddressBookSkipReason.
    const why =
      c.skipReason === "load-error"
        ? "opened, then failed mid-read — store may be corrupt"
        : "could not open — check Full Disk Access";
    lines.push(`[ContactsService]   FAILED: ${c.path} (${why})`);
  }

  return lines;
}

/**
 * ```
 * parsed: 1558 rows from 2 books -> usable: 1558   (phone: 890, email-only: 226, neither: 442)
 * ```
 *
 * BACKLOG-2392: `no-name dropped` stays in the line even though it is now
 * always 0 — a support log showing a non-zero value there is the fastest
 * possible signal that the name gate regressed.
 */
export function formatParseLine(stage: ParseStage): string {
  return (
    `[ContactsService] parsed: ${stage.rowsRead} rows from ${stage.books} book(s)` +
    ` -> dropped: ${stage.droppedRows} -> usable: ${stage.usable}` +
    `   [nameless: ${stage.nameless}]` +
    `   (phone: ${stage.withPhone}, email-only: ${stage.emailOnly}, neither: ${stage.neither})` +
    `   [labelled from contact: ${stage.labelFromContact}, unlabelled: ${stage.unlabelled}]` +
    `   [rows: ${stage.phoneRows} phone, ${stage.emailRows} email;` +
    ` excluded: ${stage.nonPersonRows} non-person, ${stage.missingUniqueId} no-uid]`
  );
}

/**
 * ```
 * shadow: inserted 4, updated 12, unchanged 1100, deleted 0 (source=macos), total 1116
 * ```
 */
export function formatShadowSyncLine(stage: ShadowSyncStage): string {
  return (
    `[ExternalContactDbService] shadow: inserted ${stage.inserted}, updated ${stage.updated},` +
    ` unchanged ${stage.unchanged}, deleted ${stage.deleted} (source=${stage.source}), total ${stage.total}`
  );
}

/**
 * ```
 * picker: 1116 in (db 0 + external 1116) -> source-disabled 0 -> already-imported 105 -> dup-suppressed 336 (identity carried 336) -> shown 675
 * ```
 * Emitted in the order the handler actually applies the filters, so the
 * arithmetic closes: in - disabled - imported - dup = shown.
 *
 * BACKLOG-2458: the parenthetical says how many of the suppressed records
 * handed their source identity to the row that absorbed them. It is rendered
 * only when the counter is present, so a snapshot taken before this shipped
 * formats exactly as it always did rather than claiming a carry of zero.
 */
export function formatPickerLine(stage: PickerStage): string {
  const carried =
    stage.collapsedIdentitiesCarried === undefined
      ? ""
      : ` (identity carried ${stage.collapsedIdentitiesCarried})`;
  return (
    `[Contacts] picker: ${stage.rowsIn} in (db ${stage.dbRowsIn} + external ${stage.externalRowsIn})` +
    ` -> source-disabled ${stage.sourceDisabled}` +
    ` -> already-imported ${stage.alreadyImported}` +
    ` -> dup-suppressed ${stage.duplicateSuppressed}${carried}` +
    ` -> shown ${stage.shown}`
  );
}

/**
 * One line, PII-free — counters only, never a record id (a macOS ZUNIQUEID is
 * not a name but it is still a stable per-person identifier, and this line ends
 * up in support tickets).
 *
 * ```
 * links: 1116 records -> id-matched 1102 -> content-matched 12 -> flagged 1 -> declined 0 -> unmatched 1
 * ```
 * The arithmetic closes: id + content + flagged + declined + unmatched = recordsIn.
 *
 * `declined` (BACKLOG-2410) is rendered whenever it is present, INCLUDING when
 * it is zero — a stage that ran and found nothing to decline must not look like
 * a stage that predates the counter. It is omitted only when `undefined`, which
 * is the genuine "this snapshot is older than the field" case.
 */
export function formatLinkLine(stage: LinkStage): string {
  return (
    `[Contacts] links: ${stage.recordsIn} records` +
    ` -> id-matched ${stage.idMatched}` +
    ` -> content-matched ${stage.contentMatched}` +
    ` -> flagged ${stage.flagged}` +
    (stage.declined === undefined ? "" : ` -> declined ${stage.declined}`) +
    ` -> unmatched ${stage.unmatched}`
  );
}

// ============================================
// SNAPSHOT STORE + RECORDERS
// ============================================

const funnel: ContactIngestionFunnel = {};

/** ISO timestamp so the diagnostics block can tell a stale stage from a fresh one. */
function now(): string {
  return new Date().toISOString();
}

/**
 * The structured counts for the diagnostics block (BACKLOG-2394).
 * Returned as a shallow copy so a caller cannot mutate the live snapshot.
 */
export function getContactIngestionFunnel(): ContactIngestionFunnel {
  return {
    discovery: funnel.discovery ? { ...funnel.discovery } : undefined,
    parse: funnel.parse ? { ...funnel.parse } : undefined,
    shadowSync: funnel.shadowSync ? { ...funnel.shadowSync } : undefined,
    picker: funnel.picker ? { ...funnel.picker } : undefined,
    links: funnel.links ? { ...funnel.links } : undefined,
  };
}

/** Test-only: drop the snapshot so suites do not leak counts into each other. */
export function resetContactIngestionFunnel(): void {
  delete funnel.discovery;
  delete funnel.parse;
  delete funnel.shadowSync;
  delete funnel.picker;
  delete funnel.links;
}

export function recordDiscovery(stage: DiscoveryStage): void {
  funnel.discovery = { ...stage, at: now() };
  for (const line of formatDiscoveryLines(stage)) {
    logService.info(line, "ContactsService");
  }
}

export function recordParse(stage: ParseStage): void {
  funnel.parse = { ...stage, at: now() };
  logService.info(formatParseLine(stage), "ContactsService");
}

export function recordShadowSync(stage: ShadowSyncStage): void {
  funnel.shadowSync = { ...stage, at: now() };
  logService.info(formatShadowSyncLine(stage), "ExternalContactDbService");
}

export function recordPicker(stage: PickerStage): void {
  funnel.picker = { ...stage, at: now() };
  logService.info(formatPickerLine(stage), "Contacts");
}

export function recordLinks(stage: LinkStage): void {
  funnel.links = { ...stage, at: now() };
  logService.info(formatLinkLine(stage), "Contacts");
}
