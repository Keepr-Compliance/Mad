/**
 * BACKLOG-2678 CONTROL 1 — SEEDED ORPHAN (temporary).
 *
 * This file lives in docs/, which no CI test config selects. It exists only to
 * prove that scripts/ci/check-test-drift.mjs actually REDS on an orphaned test
 * file, in CI and not merely on a developer machine. A gate that has never
 * reported anything is indistinguishable from a gate that cannot report.
 *
 * It is removed in the commit immediately after the failing CI run is captured.
 */
describe('drift canary', () => {
  it('is never executed by any CI config — that is the point', () => {
    expect(true).toBe(true);
  });
});
