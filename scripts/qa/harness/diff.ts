/**
 * Set-diff + exact-count comparison for the QA harness (BACKLOG-1848).
 *
 * Membership is keyed by (subject, shiftedDate) — NEVER Message-ID. This module
 * is the shared truth both the runner and the H3 DB asserter (BACKLOG-1850)
 * use to turn "expected vs actual" into explicit findings.
 */
import type {
  CountDeviation,
  EmailSetMember,
  ExpectedSets,
} from './types';

/**
 * Canonical membership key. Subjects are trimmed and internal whitespace is
 * collapsed so cosmetic spacing never masquerades as a set difference; dates
 * are compared as the literal ISO calendar day.
 */
export function memberKey(m: EmailSetMember): string {
  const subject = m.subject.trim().replace(/\s+/g, ' ');
  const date = m.shiftedDate.trim();
  return `${subject} ${date}`;
}

export interface MemberDiff {
  /** In `expected` but not in `actual`. */
  missing: EmailSetMember[];
  /** In `actual` but not in `expected`. */
  extra: EmailSetMember[];
}

/** Bucket members by their (subject, shiftedDate) key. */
function bucketByKey(members: EmailSetMember[]): Map<string, EmailSetMember[]> {
  const map = new Map<string, EmailSetMember[]>();
  for (const m of members) {
    const key = memberKey(m);
    const bucket = map.get(key);
    if (bucket) bucket.push(m);
    else map.set(key, [m]);
  }
  return map;
}

/**
 * Diff two email sets by (subject, shiftedDate) using MULTISET semantics.
 * Order-independent. Multiset (not set) is load-bearing: the canonical TX1 list
 * contains distinct emails that legitimately share a (subject, shiftedDate) key
 * (e.g. a same-day reply + its predecessor). Comparing as a plain set would
 * silently collapse them and under-count. A key expected N times but present M
 * times contributes |N-M| entries to missing/extra.
 */
export function diffMembers(
  expected: EmailSetMember[],
  actual: EmailSetMember[],
): MemberDiff {
  const expectedByKey = bucketByKey(expected);
  const actualByKey = bucketByKey(actual);

  const missing: EmailSetMember[] = [];
  for (const [key, members] of expectedByKey) {
    const actualCount = actualByKey.get(key)?.length ?? 0;
    for (let i = actualCount; i < members.length; i++) missing.push(members[i]);
  }
  const extra: EmailSetMember[] = [];
  for (const [key, members] of actualByKey) {
    const expectedCount = expectedByKey.get(key)?.length ?? 0;
    for (let i = expectedCount; i < members.length; i++) extra.push(members[i]);
  }
  return { missing, extra };
}

/** The actual sets an asserter (or the runner) measured. */
export interface ActualSets {
  corpus: number;
  filterOff: EmailSetMember[];
  filterOn: EmailSetMember[];
  ghosts: EmailSetMember[];
}

/**
 * Compare measured sets against the scenario's expected sets and return the
 * list of exact-count deviations. An empty array means every gate held.
 */
export function evaluateSetDiff(
  expected: ExpectedSets,
  actual: ActualSets,
): CountDeviation[] {
  const deviations: CountDeviation[] = [];

  // 1. Corpus total.
  if (actual.corpus !== expected.counts.corpus) {
    deviations.push({
      cell: 'corpus',
      expected: expected.counts.corpus,
      got: actual.corpus,
    });
  }

  // 2. filter-OFF exact count + membership.
  const offDiff = diffMembers(expected.filterOff, actual.filterOff);
  if (actual.filterOff.length !== expected.counts.filterOff) {
    deviations.push({
      cell: 'filterOff',
      expected: expected.counts.filterOff,
      got: actual.filterOff.length,
      missingMembers: offDiff.missing,
      extraMembers: offDiff.extra,
    });
  }

  // 3. filter-ON exact count + membership.
  const onDiff = diffMembers(expected.filterOn, actual.filterOn);
  if (actual.filterOn.length !== expected.counts.filterOn) {
    deviations.push({
      cell: 'filterOn',
      expected: expected.counts.filterOn,
      got: actual.filterOn.length,
      missingMembers: onDiff.missing,
      extraMembers: onDiff.extra,
    });
  }

  // 4. missing (expected members absent from filter-OFF actual) — target 0.
  if (offDiff.missing.length !== expected.counts.missing) {
    deviations.push({
      cell: 'missing',
      expected: expected.counts.missing,
      got: offDiff.missing.length,
      missingMembers: offDiff.missing,
    });
  }

  // 5. extra (unexpected members in filter-OFF actual) — target 0.
  if (offDiff.extra.length !== expected.counts.extra) {
    deviations.push({
      cell: 'extra',
      expected: expected.counts.extra,
      got: offDiff.extra.length,
      extraMembers: offDiff.extra,
    });
  }

  // 6. ghosts (mechanical sent_at scan) — target 0.
  if (actual.ghosts.length !== expected.counts.ghosts) {
    deviations.push({
      cell: 'ghosts',
      expected: expected.counts.ghosts,
      got: actual.ghosts.length,
      extraMembers: actual.ghosts,
    });
  }

  return deviations;
}

/** Render a member list compactly for CLI output. */
export function formatMembers(members: EmailSetMember[], limit = 20): string {
  if (members.length === 0) return '(none)';
  const shown = members
    .slice(0, limit)
    .map((m) => `      - [${m.shiftedDate}] ${m.subject}`);
  if (members.length > limit) {
    shown.push(`      … and ${members.length - limit} more`);
  }
  return shown.join('\n');
}

/** Render one deviation as a human-readable, per-cell block. */
export function formatDeviation(d: CountDeviation): string {
  const lines: string[] = [
    `  ✗ ${d.cell}: expected ${d.expected}, got ${d.got}`,
  ];
  if (d.missingMembers && d.missingMembers.length > 0) {
    lines.push(`    missing (expected but absent):`);
    lines.push(formatMembers(d.missingMembers));
  }
  if (d.extraMembers && d.extraMembers.length > 0) {
    lines.push(`    extra (present but not expected):`);
    lines.push(formatMembers(d.extraMembers));
  }
  return lines.join('\n');
}
