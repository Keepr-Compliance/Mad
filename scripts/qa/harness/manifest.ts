/**
 * Scenario manifest loader + validator for the QA harness (BACKLOG-1848).
 *
 * Reads a scenario JSON (e.g. docs/qa/scenarios/tx1-birchwood.json), validates
 * it against a zod schema that mirrors `ScenarioManifest`, and resolves file
 * references (`expectedManifestRef`, seed paths) relative to the manifest.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, resolve } from 'path';
import { z } from 'zod';
import type { ScenarioManifest } from './types';

const expectedCountsSchema = z.object({
  corpus: z.number().int().nonnegative(),
  filterOff: z.number().int().nonnegative(),
  filterOn: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  extra: z.number().int().nonnegative(),
  ghosts: z.number().int().nonnegative(),
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO calendar date (YYYY-MM-DD)');

const scenarioSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  source: z.enum(['outlook', 'gmail']),
  transaction: z.object({
    label: z.string().min(1),
    address: z.string().min(1),
    normalizedTokens: z.array(z.string().min(1)).min(1),
  }),
  auditWindow: z.object({ start: isoDate, end: isoDate }),
  contacts: z.array(z.string().min(3)).min(1),
  ownAddressExcluded: z.string().min(3),
  dateShiftMonths: z.number().int(),
  expectedCounts: expectedCountsSchema,
  expectedManifestRef: z.string().min(1),
  // Enforce the load-bearing set-identity rule at the schema level.
  setIdentity: z.literal('subject+shifted-date'),
  seed: z
    .object({
      corpusDir: z.string().optional(),
      outboundSender: z.string().optional(),
      tokenFile: z.string().optional(),
    })
    .optional(),
});

/** Expand a leading `~` and `$VAR`/`${VAR}` references in a path. */
export function expandPath(p: string): string {
  let out = p;
  if (out === '~' || out.startsWith('~/')) {
    out = out.replace(/^~/, homedir());
  }
  out = out.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/gi, (match, name: string) => {
    const val = process.env[name];
    return val === undefined ? match : val;
  });
  return out;
}

/** Resolve a manifest-relative path (after `~`/env expansion) to absolute. */
export function resolveRef(manifestPath: string, ref: string): string {
  const expanded = expandPath(ref);
  if (isAbsolute(expanded)) return expanded;
  return resolve(dirname(manifestPath), expanded);
}

export interface LoadedScenario {
  scenario: ScenarioManifest;
  /** Absolute path to the manifest file. */
  path: string;
  /** Absolute path to the canonical checklist markdown. */
  canonicalListPath: string;
}

/** Parse + validate scenario JSON text. Throws a readable error on failure. */
export function parseScenario(json: string, sourceLabel: string): ScenarioManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Scenario ${sourceLabel} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = scenarioSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Scenario ${sourceLabel} failed validation:\n${issues}`);
  }
  return result.data as ScenarioManifest;
}

/** Load + validate a scenario file from disk and resolve its references. */
export function loadScenario(manifestPath: string): LoadedScenario {
  const absPath = isAbsolute(manifestPath)
    ? manifestPath
    : resolve(process.cwd(), manifestPath);
  const json = readFileSync(absPath, 'utf-8');
  const scenario = parseScenario(json, absPath);
  return {
    scenario,
    path: absPath,
    canonicalListPath: resolveRef(absPath, scenario.expectedManifestRef),
  };
}
