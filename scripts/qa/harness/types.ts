/**
 * QA Harness — shared component contract (BACKLOG-1848 / QA-H1).
 *
 * This file is the ONE published interface surface that the sibling harness
 * tasks implement. Coordinate any change to these shapes across:
 *   - H2 (BACKLOG-1849): AppDriverComponent      — Playwright-Electron driver
 *   - H3 (BACKLOG-1850): DbSetDiffAsserter        — cipher-module DB set-diff
 *   - H4 (BACKLOG-1851): SeederComponent          — per-source seeders (wipe+seed)
 *   - H5 (BACKLOG-1852): ExportManifestAsserter    — export deliverable diff
 *   - F  (later):        UpdateMigrateRunner        — N-1 -> candidate re-assert
 *
 * DETERMINISTIC STANDARD (founder, v2.20.0 2026-07-06): every gate asserts an
 * EXACT corpus-derived count, never a threshold. Every deviation is a finding
 * to explain, not a tolerance to absorb.
 *
 * SET-IDENTITY RULE (load-bearing): email set membership is keyed by
 * (subject, shifted-date), NEVER by Message-ID. Corpus .eml files carry no
 * Message-ID; Graph assigns internetMessageId server-side, so DB
 * message_id_header will never equal a corpus value.
 *
 * MULTISET, not set: distinct emails can legitimately share one
 * (subject, shifted-date) key — e.g. a same-day reply and its predecessor.
 * The canonical TX1 list has such a pair (rows 20/21, 2026-02-14). Diffing
 * MUST be by multiplicity (see diff.ts), or two real rows collapse into one and
 * the exact count silently under-counts. H3 (BACKLOG-1850) must preserve
 * duplicate keys when deriving the DB set.
 */

// ---------------------------------------------------------------------------
// Set identity
// ---------------------------------------------------------------------------

/** Email set-membership key — (subject, shiftedDate). NEVER Message-ID. */
export interface EmailSetMember {
  /** Exact subject as it appears in the corpus / DB (pipes unescaped). */
  subject: string;
  /** Shifted send date, ISO calendar date `YYYY-MM-DD` (corpus Date + N months). */
  shiftedDate: string;
}

/** An enriched row of the canonical expected checklist. */
export interface CanonicalEmail extends EmailSetMember {
  /** 1-based row index in the canonical checklist. */
  index: number;
  /** Source .eml filename in the corpus. */
  emlFile: string;
  /** Matched contact(s) & role text (human reference only). */
  matchedContacts: string;
  /** True when this email is in the filter-ON (address-mention) subset. */
  onSubset: boolean;
}

// ---------------------------------------------------------------------------
// Scenario manifest
// ---------------------------------------------------------------------------

/** The exact, corpus-derived counts every gate asserts. */
export interface ExpectedCounts {
  /** Total emails cached after seed+sync. */
  corpus: number;
  /** Expected linked emails, filter toggle OFF (any contact in From/To/Cc/Bcc). */
  filterOff: number;
  /** Address-mention subset, filter toggle ON (subject/body contains address tokens). */
  filterOn: number;
  /** Rows expected but absent (must be 0). */
  missing: number;
  /** Rows present but not expected (must be 0). */
  extra: number;
  /** Ghost rows from a mechanical sent_at scan (must be 0). */
  ghosts: number;
}

export type EmailSource = 'outlook' | 'gmail';

export interface TransactionSpec {
  /** Human label, e.g. "742 Birchwood Lane NE, Tumwater WA". */
  label: string;
  address: string;
  /** Filter-ON tokens; an email is ON iff LOWER(subject||' '||body) contains ALL. */
  normalizedTokens: string[];
}

export interface AuditWindow {
  /** ISO date, inclusive lower bound. */
  start: string;
  /** ISO date, inclusive upper bound. */
  end: string;
}

/** Optional seeder configuration for a scenario. */
export interface ScenarioSeedConfig {
  /** Corpus directory of `.eml` files (may use `~` / `$VAR`, expanded at load). */
  corpusDir?: string;
  /** Address whose outbound mail routes to Sent Items during seeding. */
  outboundSender?: string;
  /** OAuth token JSON path for the seeder (may use `~`). */
  tokenFile?: string;
}

/** A single QA scenario — the deterministic ceremony contract. */
export interface ScenarioManifest {
  /** Stable scenario id, e.g. "tx1-birchwood". */
  id: string;
  /** Corpus/manifest version, e.g. "v2.20.0". */
  version: string;
  description: string;
  source: EmailSource;
  transaction: TransactionSpec;
  auditWindow: AuditWindow;
  /** Transaction contact address set (own mailbox excluded). */
  contacts: string[];
  /** The user's own mailbox address, excluded from linking per app logic. */
  ownAddressExcluded: string;
  /** Corpus Date shift in months (2025 -> 2026 = 12). */
  dateShiftMonths: number;
  expectedCounts: ExpectedCounts;
  /**
   * Path (relative to the manifest file) to the canonical checklist markdown
   * enumerating the expected filter-OFF set by (subject, shiftedDate).
   */
  expectedManifestRef: string;
  /** Literal reminder of the set-identity rule (fails validation otherwise). */
  setIdentity: 'subject+shifted-date';
  seed?: ScenarioSeedConfig;
}

/** Expected sets derived from a scenario + its canonical checklist. */
export interface ExpectedSets {
  counts: ExpectedCounts;
  /** The full expected filter-OFF set (e.g. 69 rows). */
  filterOff: CanonicalEmail[];
  /** The filter-ON subset (e.g. 37 rows). */
  filterOn: CanonicalEmail[];
}

// ---------------------------------------------------------------------------
// Ceremony runtime
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface CeremonyOptions {
  /**
   * Engage real, side-effecting components. When false (default), all
   * components run in stub/plan mode so `qa:ceremony` is a safe wiring smoke
   * test that touches no live mailbox, app, or filesystem export.
   */
  live: boolean;
  /** Skip the wipe+seed stages (assume mailbox already seeded). */
  skipSeed: boolean;
  /** Skip the Playwright-Electron boot/drive stage (H2). */
  skipDriver: boolean;
  /** Skip the export-manifest assertion stage (H5). */
  skipExport: boolean;
  /** Run the optional update-migrate + re-assert stage (F). */
  withUpdate: boolean;
  /** Print intended actions without invoking real side effects (implies !live for effects). */
  dryRun: boolean;
}

export interface CeremonyContext {
  scenario: ScenarioManifest;
  /** Absolute path to the loaded scenario file. */
  scenarioPath: string;
  /** Absolute repo root. */
  repoRoot: string;
  logger: Logger;
  options: CeremonyOptions;
}

// ---------------------------------------------------------------------------
// Stage results
// ---------------------------------------------------------------------------

export type StageName =
  | 'wipe'
  | 'seed'
  | 'drive'
  | 'assert-db'
  | 'assert-export'
  | 'update-migrate'
  | 're-assert-db';

/**
 * - `pass`    — stage ran and every assertion held.
 * - `fail`    — stage ran and something failed (deviation or error).
 * - `skipped` — stage intentionally not run (option flag).
 * - `stub`    — real component not yet merged; ran a no-op placeholder.
 */
export type StageStatus = 'pass' | 'fail' | 'skipped' | 'stub';

/** One exact-count deviation (a "finding to explain"). */
export interface CountDeviation {
  /** Which count cell deviated, e.g. "filterOff". */
  cell: keyof ExpectedCounts | string;
  expected: number;
  got: number;
  /** Members expected but absent from actual (keyed by subject+shiftedDate). */
  missingMembers?: EmailSetMember[];
  /** Members present in actual but not expected. */
  extraMembers?: EmailSetMember[];
}

export interface StageResult {
  stage: StageName;
  status: StageStatus;
  durationMs: number;
  /** Human summary line. */
  detail?: string;
  /** Any exact-count deviations discovered by this stage. */
  deviations?: CountDeviation[];
}

/** DB set-diff asserter output (H3 / BACKLOG-1850). */
export interface SetDiffResult extends StageResult {
  actual: {
    corpus: number;
    filterOff: EmailSetMember[];
    filterOn: EmailSetMember[];
    ghosts: EmailSetMember[];
  };
}

/** Export-manifest asserter output (H5 / BACKLOG-1852). */
export interface ExportAssertResult extends StageResult {
  exportedEmails: EmailSetMember[];
}

// ---------------------------------------------------------------------------
// Pluggable components (implemented by H2/H3/H4/H5/F)
// ---------------------------------------------------------------------------

/** H4 (BACKLOG-1851): per-source seeder. Reference impl wraps `seed-m365.py`. */
export interface SeederComponent {
  readonly name: string;
  readonly source: EmailSource;
  /** Empty the mailbox (all folders) and assert 0 remain. */
  wipe(ctx: CeremonyContext): Promise<StageResult>;
  /** Seed the corpus (date-shifted, threaded) into the mailbox. */
  seed(ctx: CeremonyContext): Promise<StageResult>;
}

/** H2 (BACKLOG-1849): Playwright-Electron packaged-app driver. */
export interface AppDriverComponent {
  readonly name: string;
  /** Boot + onboard + permissions + connect + sync + navigate + toggle + export. */
  drive(ctx: CeremonyContext): Promise<StageResult>;
}

/** H3 (BACKLOG-1850): encrypted-DB set-diff asserter (app's own cipher module). */
export interface DbSetDiffAsserter {
  readonly name: string;
  /** Derive filter-OFF/ON sets from the app DB and diff vs `expected`. */
  assert(ctx: CeremonyContext, expected: ExpectedSets): Promise<SetDiffResult>;
}

/** H5 (BACKLOG-1852): export-manifest asserter. */
export interface ExportManifestAsserter {
  readonly name: string;
  /** Drive the transaction export and diff the deliverable vs `expected`. */
  assert(ctx: CeremonyContext, expected: ExpectedSets): Promise<ExportAssertResult>;
}

/** F (later): update-migrate re-assert runner. */
export interface UpdateMigrateRunner {
  readonly name: string;
  /** Install N-1 -> seed -> swap candidate -> relaunch -> re-assert identical counts. */
  run(ctx: CeremonyContext): Promise<StageResult>;
}

/** The full pluggable component set the runner orchestrates. */
export interface CeremonyComponents {
  seeder: SeederComponent;
  driver: AppDriverComponent;
  dbAsserter: DbSetDiffAsserter;
  exportAsserter: ExportManifestAsserter;
  updateRunner: UpdateMigrateRunner;
}

/** Final ceremony verdict. */
export interface CeremonyReport {
  scenarioId: string;
  /** True iff no stage failed and no deviations were found. */
  passed: boolean;
  /** True iff any assert-capable stage ran as a stub (verdict not certifiable). */
  stubbed: boolean;
  stages: StageResult[];
  /** All deviations across all stages. */
  deviations: CountDeviation[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
}
