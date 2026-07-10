/**
 * Gmail seeder self-guard tests (BACKLOG-1851 / QA-H4).
 *
 * Proves the component reports the right status WITHOUT a live tenant:
 *   - not --live            -> stub  (side-effect free default)
 *   - --live, no token      -> gated (BACKLOG-1845; NON-FAIL)
 *   - --live, token present but env broken -> fail
 */
import { resolve } from 'path';
import { gmailSeeder } from '../components/gmailSeeder';
import type {
  CeremonyContext,
  CeremonyOptions,
  Logger,
  ScenarioManifest,
} from '../types';

const REPO_ROOT = resolve(__dirname, '../../../..');
const GMAIL_SCENARIO = resolve(REPO_ROOT, 'docs/qa/scenarios/tx1-birchwood-gmail.json');

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeCtx(
  options: Partial<CeremonyOptions>,
  seed: ScenarioManifest['seed'],
): CeremonyContext {
  const scenario = {
    id: 'tx1-birchwood-gmail',
    source: 'gmail',
    dateShiftMonths: 12,
    seed,
  } as unknown as ScenarioManifest;
  return {
    scenario,
    scenarioPath: GMAIL_SCENARIO,
    repoRoot: REPO_ROOT,
    logger: silentLogger,
    options: {
      live: false,
      skipSeed: false,
      skipDriver: false,
      skipExport: false,
      withUpdate: false,
      dryRun: false,
      ...options,
    },
  };
}

describe('gmailSeeder — identity', () => {
  it('is a gmail-source seeder', () => {
    expect(gmailSeeder.source).toBe('gmail');
    expect(gmailSeeder.name).toMatch(/gmail/i);
  });
});

describe('gmailSeeder — self-guard', () => {
  it('reports STUB when not --live (side-effect free default)', async () => {
    const ctx = makeCtx({ live: false }, { tokenFile: '/nope/token.json' });
    const seed = await gmailSeeder.seed(ctx);
    expect(seed.status).toBe('stub');
    const wipe = await gmailSeeder.wipe(ctx);
    expect(wipe.status).toBe('stub');
  });

  it('reports STUB when --live but --dry-run', async () => {
    const ctx = makeCtx({ live: true, dryRun: true }, { tokenFile: '/nope/token.json' });
    expect((await gmailSeeder.seed(ctx)).status).toBe('stub');
  });

  it('reports GATED (non-fail) when --live but the Gmail token is absent', async () => {
    const ctx = makeCtx(
      { live: true, dryRun: false },
      { corpusDir: REPO_ROOT, tokenFile: '/definitely/not/here/gmail-token.json' },
    );
    const seed = await gmailSeeder.seed(ctx);
    expect(seed.status).toBe('gated');
    expect(seed.detail).toMatch(/GATED/);
    expect(seed.detail).toMatch(/1845/);
    const wipe = await gmailSeeder.wipe(ctx);
    expect(wipe.status).toBe('gated');
  });

  it('reports GATED when no tokenFile is configured at all', async () => {
    const ctx = makeCtx({ live: true, dryRun: false }, { corpusDir: REPO_ROOT });
    expect((await gmailSeeder.seed(ctx)).status).toBe('gated');
  });

  it('reports FAIL when the token is present but the environment is broken', async () => {
    // Use an existing file as a stand-in "token present"; point the corpus at a
    // missing dir so a hard prerequisite fails (this is a config error, not a gate).
    const ctx = makeCtx(
      { live: true, dryRun: false },
      { corpusDir: '/no/such/corpus/dir', tokenFile: GMAIL_SCENARIO },
    );
    const seed = await gmailSeeder.seed(ctx);
    expect(seed.status).toBe('fail');
    expect(seed.status).not.toBe('gated');
  });
});
