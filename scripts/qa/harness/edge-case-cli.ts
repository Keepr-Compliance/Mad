#!/usr/bin/env ts-node
/**
 * `qa:edge-cases` CLI — email/ingest EDGE-CASE MATRIX (BACKLOG-1854 / QA-H7).
 *
 * Layered like H6 (BACKLOG-1853):
 *   - TIER 1 (pure logic) is covered by jest (scripts/qa/harness/__tests__):
 *     idempotence set-stability, timezone-boundary derivation, ghost detection,
 *     signature false-positive logic, telemetry marker + redaction scanning.
 *   - TIER 2 (this CLI): the DB-backed cells open the app's encrypted DB
 *     READ-ONLY (--live + KEEPR_QA_DB_KEY) and assert EXACT (subject,shifted-date)
 *     invariants; the LOG cells (telemetry BACKLOG-1843 + redaction BACKLOG-1785)
 *     run REGARDLESS of --live over a real main.log or the committed fixture.
 *     DB cells SKIP cleanly without KEEPR_QA_DB_KEY (never hang).
 *   - TIER 3 (interrupted-sync self-heal, restored-session boot): DRIVER-GATED —
 *     they need an app boot the H2 driver (BACKLOG-1849) provides; until it is
 *     wired into the harness these are reported DRIVER-GATED (never failed).
 *
 * The REDACTION cell is REPORTED-NOT-GATED: it reports the plaintext-email leak
 * count (the real BACKLOG-1785 signal) but NEVER fails the run. It flips to a
 * hard gate once BACKLOG-1785 lands.
 *
 * NODE-ABI NOTE (R3 lesson, BACKLOG-1887): the live DB path loads the node-ABI
 * `better-sqlite3-multiple-ciphers`. On a NODE_MODULE_VERSION mismatch, run
 * `npm rebuild better-sqlite3-multiple-ciphers`.
 *
 * Usage:
 *   npm run qa:edge-cases -- --scenario tx1-birchwood
 *   npm run qa:edge-cases -- --scenario tx1-birchwood --live   # needs KEEPR_QA_DB_KEY
 *
 * Exit codes:
 *   0  passed, or cleanly skipped/gated/reported (no --live / no DB key / no log)
 *   1  an exact-count / invariant deviation was found (a `fail` cell)
 *   2  configuration error (bad scenario)
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createLogger } from './logger';
import { loadScenario } from './manifest';
import { formatDeviation } from './diff';
import { runEdgeCaseAssert, type EdgeExpectationBundle, type EdgeScenario } from './edge-case-asserter';
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

/** Tier-3 UI edge cells the H2 driver (BACKLOG-1849) will activate. */
function driverGatedCells(): Array<{ id: string; detail: string }> {
  return [
    {
      id: 'interrupted-sync-self-heal',
      detail:
        'kill mid-sync → relaunch → re-assert EXACT counts survive (needs app boot; H2 driver BACKLOG-1849)',
    },
    {
      id: 'restored-session-boot',
      detail:
        'quit → relaunch from persisted userData → re-assert EXACT counts survive (needs app boot; H2 driver BACKLOG-1849)',
    },
    {
      id: 'audit-window-combos-ui',
      detail:
        'extend-before-oldest / new-mail-since-sync / shrink-after-sync / fresh-vs-returning via the UI (needs app boot; H2 driver BACKLOG-1849)',
    },
  ];
}

const HELP = `qa:edge-cases — email/ingest edge-case matrix (BACKLOG-1854 / QA-H7)

Usage:
  npm run qa:edge-cases -- --scenario <id|path> [flags]

Flags:
  -s, --scenario <id>   Scenario id (docs/qa/scenarios/<id>.json) or a .json path
      --live            Open the encrypted DB read-only + assert (needs KEEPR_QA_DB_KEY)
      --dry-run         Print intended actions; perform no real DB read
  -v, --verbose         Debug logging
  -h, --help            Show this help

Without --live (or without KEEPR_QA_DB_KEY) the DB-backed cells SKIP cleanly with
an actionable provisioning hint — they never hang. The telemetry + redaction LOG
cells run regardless (fixture-backed). The redaction cell is REPORTED-NOT-GATED
(reports the BACKLOG-1785 leak count, never fails). Interrupted-sync / restored-
session cells are DRIVER-GATED until the H2 driver (BACKLOG-1849) is wired.

Exit codes: 0 pass/skip/gated/reported · 1 deviation (a fail cell) · 2 config error.`;

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
  let rawScenario: EdgeScenario;
  try {
    loaded = loadScenario(scenarioPath); // H1 zod validation (fails fast on a bad manifest)
    rawScenario = JSON.parse(readFileSync(loaded.path, 'utf8')); // raw: keeps the edgeCases block
  } catch (err) {
    logger.error(`Failed to load scenario: ${(err as Error).message}`);
    return 2;
  }

  logger.info(`Scenario: ${loaded.scenario.id} (${loaded.scenario.version}) — ${loaded.scenario.description}`);
  logger.info(`Mode: ${parsed.live ? 'LIVE (read-only DB)' : 'SKIP (no --live)'}${parsed.dryRun ? ' + dry-run' : ''}`);
  logger.info('');

  const bundle: EdgeExpectationBundle = { scenario: rawScenario, scenarioPath: loaded.path };
  const result = runEdgeCaseAssert(
    { scenarioPath: loaded.path, repoRoot: REPO_ROOT, live: parsed.live, dryRun: parsed.dryRun },
    bundle,
  );

  // Tier-2 cells.
  for (const cell of result.cells) {
    const badge =
      cell.status === 'pass'
        ? 'PASS'
        : cell.status === 'fail'
          ? 'FAIL'
          : cell.status.toUpperCase(); // SKIP / GATED / INFO / REPORTED
    logger.info(`[${badge}] ${cell.id} (${cell.kind}) — ${cell.detail}`);
    for (const d of cell.deviations ?? []) console.error(formatDeviation(d));
  }

  // Tier-3 driver-gated cells (informational until the H2 driver is wired).
  logger.info('');
  logger.info('Driver-gated cells (Tier 3 — activate when the H2 driver BACKLOG-1849 is wired):');
  for (const dc of driverGatedCells()) {
    logger.info(`[DRIVER-GATED] ${dc.id} — ${dc.detail}`);
  }

  logger.info('');
  logger.info('──────────────────────────────────────────────');
  if (result.status === 'pass') {
    logger.info(`Verdict: PASS — all edge-case gates held (${result.durationMs}ms). ${result.detail}`);
    return 0;
  }
  logger.error(`Verdict: FAIL — edge-case gate(s) violated (${result.durationMs}ms). ${result.detail}`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Fatal edge-case error:', err);
    process.exit(2);
  });
