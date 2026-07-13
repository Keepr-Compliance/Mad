import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { KeeprAppDriver } from '../driver/appDriver';
import { resolveBuiltMainEntry, resolveElectronBinary } from '../driver/paths';
import { seedIsolatedProfile, type SeededIdentity } from '../driver/seed/seedProfile';
import { applyFixtureDbKey, FIXTURE_DB_KEY } from '../../scripts/qa/harness/db-key-fixture';
import {
  EXPECTED_LINKED_EMAILS,
  EXPECTED_MARKERS,
  diffCompleteness,
  extractPdfText,
  markersFoundInText,
  markersInCommsRows,
  readLinkedCommsContent,
  subjectFoundInText,
} from '../../scripts/qa/harness/export-completeness-core';

/**
 * BACKLOG-1983 (P2-C7) — the EXPORT → PDF COMPLETENESS cell (HERMETIC).
 *
 * Proves, offline and deterministically (isolated profile, stub auth, NO real M365/OAuth/network), that
 * the desktop combined-PDF export (transactions:export-pdf → BACKLOG-1584 single-HTML combined PDF)
 * actually CONTAINS every DB-linked email communication — asserting on EXTRACTED PDF TEXT, not bytes
 * (filenames embed Date.now()):
 *
 *   1. FROZEN, KNOWN linked set. KEEPR_QA_EXPORT_COMPLETENESS=1 pre-links EXACTLY the 4 in-window MATCH
 *      emails as `communications` junction rows (link_source='manual'), each carrying a UNIQUE ASCII
 *      wrap-proof body marker. Only these 4 match the assigned contacts + address filter, so the
 *      "covered"-path auto-link is a strict no-op → the post-export DB set is EXACTLY these 4.
 *   2. OFFLINE, NO-HANG export. The seed plants a COVERING email_sync_state row so the AWAITED
 *      pre-export sync (ensureTransactionEmailsSynced reason:'export') takes the "covered" (no-fetch)
 *      branch → ZERO network / retry / backoff. (Without it, the seeded mailbox token would drive a
 *      live Gmail fetch wrapped in a ~31s retry loop → an offline hang.)
 *   3. HYBRID IDENTITY. Assert BOTH directions against a HARDCODED 4-marker set (a compile-time
 *      constant, NOT read from the DB — so an under-link that shrinks the DB set is caught, not hidden):
 *        (a) the DB JOIN the PDF is built from contains EXACTLY the 4 markers (catches under-/over-link
 *            at the DB layer) — asserted BEFORE trusting the PDF; and
 *        (b) the extracted PDF text contains every marker AND exactly 4 (catches export loss).
 *
 * TRUST DISCIPLINE (BACKLOG-1875 verify-by-observing): a missing/empty/unextractable PDF, an empty DB
 * oracle, or a failed seed/launch is a HARNESS_ERROR (thrown → the run is untrustworthy, NOT a false
 * FAIL). A WRONG set (a genuinely missing communication in an otherwise-good PDF) is a FAIL. Only every
 * expected marker present, in both the DB and the PDF, exactly, is a PASS. We NEVER assert on bytes and
 * NEVER silently pass on an unproduced/hollow PDF.
 *
 * Requires the app BUILT (dist-electron/main.js + dist/) — else SKIPPED with an actionable message
 * rather than false-failing. CI runs green with NO launch (skipped).
 */

const REPO_ROOT = join(__dirname, '..', '..');
const SCRATCH = process.env.KEEPR_QA_SCRATCH ?? join(REPO_ROOT, '.qa-scratch');
const ARTIFACTS_DIR = join(REPO_ROOT, 'e2e', '.artifacts', 'export-completeness');

let isBuilt = true;
try {
  resolveBuiltMainEntry(REPO_ROOT);
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.html'))) isBuilt = false;
} catch {
  isBuilt = false;
}

const electronBin = (() => {
  try {
    return resolveElectronBinary(REPO_ROOT);
  } catch {
    return '';
  }
})();

/**
 * Seed a FRESH isolated profile with the export-completeness fixture: the 4 pre-linked MATCH emails
 * (with body markers) + the covering email_sync_state row. Returns the profile paths.
 */
async function freshExportSeed(
  tag: string,
): Promise<{ identity: SeededIdentity; profileDir: string; dbPath: string }> {
  const profileDir = join(SCRATCH, `export-completeness-${tag}-profile`);
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  applyFixtureDbKey();
  const saved = process.env.KEEPR_QA_EXPORT_COMPLETENESS;
  process.env.KEEPR_QA_EXPORT_COMPLETENESS = '1';
  try {
    const identity = await seedIsolatedProfile(REPO_ROOT, profileDir);
    return { identity, profileDir, dbPath: join(profileDir, 'mad.db') };
  } finally {
    if (saved === undefined) delete process.env.KEEPR_QA_EXPORT_COMPLETENESS;
    else process.env.KEEPR_QA_EXPORT_COMPLETENESS = saved;
  }
}

/** Launch unpackaged, land logged-in (seeded session → no login wall). */
async function launchLoggedIn(profileDir: string): Promise<KeeprAppDriver> {
  const driver = await KeeprAppDriver.launch(REPO_ROOT, {
    strategy: 'unpackaged',
    reuseProfile: false,
    userDataDir: profileDir,
    repoRoot: REPO_ROOT,
    artifactsDir: ARTIFACTS_DIR,
    launchTimeoutMs: 60_000,
  });
  await driver.waitForFirstPaint(60_000);
  await driver.bringToFront();
  const ready = await driver.waitForReady(30_000);
  expect(ready, 'seeded session should authenticate with no login wall (else HARNESS_ERROR)').toBe(true);
  return driver;
}

test.describe('export → PDF completeness cell (BACKLOG-1983)', () => {
  test.skip(!isBuilt, 'App is not built. Run `npm run build` first.');
  test.skip(!electronBin, 'Local electron binary missing — run `npm install`.');
  // Full app launch + seed + export + PDF extract; give it room (single worker, no retries — see config).
  test.setTimeout(240_000);

  test('the combined PDF export contains EXACTLY the DB-linked communication set (subjects + bodies)', async () => {
    const { identity, profileDir, dbPath } = await freshExportSeed('main');
    const txId = identity.transactionId;

    // Guard: pdfjs must resolve (transitive dep). If it ever moves, SKIP with a clear message rather
    // than fail — a silent extractor failure must never degrade into a false pass.
    try {
      await import('pdfjs-dist/legacy/build/pdf.mjs');
    } catch (e) {
      test.skip(true, `pdfjs-dist not resolvable (${e instanceof Error ? e.message : String(e)}) — cannot extract PDF text.`);
    }

    const driver = await launchLoggedIn(profileDir);
    try {
      // ── STEP 1: OBSERVE the DB oracle (the exact JOIN the PDF is built from), BEFORE trusting the PDF.
      // This proves the frozen set is intact: EXACTLY the 4 seeded markers, no under-/over-link.
      const dbRowsBefore = readLinkedCommsContent(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      if (dbRowsBefore.length === 0) {
        throw new Error('[export-completeness] HARNESS_ERROR: DB oracle is empty — no linked communications to export.');
      }
      const dbMarkers = markersInCommsRows(dbRowsBefore);
      const dbDiff = diffCompleteness(EXPECTED_MARKERS, dbMarkers);
      expect(
        dbDiff,
        `the DB linked-comms set must be EXACTLY the 4 seeded markers before export (missing=${dbDiff.missing} unexpected=${dbDiff.unexpected})`,
      ).toMatchObject({ ok: true, missing: [], unexpected: [] });
      // And exactly 4 distinct linked email rows (no duplicate junction, no stray link).
      const distinctEmailIds = [...new Set(dbRowsBefore.map((r) => r.email_id))];
      expect(distinctEmailIds.sort(), 'exactly the 4 seeded MATCH emails are linked').toEqual(
        EXPECTED_LINKED_EMAILS.map((e) => e.emailId).sort(),
      );

      // ── STEP 2: TRIGGER the real export via the preload bridge with an EXPLICIT scratch outputPath
      // (no native dialog). The awaited pre-export sync degrades via the seeded covering sync-state.
      const outDir = join(SCRATCH, 'export-completeness-out');
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      const outPath = join(outDir, `export-${Date.now()}.pdf`);
      const result = await driver.exportPdfToPath(txId, outPath);
      await driver.screenshot('01-after-export');

      if (!result.success) {
        throw new Error(`[export-completeness] HARNESS_ERROR: export-pdf did not succeed: ${result.error ?? 'unknown error'}`);
      }
      const producedPath = result.path ?? outPath;
      if (!existsSync(producedPath) || statSync(producedPath).size === 0) {
        throw new Error(`[export-completeness] HARNESS_ERROR: PDF was not produced or is empty at ${producedPath}.`);
      }

      // ── STEP 3: OBSERVE the DB oracle AGAIN (the export awaited a sync; confirm the covered/no-fetch
      // branch left the set UNCHANGED — still exactly the 4). This is the observable proof that the
      // offline sync did NOT fetch/add rows (no network) and did NOT hang.
      const dbRowsAfter = readLinkedCommsContent(REPO_ROOT, electronBin, FIXTURE_DB_KEY, dbPath, txId);
      const dbMarkersAfter = markersInCommsRows(dbRowsAfter);
      const dbDiffAfter = diffCompleteness(EXPECTED_MARKERS, dbMarkersAfter);
      expect(
        dbDiffAfter,
        `the covered-path pre-export sync must leave the linked set EXACTLY 4 (offline, no fetch) (missing=${dbDiffAfter.missing} unexpected=${dbDiffAfter.unexpected})`,
      ).toMatchObject({ ok: true, missing: [], unexpected: [] });

      // ── STEP 4: EXTRACT the PDF text and assert IDENTITY on the marker set (both directions).
      let pdfText = '';
      try {
        pdfText = await extractPdfText(producedPath);
      } catch (e) {
        throw new Error(`[export-completeness] HARNESS_ERROR: PDF text extraction failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (pdfText.trim().length === 0) {
        throw new Error('[export-completeness] HARNESS_ERROR: extracted PDF text is empty — printToPDF may have produced a raster/blank page.');
      }

      const foundMarkers = markersFoundInText(pdfText, EXPECTED_MARKERS);
      const pdfDiff = diffCompleteness(EXPECTED_MARKERS, foundMarkers);
      // FAIL (real app bug) iff a genuinely-linked communication's body did not land in the PDF.
      expect(
        pdfDiff,
        `every DB-linked communication's body marker must appear in the exported PDF text (missing=${pdfDiff.missing} unexpected=${pdfDiff.unexpected})`,
      ).toMatchObject({ ok: true, missing: [], unexpected: [] });
      expect(foundMarkers.length, 'the PDF contains exactly the 4 expected markers').toBe(4);

      // SECONDARY (non–load-bearing) signal: each subject appears in the PDF text. subjectFoundInText
      // whitespace-STRIPs and dash-normalizes BOTH sides (matching the primary marker matcher), so a
      // subject split at pdfjs kerning boundaries still matches.
      for (const row of dbRowsAfter) {
        if (row.subject) {
          expect(
            subjectFoundInText(pdfText, row.subject),
            `subject "${row.subject}" should appear in the PDF (secondary signal)`,
          ).toBe(true);
        }
      }
    } finally {
      await driver.closeAndWait().catch(() => undefined);
    }
  });
});
