/**
 * QA Harness — ExportManifestAsserter adapter (BACKLOG-1852 / QA-H5).
 *
 * Implements H1's `ExportManifestAsserter` contract (BACKLOG-1848, ./types.ts).
 * It reads the desktop transaction export deliverable, derives the emitted email
 * set losslessly (`export-manifest-core.ts`), and validates
 * `attachments/manifest.json`. Following the H3 pattern, the adapter MEASURES:
 * it returns `exportedEmails` for the runner to diff against the canonical set
 * (H1's shared MULTISET `diffMembers`), and returns its own manifest/structure
 * `deviations` which the runner MERGES (see runner.ts `judgeExportStage`).
 *
 * DATE IDENTITY: the deliverable's timestamps are UTC; the canonical checklist's
 * dates are LOCAL to the corpus timezone. The core converts via H3's
 * `shiftedDateOf` using the scenario's `sourceTimezone` (read from the raw
 * scenario JSON — H1's zod ScenarioManifest does not yet carry it; the same
 * source db-assert.js reads). Default: America/Los_Angeles.
 *
 * LIVE GATING: driving the export requires the H2 Playwright-Electron driver,
 * which is still gated on the signed-build / CDP unlock (a parallel task). So in
 * non-live / dry-run mode this returns a `stub` StageResult (safe wiring smoke),
 * and under `--live` it reads the deliverable directory from the
 * `KEEPR_QA_EXPORT_DIR` environment variable (the driver will point this at the
 * export it produced). All asserter LOGIC is exercised fixture-first via unit
 * tests, so the live cell activates the moment the driver + export dir land.
 */
import * as fs from 'fs';
import type {
  CeremonyContext,
  ExpectedSets,
  ExportAssertResult,
  ExportManifestAsserter,
} from './types';
import { DEFAULT_SOURCE_TZ, readExportDeliverable } from './export-manifest-core';

const STAGE = 'assert-export' as const;

const PROVISION_HINT =
  'Point KEEPR_QA_EXPORT_DIR at the export deliverable directory (the H2 driver ' +
  'emits this in a full ceremony), e.g.\n' +
  '      export KEEPR_QA_EXPORT_DIR="$HOME/Downloads/Transaction_742_Birchwood_..."\n' +
  '    then re-run with --live.';

function failResult(durationMs: number, detail: string): ExportAssertResult {
  return { stage: STAGE, status: 'fail', durationMs, detail, deviations: [], exportedEmails: [] };
}

/**
 * Read the scenario's `sourceTimezone` from the raw JSON. H1's zod schema strips
 * unknown keys, so the parsed `ScenarioManifest` does not carry it; we read the
 * same field db-assert.js reads. Falls back to the Pacific default.
 */
export function readSourceTimezone(scenarioPath: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as { sourceTimezone?: unknown };
    return typeof raw.sourceTimezone === 'string' && raw.sourceTimezone
      ? raw.sourceTimezone
      : DEFAULT_SOURCE_TZ;
  } catch {
    return DEFAULT_SOURCE_TZ;
  }
}

export function createExportManifestAsserter(): ExportManifestAsserter {
  return {
    name: 'export-manifest-asserter',

    async assert(ctx: CeremonyContext, expected: ExpectedSets): Promise<ExportAssertResult> {
      const started = Date.now();

      // Non-live: reading a real export folder is a real side effect and needs
      // the H2 driver's output, so it only runs under --live. Otherwise stub.
      if (!ctx.options.live || ctx.options.dryRun) {
        return {
          stage: STAGE,
          status: 'stub',
          durationMs: Date.now() - started,
          detail:
            `stub — expected ${expected.counts.filterOff} emails + manifest ` +
            '(run with --live and KEEPR_QA_EXPORT_DIR to diff the real deliverable)',
          deviations: [],
          exportedEmails: [],
        };
      }

      const exportDir = process.env.KEEPR_QA_EXPORT_DIR;
      if (!exportDir) {
        return failResult(
          Date.now() - started,
          `No export directory in the environment.\n    ${PROVISION_HINT}`,
        );
      }
      if (!fs.existsSync(exportDir)) {
        return failResult(Date.now() - started, `Export directory not found: ${exportDir}`);
      }

      const timeZone = readSourceTimezone(ctx.scenarioPath);

      let result;
      try {
        result = readExportDeliverable(exportDir, { timeZone });
      } catch (err) {
        return failResult(
          Date.now() - started,
          `Failed to read export deliverable at ${exportDir}: ${(err as Error).message}`,
        );
      }

      const durationMs = Date.now() - started;

      // The adapter's own status is advisory — the runner is the authority and
      // re-judges (email-set diff) while merging these structural deviations.
      const status = result.deviations.length === 0 ? 'pass' : 'fail';
      return {
        stage: STAGE,
        status,
        durationMs,
        detail: `${result.detail} · tz=${timeZone}`,
        deviations: result.deviations,
        exportedEmails: result.exportedEmails,
      };
    },
  };
}

export default createExportManifestAsserter;
