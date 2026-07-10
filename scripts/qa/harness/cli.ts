#!/usr/bin/env ts-node
/**
 * `qa:ceremony` CLI entrypoint for the QA harness (BACKLOG-1848).
 *
 * Usage:
 *   npm run qa:ceremony -- --scenario tx1-birchwood
 *   npm run qa:ceremony -- --scenario tx1-birchwood --live
 *   npm run qa:ceremony -- --scenario ./docs/qa/scenarios/tx1-birchwood.json --dry-run
 *
 * Exit codes:
 *   0  ceremony passed (or wiring smoke passed with all-stub components)
 *   1  an exact-count mismatch or stage failure was found
 *   2  configuration error (bad scenario / drifted checklist)
 */
import { resolve } from 'path';
import { createLogger } from './logger';
import { loadScenario } from './manifest';
import { loadCanonicalList, toExpectedSets } from './canonicalList';
import { buildComponents } from './components/registry';
import { runCeremony } from './runner';
import { formatDeviation } from './diff';
import type { CeremonyContext, CeremonyOptions, LogLevel } from './types';

const REPO_ROOT = resolve(__dirname, '../../..');

interface ParsedArgs {
  scenario?: string;
  options: CeremonyOptions;
  logLevel: LogLevel;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: CeremonyOptions = {
    live: false,
    skipSeed: false,
    skipDriver: false,
    skipExport: false,
    withUpdate: false,
    dryRun: false,
  };
  let scenario: string | undefined;
  let logLevel: LogLevel = 'info';
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--scenario':
      case '-s':
        scenario = argv[++i];
        break;
      case '--live':
        options.live = true;
        break;
      case '--skip-seed':
        options.skipSeed = true;
        break;
      case '--skip-driver':
        options.skipDriver = true;
        break;
      case '--skip-export':
        options.skipExport = true;
        break;
      case '--with-update':
        options.withUpdate = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--verbose':
      case '-v':
        logLevel = 'debug';
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        if (arg.startsWith('--scenario=')) {
          scenario = arg.slice('--scenario='.length);
        } else {
          throw new Error(`Unknown argument: ${arg}`);
        }
    }
  }
  return { scenario, options, logLevel, help };
}

function resolveScenarioPath(scenario: string): string {
  if (scenario.endsWith('.json')) {
    return resolve(process.cwd(), scenario);
  }
  return resolve(REPO_ROOT, 'docs/qa/scenarios', `${scenario}.json`);
}

const HELP = `qa:ceremony — deterministic QA harness runner (BACKLOG-1848)

Usage:
  npm run qa:ceremony -- --scenario <id|path> [flags]

Flags:
  -s, --scenario <id>   Scenario id (docs/qa/scenarios/<id>.json) or a .json path
      --live            Engage real, side-effecting components (default: all stub)
      --skip-seed       Skip wipe + seed stages
      --skip-driver     Skip the Playwright-Electron drive stage (H2)
      --skip-export     Skip the export-manifest assertion (H5)
      --with-update     Run the optional update-migrate + re-assert stage (F)
      --dry-run         Print intended actions; perform no real side effects
  -v, --verbose         Debug logging
  -h, --help            Show this help

Default (no --live): a safe wiring smoke test — every stage runs a stub that
touches no live mailbox/app/filesystem. Assertions are certified only under
--live once H2/H3/H5 have merged.`;

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

  // 1. Load + validate the scenario manifest.
  const scenarioPath = resolveScenarioPath(parsed.scenario);
  let loaded;
  try {
    loaded = loadScenario(scenarioPath);
  } catch (err) {
    logger.error(`Failed to load scenario: ${(err as Error).message}`);
    return 2;
  }
  const { scenario, canonicalListPath } = loaded;

  // 2. Derive expected sets from the canonical checklist; assert no drift.
  let expected;
  try {
    const parsedList = loadCanonicalList(canonicalListPath);
    expected = toExpectedSets(parsedList, scenario.expectedCounts);
  } catch (err) {
    logger.error(`Canonical checklist problem: ${(err as Error).message}`);
    return 2;
  }

  logger.info(`Scenario: ${scenario.id} (${scenario.version}) — ${scenario.description}`);
  logger.info(
    `Source=${scenario.source}  window=${scenario.auditWindow.start}..${scenario.auditWindow.end}  contacts=${scenario.contacts.length}`,
  );
  logger.info(
    `Expected: corpus=${scenario.expectedCounts.corpus} filterOff=${scenario.expectedCounts.filterOff} ` +
      `filterOn=${scenario.expectedCounts.filterOn} missing=${scenario.expectedCounts.missing} ` +
      `extra=${scenario.expectedCounts.extra} ghosts=${scenario.expectedCounts.ghosts}`,
  );
  logger.info(
    `Mode: ${parsed.options.live ? 'LIVE' : 'STUB (wiring smoke)'}${parsed.options.dryRun ? ' + dry-run' : ''}`,
  );
  logger.info('');

  // 3. Build components + run the ceremony.
  const ctx: CeremonyContext = {
    scenario,
    scenarioPath: loaded.path,
    repoRoot: REPO_ROOT,
    logger,
    options: parsed.options,
  };
  const components = buildComponents(scenario.source);
  const report = await runCeremony(ctx, components, expected);

  // 4. Summarize.
  logger.info('');
  logger.info('──────────────────────────────────────────────');
  if (report.deviations.length > 0) {
    logger.error(`${report.deviations.length} exact-count deviation(s):`);
    for (const d of report.deviations) {
      console.error(formatDeviation(d));
    }
  }

  if (report.passed && report.stubbed) {
    logger.warn(
      `CEREMONY WIRING OK (STUBBED) — 0 real assertions ran. ` +
        `This is NOT a certified deterministic pass. Re-run with --live once ` +
        `H2 (BACKLOG-1849) / H3 (BACKLOG-1850) / H5 (BACKLOG-1852) have merged.`,
    );
    logger.info(`Verdict: WIRING-OK (stubbed) in ${report.durationMs}ms`);
    return 0;
  }
  if (report.passed) {
    logger.info(`Verdict: PASS — all exact counts held (${report.durationMs}ms)`);
    return 0;
  }
  logger.error(`Verdict: FAIL — deterministic gate(s) violated (${report.durationMs}ms)`);
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Fatal harness error:', err);
    process.exit(2);
  });
