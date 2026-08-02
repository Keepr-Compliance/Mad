/**
 * Contacts section of the support-ticket diagnostics block — BACKLOG-2394
 *
 * A reporter filed nine tickets in one day. Five of them were answerable from
 * counts nobody collected, and every one of those tickets arrived carrying a
 * diagnostics block that said nothing whatsoever about contacts. Answering the
 * single question "how many address books does she have" took a 1 MB log that
 * turned out not to contain it, then a live investigation, then reading a
 * different machine's file layout by analogy. This module is that question,
 * answered in the first ticket.
 *
 * ============================================================================
 * LIVE vs RECORDED — the distinction that makes this section worth reading
 * ============================================================================
 *
 * Reporting only Keepr's own counts is close to useless: "675 contacts" looks
 * healthy right up until you learn the Mac holds 1,558. **The diagnostic value
 * is the GAP between the two**, so both halves are here and each is LABELLED.
 *
 * LIVE  — measured at ticket-submission time. A directory listing and a
 *         permission check; see `addressBookDiscovery` — it opens no database.
 *         `address books on disk: 3` stays true **even if a sync has never
 *         run**, which is exactly the case the old logs could not describe.
 *
 * RECORDED — observed DURING the last contacts read, from the BACKLOG-2391
 *         funnel. Re-running a contacts read because somebody filed a ticket
 *         would be slow, could block on a Full Disk Access prompt, and would
 *         describe a DIFFERENT run than the one they are complaining about.
 *         Every recorded group therefore carries its own timestamp and age: a
 *         stale number presented as current is what sent this investigation
 *         down the wrong path twice.
 *
 * ============================================================================
 * THE ZERO TRAP — the original bug, one level up
 * ============================================================================
 *
 * **If a read has never run, say so. Never emit zeros.** `contacts read: 0`
 * is read by a human as "this user has no contacts"; the truth is "we never
 * looked". That ambiguity is precisely what made the reporter's logs useless,
 * and it must not reappear in the tool built to fix it.
 *
 * This is enforced STRUCTURALLY rather than by convention: every recorded
 * field is `T | null`, nothing is initialised to `0`, and `null` renders as a
 * sentence rather than a number. A failed read is likewise distinguishable
 * from an empty one — `address books on disk: 3 · read 0 of 3 (failed 3)` is
 * a diagnosis; a bare `0` is a wrong answer stated confidently.
 *
 * ============================================================================
 * PII — non-negotiable
 * ============================================================================
 *
 * Counts, states, sizes and dates. NEVER a name, phone number, email address,
 * subject line, or an absolute path (absolute paths carry the account name).
 * Paths go through `redactAddressBookPath()`; failures are reported as a
 * CATEGORY, never as raw error text — error messages routinely embed the very
 * paths and addresses this block must not carry.
 */

import path from "path";
import { discoverAddressBooks } from "./addressBookDiscovery";
import {
  getContactIngestionFunnel,
  type ContactIngestionFunnel,
} from "./contactIngestionFunnel";

const { CONTACTS_BASE_DIR, DEFAULT_CONTACTS_DB } = require("../constants");

// ============================================
// TYPES
// ============================================

/**
 * Why the on-disk listing produced nothing usable. A CATEGORY, never the raw
 * error — see the PII note in the file header.
 */
export type AddressBookListingError =
  | "no-home-dir"
  | "permission"
  | "not-found"
  | "unknown";

/** LIVE: what is on this machine right now. No database is opened. */
export interface ContactsLiveDiagnostics {
  /**
   * macOS is the only platform with `.abcddb` stores. On Windows/Linux the
   * listing is not "0 address books", it is **not applicable** — and those are
   * different answers to a support engineer.
   */
  platform_supported: boolean;
  /**
   * Count of `.abcddb` files found, or `null` when the listing itself failed.
   * `null` is NOT zero: see the zero trap.
   */
  address_books_on_disk: number | null;
  /** Redacted, home/base-relative paths. Never absolute. */
  address_book_paths: string[];
  /** Set only when `address_books_on_disk` is null. */
  listing_error: AddressBookListingError | null;
  /**
   * Full Disk Access — the permission that gates reading those stores.
   *
   * `"n/a"` on non-macOS, where Full Disk Access does not exist as a concept.
   * Reporting `granted` there would be a confidently wrong line, and this block
   * is read by a human triaging a ticket: a wrong answer is worse than none.
   */
  full_disk_access: "granted" | "denied" | "unknown" | "n/a";
}

/**
 * The whole section. `recorded` is the raw funnel snapshot; it is deliberately
 * NOT flattened or defaulted here, so an absent stage stays absent rather than
 * becoming a zero on the way through.
 */
export interface ContactsDiagnostics {
  live: ContactsLiveDiagnostics;
  recorded: ContactIngestionFunnel;
  /**
   * Process uptime at collection, so "nothing recorded" can be qualified
   * honestly: the funnel snapshot is process-local, so a user who filed a
   * ticket 20 seconds after launching has no recorded half even though a sync
   * ran yesterday. Saying "not recorded since app start (uptime 20s)" is true;
   * saying "0 contacts" would be a lie.
   */
  uptime_seconds: number | null;
}

// ============================================
// COLLECTION (LIVE)
// ============================================

/** The default/empty LIVE half. Note: counts are `null`, NOT `0`. */
function defaultLive(): ContactsLiveDiagnostics {
  return {
    platform_supported: false,
    address_books_on_disk: null,
    address_book_paths: [],
    listing_error: null,
    full_disk_access: "unknown",
  };
}

/**
 * Map a filesystem error to a category. Raw `err.message` MUST NOT be carried
 * into the payload: ENOENT/EACCES messages embed the absolute path, which
 * contains the user's account name.
 */
function categorizeListingError(err: unknown): AddressBookListingError {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "ENOENT") return "not-found";
  return "unknown";
}

/**
 * Collect the LIVE half.
 *
 * `fullDiskAccess` is passed in rather than read here so this function stays a
 * pure-ish filesystem listing and the caller owns the (cached, possibly slow)
 * permission probe.
 */
export async function collectContactsLiveDiagnostics(options?: {
  homeDir?: string | null;
  platform?: string;
  fullDiskAccess?: "granted" | "denied" | "unknown";
}): Promise<ContactsLiveDiagnostics> {
  const live = defaultLive();

  const platform = options?.platform ?? process.platform;
  live.platform_supported = platform === "darwin";
  if (!live.platform_supported) {
    // Full Disk Access is a macOS concept. Whatever the caller passed, it has
    // no meaning here — force "n/a" rather than letting a stale "granted"
    // through, which would be a confidently wrong line on a Windows ticket.
    live.full_disk_access = "n/a";
    // Leave the count null. On Windows there are no `.abcddb` stores to find,
    // and reporting `0` would invite "she has no contacts" for a user whose
    // contacts arrive over the Android companion.
    return live;
  }

  live.full_disk_access = options?.fullDiskAccess ?? "unknown";

  const home = options?.homeDir ?? process.env.HOME ?? null;
  if (!home) {
    live.listing_error = "no-home-dir";
    return live;
  }

  const baseDir = path.join(home, CONTACTS_BASE_DIR);
  const defaultPath = path.join(home, DEFAULT_CONTACTS_DB);

  try {
    // Directory listing only — no database is opened. See addressBookDiscovery.
    const { books } = await discoverAddressBooks(baseDir, defaultPath);
    live.address_books_on_disk = books.length;
    live.address_book_paths = books.map((b) => b.redacted);
  } catch (err) {
    // discoverAddressBooks already swallows a denied readdir, so reaching here
    // means something more fundamental broke. Still a category, never a message.
    live.listing_error = categorizeListingError(err);
    live.address_books_on_disk = null;
    live.address_book_paths = [];
  }

  return live;
}

/** Assemble the whole section. Each half is independently guarded by the caller. */
export async function collectContactsDiagnostics(options?: {
  homeDir?: string | null;
  platform?: string;
  fullDiskAccess?: "granted" | "denied" | "unknown";
  uptimeSeconds?: number | null;
}): Promise<ContactsDiagnostics> {
  return {
    live: await collectContactsLiveDiagnostics(options),
    recorded: getContactIngestionFunnel(),
    uptime_seconds: options?.uptimeSeconds ?? null,
  };
}

// ============================================
// FORMATTING
// ============================================

/** How many redacted book paths to list before summarising. Keeps it a screen. */
const MAX_LISTED_PATHS = 6;

const INDENT = "                 ";

/**
 * `2026-07-28T14:02:00.000Z (3d ago)` — the timestamp AND its age, because a
 * reader triaging a ticket should not have to subtract dates to notice that a
 * number is three days stale.
 */
export function formatRecordedAt(at: string, now: number = Date.now()): string {
  const then = new Date(at).getTime();
  if (!Number.isFinite(then)) return `${at} (age unknown)`;

  const deltaMs = now - then;
  if (deltaMs < 0) return `${at} (clock skew)`;

  const mins = Math.floor(deltaMs / 60_000);
  const age =
    mins < 1
      ? "just now"
      : mins < 60
        ? `${mins}m ago`
        : mins < 60 * 24
          ? `${Math.floor(mins / 60)}h ago`
          : `${Math.floor(mins / (60 * 24))}d ago`;

  return `${at} (${age})`;
}

/** The LIVE lines. */
function formatLiveLines(live: ContactsLiveDiagnostics): string[] {
  const lines: string[] = [];

  let head: string;
  if (!live.platform_supported) {
    // Explicitly NOT "0".
    head = "address books on disk: n/a (macOS-only store)";
  } else if (live.address_books_on_disk === null) {
    head = `address books on disk: unknown (listing failed: ${live.listing_error ?? "unknown"})`;
  } else {
    head = `address books on disk: ${live.address_books_on_disk}`;
  }

  lines.push(`Contacts [live]  ${head}, FDA=${live.full_disk_access}`);

  const shown = live.address_book_paths.slice(0, MAX_LISTED_PATHS);
  for (const p of shown) lines.push(`${INDENT}  ${p}`);
  const hidden = live.address_book_paths.length - shown.length;
  if (hidden > 0) lines.push(`${INDENT}  …and ${hidden} more`);

  return lines;
}

/**
 * The RECORDED lines, or a single honest sentence when nothing was recorded.
 *
 * NOTE the shape of the "nothing recorded" branch: it names the reason and the
 * uptime, and contains **no counts at all**. Anything else here re-creates the
 * bug this module exists to remove.
 */
function formatRecordedLines(
  recorded: ContactIngestionFunnel,
  uptimeSeconds: number | null,
  now: number,
): string[] {
  const { discovery, parse, shadowSync, picker } = recorded;

  if (!discovery && !parse && !shadowSync && !picker) {
    const uptime =
      typeof uptimeSeconds === "number"
        ? ` (uptime ${uptimeSeconds}s)`
        : "";
    return [
      `Contacts [sync]  no contacts read recorded since app start${uptime} —` +
        ` this is NOT a count of zero, nothing has looked yet`,
    ];
  }

  const lines: string[] = [];

  if (discovery) {
    lines.push(`Contacts [sync @ ${formatRecordedAt(discovery.at, now)}]`);
    // read N of M — a partially-ingested set must never render as a clean run.
    lines.push(
      `${INDENT}read ${discovery.readCount} of ${discovery.found}` +
        (discovery.failedCount > 0 ? ` (failed ${discovery.failedCount})` : "") +
        (discovery.usedFallback ? " [default-path fallback]" : ""),
    );
    for (const c of discovery.candidates) {
      if (c.read) continue;
      // The two failure modes name different remedies — see AddressBookSkipReason.
      const why =
        c.skipReason === "load-error"
          ? "opened, then failed mid-read — store may be corrupt"
          : "could not open — check Full Disk Access";
      lines.push(`${INDENT}  FAILED: ${c.path} (${why})`);
    }
  } else {
    lines.push(
      `Contacts [sync]  no address-book read recorded since app start` +
        ` — not a count of zero`,
    );
  }

  if (parse) {
    lines.push(
      `${INDENT}parsed ${parse.rowsRead} rows from ${parse.books} book(s)` +
        ` -> usable ${parse.usable} (dropped ${parse.droppedRows}, nameless ${parse.nameless})` +
        `  [@ ${formatRecordedAt(parse.at, now)}]`,
    );
    lines.push(
      `${INDENT}  of usable: phone ${parse.withPhone}, email-only ${parse.emailOnly},` +
        ` neither ${parse.neither}`,
    );
  }

  if (shadowSync) {
    lines.push(
      `${INDENT}shadow ${shadowSync.source}: inserted ${shadowSync.inserted},` +
        ` updated ${shadowSync.updated}, unchanged ${shadowSync.unchanged},` +
        ` deleted ${shadowSync.deleted}, total ${shadowSync.total}` +
        `  [@ ${formatRecordedAt(shadowSync.at, now)}]`,
    );
  }

  if (picker) {
    lines.push(
      `${INDENT}picker ${picker.rowsIn} in (db ${picker.dbRowsIn} + external ${picker.externalRowsIn})` +
        ` -> shown ${picker.shown} (source-disabled ${picker.sourceDisabled},` +
        ` already-imported ${picker.alreadyImported}, dup-suppressed ${picker.duplicateSuppressed})` +
        `  [@ ${formatRecordedAt(picker.at, now)}]`,
    );
  }

  return lines;
}

/**
 * The composed Contacts section, LIVE first then RECORDED.
 *
 * LIVE goes first deliberately: it is the half that is always true. A reader
 * who stops after one line still learns how many address books the machine
 * holds, which is the question three investigations could not answer.
 */
export function formatContactsDiagnostics(
  diag: ContactsDiagnostics,
  now: number = Date.now(),
): string[] {
  return [
    ...formatLiveLines(diag.live),
    ...formatRecordedLines(diag.recorded, diag.uptime_seconds, now),
  ];
}
