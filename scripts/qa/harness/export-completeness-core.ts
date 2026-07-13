/**
 * EXPORT-COMPLETENESS cell — shared core (BACKLOG-1983, P2-C7).
 *
 * Reusable helpers for the Playwright spec (e2e/tests/export-completeness.spec.ts) that proves the
 * desktop combined-PDF export (transactions:export-pdf → BACKLOG-1584 single-HTML combined PDF) really
 * CONTAINS every DB-linked email communication. Mirrors the BACKLOG-1982 delete-emails-core pattern:
 *
 *   1. EXPECTED constants — the FROZEN 4-item linked set the seeder plants under
 *      KEEPR_QA_EXPORT_COMPLETENESS=1 (match-1..4), each with a UNIQUE ASCII body marker. These are the
 *      HARDCODED oracle the spec asserts BOTH directions against (a compile-time constant, NOT read from
 *      the DB — so an under-link that shrinks the DB set is caught, not hidden). A qa:test cross-check
 *      (export-completeness-core.test.ts) asserts these agree with the seed-fixture.js exports (no drift).
 *   2. diffCompleteness — a PURE function comparing an expected marker set against an observed marker set
 *      (found in the PDF text / DB rows). Unit-tested with NO app launch and NO pdfjs import.
 *   3. readLinkedCommsContent — OBSERVE the actual linked-communication CONTENT rows (subject + body)
 *      from the encrypted DB via the read-comms-content.js cipher-open reader (verify-by-observing). This
 *      is the exact JOIN the PDF is built from, so DB set == rendered set.
 *   4. extractPdfText — extract selectable text from the generated PDF via pdfjs-dist (a transitive dep;
 *      printToPDF emits real text, not raster). Uses a DYNAMIC import so this module stays require-able
 *      from ts-jest (CommonJS) — the pure helpers + constants are importable by the unit test without
 *      pulling in pdfjs's ESM build. Only the spec (Playwright/Node) calls extractPdfText.
 *
 * PURE-NODE: no Playwright/Electron/DOM import here (the reader spawn is Node child_process; pdfjs is a
 * dynamic import), so the expected/diff logic is unit-testable and type-checked by the harness tsconfig.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The FROZEN linked set the seeder plants under KEEPR_QA_EXPORT_COMPLETENESS=1. MUST agree with
 * seed-fixture.js EXPORT_COMPLETENESS_LINKED_EMAIL_IDS / EXPORT_COMPLETENESS_BODY_MARKERS (the writer).
 * Duplicated here (the seeder runs in a separate Electron-main process) with a qa:test cross-check that
 * asserts the two agree — matching the delete-emails-core / users-roles-core precedent.
 *
 * Each marker is a UNIQUE, single-token, ASCII, wrap-proof string embedded in the email body — a lone
 * alphanumeric token cannot be split across a PDF line wrap and needs no unicode normalization (unlike
 * the em-dash subjects), so `pdfText.includes(marker)` is a robust identity signal.
 */
export const EXPECTED_LINKED_EMAILS: ReadonlyArray<{ emailId: string; marker: string }> = Object.freeze([
  { emailId: 'qa-seed-email-match-1', marker: 'KEEPRPDFMARKERALPHA' },
  { emailId: 'qa-seed-email-match-2', marker: 'KEEPRPDFMARKERBRAVO' },
  { emailId: 'qa-seed-email-match-3', marker: 'KEEPRPDFMARKERCHARLIE' },
  { emailId: 'qa-seed-email-match-4', marker: 'KEEPRPDFMARKERDELTA' },
]);

/** The expected marker SET (sorted, deduped) — the hardcoded oracle for both directions. */
export const EXPECTED_MARKERS: readonly string[] = Object.freeze(
  [...new Set(EXPECTED_LINKED_EMAILS.map((e) => e.marker))].sort(),
);

/** The mailbox oauth_tokens id the covering email_sync_state row keys on (mirrors seed-fixture.js). */
export const EXPORT_COMPLETENESS_ACCOUNT_ID = 'qa-seed-token-google-mailbox';

/**
 * PURE: strip ALL whitespace from a string. Shared by the marker matcher and the secondary subject
 * matcher so BOTH normalize pdfjs's arbitrary intra-token spacing the same way (BACKLOG-1983).
 */
export function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, '');
}

// -----------------------------------------------------------------------------
// PURE completeness diff (unit-tested; no pdfjs / spawn).
// -----------------------------------------------------------------------------

export interface CompletenessDiff {
  /** Expected markers NOT present in the observed set (a real export/link loss → FAIL). */
  missing: string[];
  /** Observed markers NOT in the expected set (an OVER-link / stray content → FAIL). */
  unexpected: string[];
  /** True iff the observed set equals the expected set exactly (both directions). */
  ok: boolean;
}

/**
 * PURE: compare an expected marker set against an observed marker set (order-insensitive, set-exact).
 * `observedContainsExpected(marker)` decides membership — for PDF text this is `text.includes(marker)`,
 * for DB rows it is a Set lookup. Returns BOTH directions so an under-link (missing) and an over-link
 * (unexpected) are each surfaced.
 */
export function diffCompleteness(
  expected: readonly string[],
  observed: readonly string[],
): CompletenessDiff {
  const expectedSet = new Set(expected);
  const observedSet = new Set(observed);
  const missing = [...expectedSet].filter((m) => !observedSet.has(m)).sort();
  const unexpected = [...observedSet].filter((m) => !expectedSet.has(m)).sort();
  return { missing, unexpected, ok: missing.length === 0 && unexpected.length === 0 };
}

/**
 * PURE: which of the given markers appear in `pdfText` (via substring). Returned SORTED + deduped so a
 * caller can compare the found set to EXPECTED_MARKERS with diffCompleteness.
 *
 * WHITESPACE-ROBUST (BACKLOG-1983): pdfjs splits a run of glyphs at kerning/glyph boundaries, and
 * extractPdfText joins those text items with spaces, so a single-token marker can surface as
 * `KEEPRPDFMARKERBRA V O` in the extracted text. Because the EXPECTED markers are whitespace-free ASCII
 * tokens, stripping ALL whitespace from BOTH the haystack and each marker before the substring test is
 * still an EXACT identity check (a marker only matches its own contiguous glyph run) — it does NOT weaken
 * the assertion, it just tolerates pdfjs's arbitrary intra-token spacing. Markers being whitespace-free
 * means `marker.replace(/\s+/g, '')` is a no-op on them; the normalization only affects the PDF text.
 */
export function markersFoundInText(text: string, markers: readonly string[]): string[] {
  const collapsed = stripWhitespace(text);
  return [...new Set(markers.filter((m) => collapsed.includes(stripWhitespace(m))))].sort();
}

/**
 * PURE: does `subject` appear in `pdfText`? The SECONDARY (non–load-bearing) completeness signal. Uses
 * the SAME whitespace-STRIP normalization as markersFoundInText (BACKLOG-1983) — pdfjs joins glyph runs
 * with spaces, so a subject can surface with intra-token spacing (e.g. "B i r c hw ood"); full-stripping
 * BOTH sides keeps the substring test exact while tolerating the split. Em/en dashes are normalized to a
 * hyphen on both sides so a subject rendered with a differing dash glyph still matches. An EMPTY subject
 * returns `true` (vacuous — a blank subject must never false-FAIL the secondary signal).
 */
export function subjectFoundInText(pdfText: string, subject: string): boolean {
  const normalize = (s: string): string => stripWhitespace(s.replace(/[—–]/g, '-'));
  const needle = normalize(subject);
  if (needle.length === 0) return true;
  return normalize(pdfText).includes(needle);
}

// -----------------------------------------------------------------------------
// DB oracle: the linked-communication CONTENT rows (subject + body) the PDF renders.
// -----------------------------------------------------------------------------

/** One linked-email CONTENT row as OBSERVED from the encrypted DB by read-comms-content.js. */
export interface CommContentRow {
  email_id: string | null;
  subject: string | null;
  body_text: string | null;
  sent_at: string | null;
}

const COMMS_CONTENT_SENTINEL = '__QA_COMMS_CONTENT__ ';

/**
 * OBSERVE the linked-email content ROWS for a transaction (the exact set the combined PDF is built
 * from). Throws (→ HARNESS_ERROR upstream) on a launch / decrypt / parse failure. ROWS, not a scalar.
 */
export function readLinkedCommsContent(
  repoRoot: string,
  electronBin: string,
  dbKey: string,
  dbPath: string,
  transactionId: string,
): CommContentRow[] {
  const script = join(repoRoot, 'scripts', 'qa', 'harness', 'read-comms-content.js');
  const run = spawnSync(
    electronBin,
    [script, '--db', dbPath, '--key', dbKey, '--transaction-id', transactionId],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '0' },
      timeout: 30_000,
      killSignal: 'SIGKILL',
    },
  );
  if (run.error) throw new Error(`read-comms-content failed to launch: ${run.error.message}`);
  const line = (run.stdout || '')
    .split('\n')
    .find((l) => l.includes(COMMS_CONTENT_SENTINEL));
  if (!line) {
    throw new Error(
      `read-comms-content produced no result (exit ${run.status ?? 'null'}).\n${run.stderr || ''}`,
    );
  }
  const parsed = JSON.parse(
    line.slice(line.indexOf(COMMS_CONTENT_SENTINEL) + COMMS_CONTENT_SENTINEL.length),
  ) as { rows?: CommContentRow[]; error?: string };
  if (parsed.error) throw new Error(`read-comms-content error: ${parsed.error}`);
  return parsed.rows ?? [];
}

/**
 * The set of body markers PRESENT in the DB content rows (a marker is "in the DB" iff some linked row's
 * body_text contains it). Sorted + deduped. This is the DB-side observed set for diffCompleteness — it
 * catches an UNDER-link (a seeded marker whose row is missing) AND an OVER-link (a stray marker), when
 * compared to the HARDCODED EXPECTED_MARKERS.
 */
export function markersInCommsRows(
  rows: readonly CommContentRow[],
  markers: readonly string[] = EXPECTED_MARKERS,
): string[] {
  const bodies = rows.map((r) => r.body_text ?? '');
  return [...new Set(markers.filter((m) => bodies.some((b) => b.includes(m))))].sort();
}

// -----------------------------------------------------------------------------
// PDF text extraction (dynamic pdfjs import — spec-only; not pulled into ts-jest).
// -----------------------------------------------------------------------------

/**
 * Extract all selectable text from the PDF at `pdfPath` using pdfjs-dist (a transitive dep via
 * react-pdf; printToPDF emits real text). `GlobalWorkerOptions.workerSrc` is pinned to the package's
 * bundled legacy worker (.mjs) — pdfjs 5.x requires a workerSrc even for main-thread use — resolved
 * from the pdfjs package location (no hardcoded cwd). `isEvalSupported:false` + `useWorkerFetch:false`
 * harden against the user-content pages. Throws if the import fails to resolve (→ the spec should
 * test.skip) or if extraction yields empty text (→ HARNESS_ERROR — never a silent pass). Returns the
 * concatenated page text (items joined by spaces, one page per line).
 */
export async function extractPdfText(pdfPath: string): Promise<string> {
  // Dynamic import keeps pdfjs's ESM build out of the ts-jest (CommonJS) unit-test graph — only the
  // Playwright spec (Node, ESM-capable) reaches this path. Pin the legacy build entry explicitly.
  const pdfjsEntry = 'pdfjs-dist/legacy/build/pdf.mjs';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import(pdfjsEntry);
  if (pdfjs?.GlobalWorkerOptions) {
    // Resolve the bundled worker next to the entry module (robust to cwd / install layout).
    const req = createRequire(__filename);
    const entryPath = req.resolve(pdfjsEntry);
    pdfjs.GlobalWorkerOptions.workerSrc = join(dirname(entryPath), 'pdf.worker.mjs');
  }
  const data = new Uint8Array(readFileSync(pdfPath));
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;
  let text = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pageText = content.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).join(' ');
    text += pageText + '\n';
  }
  return text;
}
