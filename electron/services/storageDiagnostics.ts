/**
 * Storage section of the support-ticket diagnostics block — BACKLOG-2394
 *
 * Nine tickets in one day, five of them answerable from table sizes and
 * pipeline counts nobody collected. Concretely, the ones this module answers:
 *
 *   ticket 94  — phone search by area code returns nothing.
 *                `contact_phones: 1402 (normalized 0)` IS the answer: search
 *                cannot match what was never normalized.
 *   ticket 99  — contact added, her texts were not pulled.
 *                `messages: 8214 (2025-11-02 → 2026-07-28, deepest scan
 *                2025-11-02)` IS the answer: her texts predate the imported
 *                window. Without the deepest-scan point, "nothing found" and
 *                "never looked that far back" are the same line.
 *   ticket 100 — numbers not resolved to names.
 *                contacts-with-phones plus normalization coverage.
 *
 * ============================================================================
 * EVERYTHING HERE IS LIVE
 * ============================================================================
 *
 * `COUNT(*)` on indexed tables and two `stat()` calls, taken at ticket-
 * submission time against the database the app currently has open. There is no
 * recorded half and therefore no staleness — but see `available`: when the
 * database is not open, this section reports **why**, and reports no numbers at
 * all. Zeros from an unopened database would be the same lie the contacts
 * section exists to avoid.
 *
 * ============================================================================
 * PII
 * ============================================================================
 *
 * Counts, sizes, dates, versions. Never a name, address, subject or body, and
 * never an absolute path — the database path carries the account name, so only
 * its BASENAME is ever reported. Dates are calendar dates (`2026-07-28`), which
 * describe coverage rather than any individual record.
 */

import fs from "fs";
import path from "path";
import {
  CONTACTS_WITH_EMAIL_SQL,
  CONTACTS_WITH_NEITHER_SQL,
  CONTACTS_WITH_PHONE_SQL,
  EXISTING_TABLE_NAMES_SQL,
  PHONES_NORMALIZED_SQL,
  QUICK_CHECK_PRAGMA,
  SCHEMA_VERSION_SQL,
  countBySourceIn,
  countRowsIn,
  selectDateRangeIn,
  selectDeepestScannedIn,
  type DiagnosableDateColumn,
  type DiagnosableTable,
  type StorageQueryable,
} from "./db/storageDiagnosticsSql";

// ============================================
// TYPES
// ============================================

/**
 * The minimal synchronous handle this module needs (better-sqlite3-shaped).
 *
 * Defined in `db/storageDiagnosticsSql` — that is where the statements are now
 * prepared — and re-exported here so existing importers are unaffected.
 */
export type { StorageQueryable };

/** Why no numbers are being reported. A category, never a raw error. */
export type StorageUnavailableReason =
  | "db-not-initialized"
  | "db-path-unknown"
  | "query-failed";

export interface CoverageWindow {
  /** Rows present. `null` when the count itself could not be taken. */
  rows: number | null;
  /** Oldest / newest row, calendar date only. `null` when there are no rows. */
  oldest: string | null;
  newest: string | null;
  /**
   * How far back the importer has actually SCANNED, where the app records it.
   * This is the field that separates "nothing found back there" from "never
   * looked back there" — see ticket 99 in the header. `null` when the app has
   * no record of a scan, which is itself the answer.
   */
  deepest_scanned: string | null;
}

export interface StorageDiagnostics {
  available: boolean;
  unavailable_reason: StorageUnavailableReason | null;

  /** BASENAME only — the directory carries the account name. */
  db_file: string | null;
  db_bytes: number | null;
  /**
   * The sibling `-wal`. A large WAL against an old main file is a real signal:
   * one was observed at 3.9 MB against a main file three months stale.
   */
  wal_bytes: number | null;
  /**
   * `false` when there is demonstrably no `-wal` file (a checkpointed store —
   * normal), `null` when the stat failed for some other reason (genuinely
   * unknown). Without this, a healthy machine reports "wal unknown".
   */
  wal_present: boolean | null;
  /** Free space on the volume holding the database — silent write failures when full. */
  free_disk_bytes: number | null;

  schema_version: number | null;
  latest_schema_version: number | null;
  /** `true` when the on-disk version is behind the build's newest migration. */
  migration_pending: boolean | null;
  /**
   * `"skipped"` when the file is too large to check synchronously — see
   * QUICK_CHECK_MAX_BYTES. A missing integrity check is an acceptable gap; a
   * frozen app while somebody files a support ticket is not.
   */
  quick_check: "ok" | "failed" | "skipped" | null;
  /** Why it was skipped. Set only when `quick_check === "skipped"`. */
  quick_check_skipped: "db-too-large" | "size-unknown" | null;

  /** Row counts, only for tables that actually exist in this database. */
  tables: Record<string, number> | null;
  /** `external_contacts` broken down by source — the shadow table per origin. */
  external_contacts_by_source: Record<string, number> | null;
  /** `contacts` broken down by source. */
  contacts_by_source: Record<string, number> | null;

  data_quality: {
    contacts_with_phone: number | null;
    contacts_with_email: number | null;
    contacts_with_neither: number | null;
    phone_rows: number | null;
    /** Ticket 94: search cannot match what was never normalized. */
    phone_rows_normalized: number | null;
  } | null;

  coverage: {
    emails: CoverageWindow;
    messages: CoverageWindow;
  } | null;

  /** Date-parsing bugs are invisible without these. */
  locale: string | null;
  timezone: string | null;
}

// ============================================
// COLLECTION
// ============================================

/**
 * Tables worth counting. A whitelist rather than "every table in the schema":
 * the block is read by a human triaging a ticket, and forty rows of counts is
 * a wall nobody reads. Deep counts belong in BACKLOG-2393's extended report.
 *
 * `emails` and `messages` are deliberately ABSENT. They get their own coverage
 * lines, which carry the never-looked-versus-found-nothing distinction, and a
 * bare `messages=0` sitting in this list would quietly re-assert exactly the
 * thing the coverage line exists to deny.
 */
/**
 * Above this file size, `PRAGMA quick_check` is skipped rather than run on the
 * main process at ticket-submission time. 64 MB is well under the 253 MB store
 * that motivated the bound and still covers the majority of installs, where the
 * check completes in well under a second.
 */
const QUICK_CHECK_MAX_BYTES = 64 * 1024 * 1024;

const COUNTED_TABLES = [
  "contacts",
  "contact_phones",
  "contact_emails",
  "external_contacts",
  "email_participants",
  "attachments",
  "transactions",
  "transaction_contacts",
  "communications",
] as const;

function existingTables(db: StorageQueryable): Set<string> {
  const rows = db.prepare(EXISTING_TABLE_NAMES_SQL).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

/** `COUNT(*)`, or `null` if the query failed. Never a silent 0. */
function countRows(db: StorageQueryable, table: DiagnosableTable): number | null {
  try {
    // The table name is constrained by TYPE and by a runtime check in
    // `countRowsIn`, not by the comment that used to sit here.
    const row = countRowsIn(db, table);
    return typeof row?.n === "number" ? row.n : null;
  } catch {
    return null;
  }
}

/** `{ macos: 716, outlook: 682 }`, or null when the table/query is unavailable. */
function countBySource(
  db: StorageQueryable,
  table: DiagnosableTable,
): Record<string, number> | null {
  try {
    const rows = countBySourceIn(db, table);
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.source)] = r.n;
    return out;
  } catch {
    return null;
  }
}

/** `2026-07-28T14:02:00Z` -> `2026-07-28`. Coverage, not a per-record timestamp. */
function toDateOnly(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  return v.slice(0, 10);
}

function collectCoverage(
  db: StorageQueryable,
  tables: Set<string>,
  opts: {
    table: DiagnosableTable;
    dateColumn: DiagnosableDateColumn;
    deepestSql?: { table: DiagnosableTable; column: DiagnosableDateColumn };
  },
): CoverageWindow {
  const window: CoverageWindow = {
    rows: null,
    oldest: null,
    newest: null,
    deepest_scanned: null,
  };

  if (!tables.has(opts.table)) return window;

  window.rows = countRows(db, opts.table);
  try {
    const row = selectDateRangeIn(db, opts.table, opts.dateColumn);
    window.oldest = toDateOnly(row?.lo);
    window.newest = toDateOnly(row?.hi);
  } catch {
    /* leave nulls — an absent window is not an empty one */
  }

  if (opts.deepestSql && tables.has(opts.deepestSql.table)) {
    try {
      const row = selectDeepestScannedIn(
        db,
        opts.deepestSql.table,
        opts.deepestSql.column,
      );
      window.deepest_scanned = toDateOnly(row?.d);
    } catch {
      /* leave null */
    }
  }

  return window;
}

function collectDataQuality(
  db: StorageQueryable,
  tables: Set<string>,
): StorageDiagnostics["data_quality"] {
  if (!tables.has("contacts")) return null;

  const hasPhones = tables.has("contact_phones");
  const hasEmails = tables.has("contact_emails");

  /**
   * Runs a counting query and degrades to `null`.
   *
   * Takes a THUNK rather than a SQL string. Two reasons, and the first is a
   * behaviour guarantee rather than a style preference:
   *
   *  - `db.prepare(...)` is invoked INSIDE the `try`. Accepting a prepared
   *    statement instead would move `prepare` to the argument position, so a
   *    missing or corrupt table would throw out of this function rather than
   *    return `null` — turning a degrading diagnostics block into a crash in
   *    the support-ticket path whose whole purpose is to report what it could
   *    not read.
   *  - Each `.prepare()` keeps a `db/` constant as its argument, so all four
   *    sites stay ENUMERATED by the SQL boundary gate as COMPLIANT. Moving the
   *    execution into `db/` would have removed them from the census entirely;
   *    visible-and-compliant beats invisible-and-in-layer.
   */
  const scalar = (query: () => { n: number } | undefined): number | null => {
    try {
      const row = query();
      return typeof row?.n === "number" ? row.n : null;
    } catch {
      return null;
    }
  };

  return {
    contacts_with_phone: hasPhones
      ? scalar(() => db.prepare(CONTACTS_WITH_PHONE_SQL).get() as { n: number } | undefined)
      : null,
    contacts_with_email: hasEmails
      ? scalar(() => db.prepare(CONTACTS_WITH_EMAIL_SQL).get() as { n: number } | undefined)
      : null,
    contacts_with_neither:
      hasPhones && hasEmails
        ? scalar(
            () => db.prepare(CONTACTS_WITH_NEITHER_SQL).get() as { n: number } | undefined,
          )
        : null,
    phone_rows: hasPhones ? countRows(db, "contact_phones") : null,
    // Ticket 94. A large gap between these two IS the bug report.
    phone_rows_normalized: hasPhones
      ? scalar(() => db.prepare(PHONES_NORMALIZED_SQL).get() as { n: number } | undefined)
      : null,
  };
}

/**
 * `number` when the file was stat'd, `"missing"` when it demonstrably is not
 * there, `null` when the stat failed for any other reason.
 *
 * The three-way return is the same distinction the rest of this work turns on.
 * A `-wal` file is ABSENT on a checkpointed store — that is a normal, known
 * state — whereas a stat that fails for a permissions reason is genuinely
 * unknown. Collapsing them prints "wal unknown" on a perfectly healthy machine
 * and buries the case where we could not look.
 */
function statSize(p: string): number | "missing" | null {
  try {
    return fs.statSync(p).size;
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    return code === "ENOENT" ? "missing" : null;
  }
}

function statSizeOrNull(p: string): number | null {
  const s = statSize(p);
  return typeof s === "number" ? s : null;
}

function freeDiskBytes(forPath: string): number | null {
  try {
    // fs.statfsSync is Node 18.15+. Guarded because the typings/runtime pairing
    // varies across the Electron/Node matrix this ships on.
    const statfs = (fs as unknown as {
      statfsSync?: (p: string) => { bsize: number; bavail: number };
    }).statfsSync;
    if (!statfs) return null;
    const st = statfs(path.dirname(forPath));
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/**
 * Collect the whole section.
 *
 * `db` / `dbPath` / `latestSchemaVersion` are injected rather than reached for,
 * so this is drivable in a test against a real fixture database. The caller
 * (supportTicketService) supplies them from databaseService.
 */
export function collectStorageDiagnostics(input: {
  db: StorageQueryable | null;
  dbPath: string | null;
  latestSchemaVersion: number | null;
  locale?: string | null;
  timezone?: string | null;
}): StorageDiagnostics {
  const diag: StorageDiagnostics = {
    available: false,
    unavailable_reason: null,
    db_file: null,
    db_bytes: null,
    wal_bytes: null,
    wal_present: null,
    free_disk_bytes: null,
    schema_version: null,
    latest_schema_version: input.latestSchemaVersion ?? null,
    migration_pending: null,
    quick_check: null,
    quick_check_skipped: null,
    tables: null,
    external_contacts_by_source: null,
    contacts_by_source: null,
    data_quality: null,
    coverage: null,
    locale: input.locale ?? null,
    timezone: input.timezone ?? null,
  };

  // File-level facts do not need an open handle — a database that failed to
  // open still has a size, and that size is often the story.
  if (input.dbPath) {
    diag.db_file = path.basename(input.dbPath);
    diag.db_bytes = statSizeOrNull(input.dbPath);
    const wal = statSize(`${input.dbPath}-wal`);
    diag.wal_bytes = typeof wal === "number" ? wal : null;
    diag.wal_present = wal === "missing" ? false : wal === null ? null : true;
    diag.free_disk_bytes = freeDiskBytes(input.dbPath);
  } else {
    diag.unavailable_reason = "db-path-unknown";
  }

  if (!input.db) {
    diag.unavailable_reason = diag.unavailable_reason ?? "db-not-initialized";
    return diag;
  }

  let tables: Set<string>;
  try {
    tables = existingTables(input.db);
  } catch {
    diag.unavailable_reason = "query-failed";
    return diag;
  }

  diag.available = true;

  // Schema version + pending migration.
  if (tables.has("schema_version")) {
    try {
      const row = input.db.prepare(SCHEMA_VERSION_SQL).get() as
        | { version: number }
        | undefined;
      diag.schema_version = typeof row?.version === "number" ? row.version : null;
    } catch {
      /* leave null */
    }
  }
  if (diag.schema_version !== null && diag.latest_schema_version !== null) {
    diag.migration_pending = diag.schema_version < diag.latest_schema_version;
  }

  // `PRAGMA quick_check` is SYNCHRONOUS and O(database size). This runs on the
  // main process the moment a user hits Submit on a support ticket, and the
  // reporting user's database is 253 MB — checking it would freeze the app
  // while somebody is trying to tell us the app is broken, which would make
  // the diagnostics tool the reason they need support. SQLite offers no
  // time-bounded variant, so the bound is on file size.
  //
  // A skipped integrity check is an acceptable gap; it is reported as
  // "skipped", never silently as "ok".
  if (diag.db_bytes === null) {
    diag.quick_check = "skipped";
    diag.quick_check_skipped = "size-unknown";
  } else if (diag.db_bytes > QUICK_CHECK_MAX_BYTES) {
    diag.quick_check = "skipped";
    diag.quick_check_skipped = "db-too-large";
  } else {
    try {
      const res = input.db.pragma(QUICK_CHECK_PRAGMA, { simple: true });
      diag.quick_check = res === "ok" ? "ok" : "failed";
    } catch {
      /* leave null — unknown, not "failed" */
    }
  }

  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    if (!tables.has(t)) continue;
    const n = countRows(input.db, t);
    if (n !== null) counts[t] = n;
  }
  diag.tables = counts;

  if (tables.has("external_contacts")) {
    diag.external_contacts_by_source = countBySource(input.db, "external_contacts");
  }
  if (tables.has("contacts")) {
    diag.contacts_by_source = countBySource(input.db, "contacts");
  }

  diag.data_quality = collectDataQuality(input.db, tables);

  diag.coverage = {
    emails: collectCoverage(input.db, tables, {
      table: "emails",
      dateColumn: "sent_at",
      deepestSql: { table: "email_sync_state", column: "oldest_cached_at" },
    }),
    messages: collectCoverage(input.db, tables, {
      table: "messages",
      dateColumn: "sent_at",
      deepestSql: { table: "message_import_state", column: "deepest_import_start" },
    }),
  };

  return diag;
}

// ============================================
// FORMATTING
// ============================================

const INDENT = "                 ";

/** `253.0MB`. Sizes are read by a human, not diffed by a machine. */
export function formatBytes(n: number | null): string {
  if (n === null) return "unknown";
  if (n < 1024) return `${n}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)}${units[i]}`;
}

/** `contacts=675, emails=12403` — `null` counts are omitted, never shown as 0. */
function formatCounts(counts: Record<string, number> | null): string {
  if (!counts) return "unavailable";
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries.map(([k, v]) => `${k}=${v}`).join(", ");
}

/**
 * The coverage line, and the one place the zero trap bites hardest.
 *
 * `messages: 0` says "this user has no texts". The truth might be "the importer
 * has never run". Those get different sentences here, and neither of them is a
 * bare zero.
 */
function formatCoverage(name: string, w: CoverageWindow): string {
  if (w.rows === null) return `${name}: unavailable`;

  if (w.rows === 0) {
    return w.deepest_scanned
      ? `${name}: 0 rows — imported back to ${w.deepest_scanned} and found none`
      : `${name}: 0 rows, and NO import has been recorded — never looked, not empty`;
  }

  const window =
    w.oldest && w.newest ? ` (${w.oldest} → ${w.newest})` : " (date range unknown)";
  const deepest = w.deepest_scanned
    ? `, scanned back to ${w.deepest_scanned}`
    : ", deepest scan point not recorded";
  return `${name}: ${w.rows}${window}${deepest}`;
}

/**
 * `ok` / `failed` / `skipped (db too large)` / `unknown`.
 *
 * "skipped" must be visibly distinct from "ok": a triager reading `ok` will
 * conclude the database has been verified intact, and on a large store nothing
 * has been verified at all.
 */
function formatQuickCheck(diag: StorageDiagnostics): string {
  if (diag.quick_check === "skipped") {
    const why =
      diag.quick_check_skipped === "db-too-large"
        ? "db too large"
        : "db size unknown";
    return `skipped (${why})`;
  }
  return diag.quick_check ?? "unknown";
}

export function formatStorageDiagnostics(diag: StorageDiagnostics): string[] {
  const lines: string[] = [];

  // "wal none" on a checkpointed store, "wal unknown" only when we could not
  // look. See statSize() — a healthy machine must not read as an unknown one.
  const wal =
    diag.wal_present === false ? "none" : formatBytes(diag.wal_bytes);
  const fileFacts =
    `db=${formatBytes(diag.db_bytes)} (wal ${wal}),` +
    ` free=${formatBytes(diag.free_disk_bytes)}`;

  if (!diag.available) {
    lines.push(
      `Storage  [live]  unavailable (${diag.unavailable_reason ?? "unknown"}) — ${fileFacts}`,
    );
    return lines;
  }

  const schema =
    diag.schema_version === null
      ? "schema_version=unknown"
      : `schema_version=${diag.schema_version}` +
        (diag.latest_schema_version === null
          ? ""
          : diag.migration_pending
            ? ` (latest ${diag.latest_schema_version}, MIGRATION PENDING)`
            : ` (latest ${diag.latest_schema_version}, up to date)`);

  lines.push(`Storage  [live]  ${fileFacts}`);
  lines.push(
    `${INDENT}${schema}, quick_check=${formatQuickCheck(diag)}`,
  );
  lines.push(`${INDENT}rows: ${formatCounts(diag.tables)}`);

  if (diag.contacts_by_source) {
    lines.push(`${INDENT}contacts by source: ${formatCounts(diag.contacts_by_source)}`);
  }
  if (diag.external_contacts_by_source) {
    lines.push(
      `${INDENT}external by source: ${formatCounts(diag.external_contacts_by_source)}`,
    );
  }

  const dq = diag.data_quality;
  if (dq) {
    const num = (v: number | null): string => (v === null ? "unknown" : String(v));
    lines.push(
      `${INDENT}contacts with: phone ${num(dq.contacts_with_phone)},` +
        ` email ${num(dq.contacts_with_email)}, neither ${num(dq.contacts_with_neither)}`,
    );
    // Ticket 94 lives on this line.
    lines.push(
      `${INDENT}phone rows: ${num(dq.phone_rows)}` +
        ` (normalized ${num(dq.phone_rows_normalized)})`,
    );
  }

  if (diag.coverage) {
    lines.push(`${INDENT}${formatCoverage("emails", diag.coverage.emails)}`);
    lines.push(`${INDENT}${formatCoverage("messages", diag.coverage.messages)}`);
  }

  lines.push(
    `${INDENT}locale=${diag.locale ?? "unknown"}, tz=${diag.timezone ?? "unknown"}`,
  );

  return lines;
}
