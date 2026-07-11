/**
 * QA Harness — export-deliverable MEASUREMENT helpers (BACKLOG-1852 / QA-H5).
 *
 * Pure, fs-light readers that turn a desktop export deliverable into raw
 * `(subject, shiftedDate)` members + structural deviations. The set-IDENTITY
 * semantics (MULTISET diff, exact-count eval) live in H1's `diff.ts` /
 * `canonicalList.ts` (BACKLOG-1848) and are applied by the runner; the
 * date-identity (source-timezone conversion) is REUSED from H3's
 * `db-set-diff-core.js` (BACKLOG-1850) — this module does NOT reimplement it.
 *
 * ── WHY the email set comes from a LOSSLESS deliverable (load-bearing) ──────
 * `folderExportService.exportTransactionToFolder` emits `emails/` as PDFs whose
 * filenames are LOSSY for exact set-identity:
 *   - `sanitizeFileName` collapses + TRUNCATES the subject to 100 chars, so two
 *     distinct subjects can map to one filename; and
 *   - the filename date is `new Date(sent_at).toISOString()` = the UTC calendar
 *     day, from which the canonical checklist's LOCAL (source-tz) shifted date
 *     cannot be recovered for the 4 evening rows that roll +1 day in UTC.
 * Therefore the EXACT `(subject, shiftedDate)` gate is driven from a lossless
 * deliverable — `enhancedExportService` TXT/EML (`emails/*.eml`, RFC822
 * `Subject:` + `Date:`) or JSON (`communications[].subject` + `sent_at`) — with
 * the timestamp converted into the scenario's `sourceTimezone` via H3's
 * `shiftedDateOf`. The `folderExportService` audit folder supplies the
 * `attachments/manifest.json` structural gate. See BACKLOG-1852.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * SET-IDENTITY RULE (mirrors H1 types.ts): membership is keyed by
 * (subject, shiftedDate) — NEVER Message-ID. Membership is a MULTISET (canonical
 * rows 20/21 are two distinct emails on the same key), so these readers do NOT
 * de-duplicate.
 *
 * STRUCTURAL DEVIATIONS: manifest/structure findings are expressed as
 * `CountDeviation`. Numeric cells (attachmentCount) carry expected/got directly;
 * boolean cells (a field must be present/valid) use the convention expected=1
 * (present/valid) vs got=0 (absent/invalid).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CountDeviation, EmailSetMember } from './types';

// Reuse H3's timezone-correct date identity (BACKLOG-1850) — do NOT reimplement.
// db-set-diff-core.js is a dependency-free CommonJS helper require-able from both
// TS (ts-node / ts-jest, CommonJS) and the Electron measurement shell.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dbCore = require('./db-set-diff-core') as {
  shiftedDateOf(sentAt: string | null | undefined, timeZone?: string): string;
};

/** Default source timezone when the scenario omits `sourceTimezone`. */
export const DEFAULT_SOURCE_TZ = 'America/Los_Angeles';

/**
 * The admin-portal audit-log CSV header (mirrors
 * `admin-portal/lib/audit-export.ts` `CSV_HEADERS`). The BROKER export variant
 * is DEFERRED (FOUNDER DECISION 3) — this constant + `assertBrokerAuditCsvSchema`
 * exist only as the trivially-cheap row/schema check the plan permits; they are
 * NOT wired into the transaction ceremony (a broker export = audit logs, not the
 * transaction deliverable).
 */
export const BROKER_AUDIT_CSV_HEADERS: readonly string[] = [
  'id',
  'created_at',
  'action',
  'target_type',
  'target_id',
  'target_email',
  'target_name',
  'actor_id',
  'actor_email',
  'actor_name',
  'ip_address',
  'user_agent',
  'metadata',
];

// ---------------------------------------------------------------------------
// EML deliverable (enhancedExportService `_exportTxtEml` / `_createEMLContent`)
// ---------------------------------------------------------------------------

/**
 * Parse the `Subject:` and `Date:` headers from RFC822 `.eml` text. Headers end
 * at the first blank line (matching `_createEMLContent`, which writes single-line
 * unfolded headers). Only the first occurrence of each header is used.
 */
export function parseEmlHeaders(emlText: string): { subject: string; date: string } {
  let subject = '';
  let date = '';
  for (const line of emlText.split(/\r?\n/)) {
    if (line === '') break; // header/body boundary
    if (!subject && /^Subject:/i.test(line)) {
      subject = line.replace(/^Subject:/i, '').trim();
    } else if (!date && /^Date:/i.test(line)) {
      date = line.replace(/^Date:/i, '').trim();
    }
  }
  return { subject, date };
}

/**
 * Turn one `.eml`'s text into an EmailSetMember. The RFC822 `Date:` (written by
 * the app as `toUTCString()`) is normalised to an ISO instant and then converted
 * into `timeZone` via H3's `shiftedDateOf`, so the 4 evening rows that render as
 * the next UTC day resolve to their LOCAL (canonical) shifted date.
 */
export function emlToMember(emlText: string, timeZone: string): EmailSetMember {
  const { subject, date } = parseEmlHeaders(emlText);
  let iso: string | null = null;
  if (date) {
    const d = new Date(date);
    if (!Number.isNaN(d.getTime())) iso = d.toISOString();
  }
  return { subject: subject.trim(), shiftedDate: dbCore.shiftedDateOf(iso, timeZone) };
}

// ---------------------------------------------------------------------------
// JSON deliverable (enhancedExportService `_exportJSON`)
// ---------------------------------------------------------------------------

interface JsonExportComm {
  type?: string;
  subject?: string;
  sent_at?: string;
}
interface JsonExport {
  communications?: JsonExportComm[];
}

const TEXT_TYPES = new Set(['sms', 'imessage', 'text', 'rcs', 'mms']);

/** Email iff the communication type is not a known text/mobile type. */
export function isEmailType(type?: string): boolean {
  if (!type) return true; // app default fallback is "email"
  return !TEXT_TYPES.has(type.toLowerCase());
}

/**
 * Turn an enhancedExportService JSON export into the email member set, filtering
 * out text/mobile communications. `sent_at` is the raw DB UTC value, converted to
 * `timeZone` via H3's `shiftedDateOf`.
 */
export function jsonExportToMembers(jsonText: string, timeZone: string): EmailSetMember[] {
  const data = JSON.parse(jsonText) as JsonExport;
  const comms = Array.isArray(data.communications) ? data.communications : [];
  return comms
    .filter((c) => isEmailType(c.type))
    .map((c) => ({
      subject: (c.subject ?? '').trim(),
      shiftedDate: dbCore.shiftedDateOf(c.sent_at ?? null, timeZone),
    }));
}

// ---------------------------------------------------------------------------
// attachments/manifest.json gate (folderExportService.exportAttachments)
// ---------------------------------------------------------------------------

export interface ManifestValidationOptions {
  /** When set, the manifest's `attachments[]` length must equal this. */
  expectedAttachmentCount?: number;
  /** When set, `manifest.transactionId` must equal this. */
  expectedTransactionId?: string;
  /** When set, `manifest.propertyAddress` must equal this. */
  expectedPropertyAddress?: string;
}

export interface ManifestValidation {
  deviations: CountDeviation[];
  attachmentCount: number;
}

const VALID_ATTACHMENT_STATUS = new Set(['exported', 'file_not_found', 'copy_failed']);

/**
 * Validate a parsed `attachments/manifest.json` object against the shape written
 * by `folderExportService.exportAttachments`, plus any provided expectations.
 */
export function validateManifest(
  manifestJson: unknown,
  options: ManifestValidationOptions = {},
): ManifestValidation {
  const deviations: CountDeviation[] = [];

  if (typeof manifestJson !== 'object' || manifestJson === null) {
    deviations.push({ cell: 'manifest.json', expected: 1, got: 0 });
    return { deviations, attachmentCount: 0 };
  }
  const m = manifestJson as Record<string, unknown>;

  for (const field of ['transactionId', 'propertyAddress', 'exportDate'] as const) {
    if (typeof m[field] !== 'string' || (m[field] as string).length === 0) {
      deviations.push({ cell: `manifest.${field}`, expected: 1, got: 0 });
    }
  }

  const attachments = Array.isArray(m.attachments)
    ? (m.attachments as Array<Record<string, unknown>>)
    : null;
  if (!attachments) {
    deviations.push({ cell: 'manifest.attachments', expected: 1, got: 0 });
    return { deviations, attachmentCount: 0 };
  }
  const attachmentCount = attachments.length;

  let badEntries = 0;
  for (const a of attachments) {
    const okFilename = typeof a.filename === 'string' && (a.filename as string).length > 0;
    const okStatus = a.status === undefined || VALID_ATTACHMENT_STATUS.has(String(a.status));
    if (!okFilename || !okStatus) badEntries++;
  }
  if (badEntries > 0) {
    deviations.push({ cell: 'manifest.attachments.shape', expected: 0, got: badEntries });
  }

  if (
    options.expectedTransactionId !== undefined &&
    m.transactionId !== options.expectedTransactionId
  ) {
    deviations.push({ cell: 'manifest.transactionId', expected: 1, got: 0 });
  }
  if (
    options.expectedPropertyAddress !== undefined &&
    m.propertyAddress !== options.expectedPropertyAddress
  ) {
    deviations.push({ cell: 'manifest.propertyAddress', expected: 1, got: 0 });
  }
  if (
    options.expectedAttachmentCount !== undefined &&
    attachmentCount !== options.expectedAttachmentCount
  ) {
    deviations.push({
      cell: 'attachmentCount',
      expected: options.expectedAttachmentCount,
      got: attachmentCount,
    });
  }

  // Optional emailAttachments block: exportedCount must match items.length.
  const ea = m.emailAttachments;
  if (ea && typeof ea === 'object') {
    const e = ea as Record<string, unknown>;
    const items = Array.isArray(e.items) ? e.items : [];
    if (typeof e.exportedCount === 'number' && e.exportedCount !== items.length) {
      deviations.push({
        cell: 'manifest.emailAttachments.exportedCount',
        expected: items.length,
        got: e.exportedCount,
      });
    }
  }

  return { deviations, attachmentCount };
}

// ---------------------------------------------------------------------------
// Deliverable discovery + read
// ---------------------------------------------------------------------------

function isDirSafe(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listFilesWithExt(dir: string, ext: string): string[] {
  if (!isDirSafe(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * JSON export candidates in `dir`, EXCLUDING `manifest.json` (which is the
 * attachments manifest, never a communications export) so discovery never
 * misclassifies a folderExport folder's manifest as the email source.
 */
function listJsonExports(dir: string): string[] {
  return listFilesWithExt(dir, '.json').filter(
    (f) => path.basename(f).toLowerCase() !== 'manifest.json',
  );
}

export type EmailSourceKind = 'eml' | 'json' | 'none';

type EmailSource =
  | { kind: 'eml'; files: string[] }
  | { kind: 'json'; file: string }
  | { kind: 'none' };

/**
 * Locate the lossless email source under `root`, preferring EML then JSON, at
 * `<root>` first and then one directory level down (a ceremony root may hold the
 * folderExport folder AND a txt_eml / json sibling).
 */
export function findEmailSource(root: string): EmailSource {
  const directEml = listFilesWithExt(path.join(root, 'emails'), '.eml');
  if (directEml.length) return { kind: 'eml', files: directEml };

  const directJson = listJsonExports(root);
  if (directJson.length) return { kind: 'json', file: directJson[0] };

  if (isDirSafe(root)) {
    const subs = fs.readdirSync(root).sort().map((e) => path.join(root, e)).filter(isDirSafe);
    for (const sub of subs) {
      const subEml = listFilesWithExt(path.join(sub, 'emails'), '.eml');
      if (subEml.length) return { kind: 'eml', files: subEml };
    }
    for (const sub of subs) {
      const subJson = listJsonExports(sub);
      if (subJson.length) return { kind: 'json', file: subJson[0] };
    }
  }
  return { kind: 'none' };
}

/** Locate `attachments/manifest.json` under `root` or one level down. */
export function findManifest(root: string): string | null {
  const direct = path.join(root, 'attachments', 'manifest.json');
  if (fs.existsSync(direct)) return direct;
  if (isDirSafe(root)) {
    for (const entry of fs.readdirSync(root).sort()) {
      const candidate = path.join(root, entry, 'attachments', 'manifest.json');
      if (isDirSafe(path.join(root, entry)) && fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface DeliverableOptions {
  timeZone: string;
  expectedAttachmentCount?: number;
  expectedTransactionId?: string;
  expectedPropertyAddress?: string;
}

export interface DeliverableResult {
  /** Lossless email set (empty when only a folderExport PDF folder is present). */
  exportedEmails: EmailSetMember[];
  /** Structural (manifest/structure) deviations; email-set diff is done by the runner. */
  deviations: CountDeviation[];
  detail: string;
  emailSource: EmailSourceKind;
  manifestFound: boolean;
}

/**
 * Read an export deliverable at `root`: derive the lossless email set (if an
 * EML/JSON source is present) and validate `attachments/manifest.json` (if
 * present). Returns raw members for the runner to diff against the canonical set.
 */
export function readExportDeliverable(root: string, options: DeliverableOptions): DeliverableResult {
  const deviations: CountDeviation[] = [];
  let exportedEmails: EmailSetMember[] = [];

  const src = findEmailSource(root);
  if (src.kind === 'eml') {
    exportedEmails = src.files.map((f) => emlToMember(fs.readFileSync(f, 'utf8'), options.timeZone));
  } else if (src.kind === 'json') {
    exportedEmails = jsonExportToMembers(fs.readFileSync(src.file, 'utf8'), options.timeZone);
  }

  const manifestPath = findManifest(root);
  const manifestFound = manifestPath !== null;
  if (manifestPath) {
    let parsed: unknown = null;
    let parseOk = true;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      parseOk = false;
      deviations.push({ cell: 'manifest.json', expected: 1, got: 0 });
    }
    if (parseOk) {
      const mv = validateManifest(parsed, {
        expectedAttachmentCount: options.expectedAttachmentCount,
        expectedTransactionId: options.expectedTransactionId,
        expectedPropertyAddress: options.expectedPropertyAddress,
      });
      deviations.push(...mv.deviations);
    }
  }

  if (src.kind === 'none' && !manifestFound) {
    // Not a recognizable deliverable at all (nothing to assert against).
    deviations.push({ cell: 'deliverable', expected: 1, got: 0 });
  }

  const detail =
    `emailSource=${src.kind}(${exportedEmails.length}) ` +
    `manifest=${manifestFound ? 'found' : 'absent'} ` +
    `structuralDeviations=${deviations.length}`;

  return { exportedEmails, deviations, detail, emailSource: src.kind, manifestFound };
}

// ---------------------------------------------------------------------------
// Broker audit-log CSV schema check (DEFERRED variant — schema shape only)
// ---------------------------------------------------------------------------

/** Split one CSV row into fields, honouring double-quoted fields ("" = literal "). */
export function splitCsvRow(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQuotes) {
      if (ch === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * DEFERRED broker variant: assert an admin-portal audit-log CSV's row/schema
 * shape only — header row equals the expected columns and every data row has the
 * matching field count. This does NOT assert the transaction deliverable.
 */
export function assertBrokerAuditCsvSchema(
  csvText: string,
  expectedHeaders: readonly string[] = BROKER_AUDIT_CSV_HEADERS,
): CountDeviation[] {
  const deviations: CountDeviation[] = [];
  const lines = csvText.replace(/\r\n/g, '\n').split('\n');
  // Drop a single trailing empty line (common with a terminal newline).
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  if (lines.length === 0) {
    deviations.push({ cell: 'broker.csv.header', expected: expectedHeaders.length, got: 0 });
    return deviations;
  }

  const header = splitCsvRow(lines[0]);
  const headerMatches =
    header.length === expectedHeaders.length &&
    header.every((h, i) => h === expectedHeaders[i]);
  if (!headerMatches) {
    deviations.push({ cell: 'broker.csv.header', expected: expectedHeaders.length, got: header.length });
  }

  let badRows = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;
    if (splitCsvRow(lines[i]).length !== expectedHeaders.length) badRows++;
  }
  if (badRows > 0) {
    deviations.push({ cell: 'broker.csv.rowShape', expected: 0, got: badRows });
  }
  return deviations;
}
