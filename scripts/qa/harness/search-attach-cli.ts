#!/usr/bin/env ts-node
/**
 * `qa:search-attach` CLI — SEARCH + ATTACH determinism suite (BACKLOG-1853 / QA-H6).
 *
 * Layered per the wave-2 constraint:
 *   - TIER 1 (pure logic) is covered by jest (scripts/qa/harness/__tests__).
 *   - TIER 2 (this CLI, --live) opens the app's encrypted DB READ-ONLY and
 *     asserts the fixed search-query set, thread grouping, whole-thread attach
 *     expansion, and the ghost/stale-search scan — EXACT (subject, shifted-date)
 *     diffs, non-zero exit on deviation. Skips cleanly without KEEPR_QA_DB_KEY.
 *   - TIER 3 (UI search→attach) is DRIVER-GATED: it activates when the real H2
 *     driver (BACKLOG-1849) is wired into the harness (the registry still stubs
 *     it). Until then those cells are reported as `driver-gated` (not failed).
 *
 * Usage:
 *   npm run qa:search-attach -- --scenario tx1-birchwood
 *   npm run qa:search-attach -- --scenario tx1-birchwood --live   # needs KEEPR_QA_DB_KEY
 *
 * Exit codes:
 *   0  passed, or cleanly skipped (no --live / no DB key)
 *   1  an exact-count / determinism deviation was found
 *   2  configuration error (bad scenario / drifted checklist)
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from './logger';
import { loadScenario } from './manifest';
import { loadCanonicalList } from './canonicalList';
import { formatDeviation } from './diff';
import { runSearchAttachAssert, type SearchExpectationBundle } from './search-attach-asserter';
import { driverGatedCells } from './search-attach-driver';
import type { LogLevel } from './types';

const REPO_ROOT = resolve(__dirname, '../../..');

interface ParsedArgs {
  scenario?: string;
  live: boolean;
  dryRun: boolean;
  logLevel: LogLevel;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { live: false, dryRun: false, logLevel: 'info', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--scenario':
      case '-s':
        out.scenario = argv[++i];
        break;
      case '--live':
        out.live = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        out.logLevel = 'debug';
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        if (arg.startsWith('--scenario=')) out.scenario = arg.slice('--scenario='.length);
        else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function resolveScenarioPath(scenario: string): string {
  if (scenario.endsWith('.json')) return resolve(process.cwd(), scenario);
  return resolve(REPO_ROOT, 'docs/qa/scenarios', `${scenario}.json`);
}

const HELP = `qa:search-attach — search + attach determinism suite (BACKLOG-1853 / QA-H6)

Usage:
  npm run qa:search-attach -- --scenario <id|path> [flags]

Flags:
  -s, --scenario <id>   Scenario id (docs/qa/scenarios/<id>.json) or a .json path
      --live            Open the encrypted DB read-only + assert (needs KEEPR_QA_DB_KEY)
      --dry-run         Print intended actions; perform no real DB read
  -v, --verbose         Debug logging
  -h, --help            Show this help

Without --live (or without KEEPR_QA_DB_KEY) the DB-backed cells SKIP cleanly with
an actionable provisioning hint — they never hang. UI search→attach cells are
DRIVER-GATED until the H2 driver (BACKLOG-1849) is wired.`;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  const logger = createLogger(parsed.logLevel);

  if (!parsed.scenario) {
    logger.error('Missing required --scenario <id|path>. See --help.');
    return 2;
  }

  const scenarioPath = resolveScenarioPath(parsed.scenario);
  let loaded;
  let rawScenario: SearchExpectationBundle['scenario'];
  try {
    loaded = loadScenario(scenarioPath); // H1 zod validation (fails fast on a bad manifest)
    rawScenario = JSON.parse(readFileSync(loaded.path, 'utf8')); // raw: keeps the searchQueries block
  } catch (err) {
    logger.error(`Failed to load scenario: ${(err as Error).message}`);
    return 2;
  }

  let parsedList;
  try {
    parsedList = loadCanonicalList(loaded.canonicalListPath);
  } catch (err) {
    logger.error(`Canonical checklist problem: ${(err as Error).message}`);
    return 2;
  }

  const queries = rawScenario.searchQueries?.queries ?? [];
  logger.info(`Scenario: ${loaded.scenario.id} (${loaded.scenario.version}) — ${loaded.scenario.description}`);
  logger.info(`Search queries configured: ${queries.length}`);
  logger.info(`Mode: ${parsed.live ? 'LIVE (read-only DB)' : 'SKIP (no --live)'}${parsed.dryRun ? ' + dry-run' : ''}`);
  logger.info('');

  const bundle: SearchExpectationBundle = { parsed: parsedList, scenario: rawScenario };
  const result = runSearchAttachAssert(
    { scenarioPath: loaded.path, repoRoot: REPO_ROOT, live: parsed.live, dryRun: parsed.dryRun },
    bundle,
  );

  // Tier-2 cells.
  for (const cell of result.cells) {
    const badge = cell.status === 'pass' ? 'PASS' : cell.status === 'fail' ? 'FAIL' : cell.status.toUpperCase();
    logger.info(`[${badge}] ${cell.id} (${cell.kind}) — ${cell.detail}`);
    for (const d of cell.deviations ?? []) console.error(formatDeviation(d));
  }

  // Tier-3 driver-gated cells (informational until the H2 driver is wired).
  logger.info('');
  logger.info('Driver-gated cells (Tier 3 — activate when the H2 driver is wired):');
  for (const dc of driverGatedCells()) {
    logger.info(`[DRIVER-GATED] ${dc.id} — ${dc.detail}`);
  }

  logger.info('');
  logger.info('──────────────────────────────────────────────');
  if (result.status === 'skipped') {
    logger.warn(`SEARCH/ATTACH SKIPPED — ${result.detail}`);
    logger.info(`Verdict: SKIPPED (Tier-2 not run; Tier-1 pure logic runs in jest) in ${result.durationMs}ms`);
    return 0;
  }
  if (result.status === 'pass') {
    logger.info(`Verdict: PASS — all search/attach determinism gates held (${result.durationMs}ms)`);
    return 0;
  }
  logger.error(`Verdict: FAIL — search/attach determinism gate(s) violated (${result.durationMs}ms)`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Fatal search-attach error:', err);
    process.exit(2);
  });
