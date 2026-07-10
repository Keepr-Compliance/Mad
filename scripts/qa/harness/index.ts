/**
 * QA Harness public surface (BACKLOG-1848 / QA-H1).
 *
 * Sibling tasks (H2/H3/H4/H5) import the contract + helpers from here:
 *   import type { DbSetDiffAsserter, ExpectedSets } from 'scripts/qa/harness';
 *   import { diffMembers, evaluateSetDiff } from 'scripts/qa/harness';
 */
export * from './types';
export { createLogger } from './logger';
export {
  memberKey,
  diffMembers,
  evaluateSetDiff,
  formatDeviation,
  formatMembers,
} from './diff';
export type { MemberDiff, ActualSets } from './diff';
export {
  parseCanonicalList,
  loadCanonicalList,
  toExpectedSets,
} from './canonicalList';
export type { ParsedCanonicalList } from './canonicalList';
export {
  loadScenario,
  parseScenario,
  expandPath,
  resolveRef,
} from './manifest';
export type { LoadedScenario } from './manifest';
export { buildComponents, selectSeeder } from './components/registry';
export { runCeremony } from './runner';
