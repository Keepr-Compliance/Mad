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
 * Why a discovered address book was not the one we read.
 *
 * `read-error` and `load-error` are deliberately distinct: the first means the
 * book could not even be counted; the second means it counted fine and then
 * threw during the full read. The second is the interesting one — it is what a
 * corrupt or partially-readable book looks like, and it is the case that MUST
 * fall through to the next candidate rather than abort discovery.
 */
export type AddressBookSkipReason =
  | "below-threshold"
  | "read-error"
  | "load-error"
  | "not-selected";

/** One `.abcddb` file found during discovery. */
export interface AddressBookCandidate {
  /** Redacted, base/home-relative path. NEVER absolute — see redactAddressBookPath. */
  path: string;
  /** Record count from ZABCDRECORD, or null when the file could not be read. */
  recordCount: number | null;
  /** True for the single book we actually parsed. */
  selected: boolean;
  /** Present on every non-selected candidate. */
  skipReason?: AddressBookSkipReason;
}

/** Stage 1 — which address books exist and which one we read. */
export interface DiscoveryStage {
  /** How many `.abcddb` files were found under the AddressBook base dir. */
  found: number;
  candidates: AddressBookCandidate[];
  /** Redacted path of the book that was parsed, or null when none qualified. */
  selected: string | null;
  /** The MIN_CONTACT_RECORD_COUNT gate that candidates were measured against. */
  threshold: number;
  /** True when no candidate qualified and the hard-coded default path was tried. */
  usedFallback: boolean;
}

/** Stage 2 — rows read out of the selected book and what survived. */
export interface ParseStage {
  /** ZABCDRECORD rows returned. */
  rowsRead: number;
  /** ZABCDPHONENUMBER rows returned. */
  phoneRows: number;
  /** ZABCDEMAILADDRESS rows returned. */
  emailRows: number;
  /** Rows discarded because first/last/organization were all empty. */
  droppedNoName: number;
  /** Rows that became a person (rowsRead - droppedNoName, deduped by person id). */
  usable: number;
  /** Of `usable`: has at least one phone. */
  withPhone: number;
  /** Of `usable`: no phone, at least one email. */
  emailOnly: number;
  /** Of `usable`: neither phone nor email (name-only records). */
  neither: number;
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
  /** What the renderer receives. */
  shown: number;
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
 * address books found: 2  [3 records] [1128 records]
 *   selected: Sources/0CA70…/AddressBook-v22.abcddb
 *   skipped: AddressBook-v22.abcddb (3 <= threshold 10)
 * ```
 */
export function formatDiscoveryLines(stage: DiscoveryStage): string[] {
  const counts = stage.candidates
    .map((c) => (c.recordCount === null ? "[unreadable]" : `[${c.recordCount} records]`))
    .join(" ");

  const lines: string[] = [
    `[ContactsService] address books found: ${stage.found}${counts ? `  ${counts}` : ""}`,
  ];

  lines.push(
    stage.selected
      ? `[ContactsService]   selected: ${stage.selected}${stage.usedFallback ? " (default path fallback)" : ""}`
      : `[ContactsService]   selected: none${stage.usedFallback ? " (default path fallback attempted)" : ""}`,
  );

  for (const c of stage.candidates) {
    if (c.selected) continue;
    const why =
      c.skipReason === "below-threshold"
        ? `${c.recordCount} <= threshold ${stage.threshold}`
        : c.skipReason === "read-error"
          ? "read error"
          : c.skipReason === "load-error"
            ? `load failed after counting ${c.recordCount} records`
            : "not selected";
    lines.push(`[ContactsService]   skipped: ${c.path} (${why})`);
  }

  return lines;
}

/**
 * ```
 * parsed: 1128 -> no-name dropped: 12 -> usable: 1116   (phone: 890, email-only: 226, neither: 0)
 * ```
 */
export function formatParseLine(stage: ParseStage): string {
  return (
    `[ContactsService] parsed: ${stage.rowsRead} -> no-name dropped: ${stage.droppedNoName}` +
    ` -> usable: ${stage.usable}` +
    `   (phone: ${stage.withPhone}, email-only: ${stage.emailOnly}, neither: ${stage.neither})` +
    `   [rows: ${stage.phoneRows} phone, ${stage.emailRows} email]`
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
 * picker: 1116 in (db 0 + external 1116) -> source-disabled 0 -> already-imported 105 -> dup-suppressed 336 -> shown 675
 * ```
 * Emitted in the order the handler actually applies the filters, so the
 * arithmetic closes: in - disabled - imported - dup = shown.
 */
export function formatPickerLine(stage: PickerStage): string {
  return (
    `[Contacts] picker: ${stage.rowsIn} in (db ${stage.dbRowsIn} + external ${stage.externalRowsIn})` +
    ` -> source-disabled ${stage.sourceDisabled}` +
    ` -> already-imported ${stage.alreadyImported}` +
    ` -> dup-suppressed ${stage.duplicateSuppressed}` +
    ` -> shown ${stage.shown}`
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
  };
}

/** Test-only: drop the snapshot so suites do not leak counts into each other. */
export function resetContactIngestionFunnel(): void {
  delete funnel.discovery;
  delete funnel.parse;
  delete funnel.shadowSync;
  delete funnel.picker;
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
