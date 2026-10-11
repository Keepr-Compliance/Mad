/**
 * @jest-environment node
 */

/**
 * BACKLOG-3845 — parity between the SQL paid_through rule
 * (public._override_effective, migration 20261011100000) and the offline pass
 * issuer's parsePaidThrough (supabase/functions/_shared/offlinePassClaims.ts).
 *
 * Both read ONE corpus file, supabase/tests/backlog-3845/corpus/paid_through.json.
 * The SQL harness (control k03) asserts each entry against _override_effective
 * and the three resolvers; this test asserts the same entries against
 * parsePaidThrough. An entry the two would answer differently fails one side.
 *
 * "Entitled" on the pass side = parse ok AND (no cap OR cap later than now),
 * the issuer's rule (`pte <= iat` → no pass). `now` is fixed between the
 * corpus's past (2020) and future (2098) dates.
 */

import { readFileSync } from "fs";
import path from "path";
import { parsePaidThrough } from "../../supabase/functions/_shared/offlinePassClaims";

interface Case {
  name: string;
  override: Record<string, unknown>;
  entitled: boolean;
}

const corpus = JSON.parse(
  readFileSync(path.join(__dirname, "../../supabase/tests/backlog-3845/corpus/paid_through.json"), "utf8"),
) as { cases: Case[] };

const NOW_SEC = Date.UTC(2026, 9, 11) / 1000;

function passEntitled(override: unknown): boolean {
  const p = parsePaidThrough(override);
  if (!p.ok) return false;
  return p.pte === null || p.pte > NOW_SEC;
}

describe("paid_through parity corpus (SQL _override_effective ↔ parsePaidThrough)", () => {
  it("has the cases the SR ruling names", () => {
    const names = corpus.cases.map((c) => c.name);
    for (const n of ["absent", "json-null", "soon", "empty-string", "number", "boolean", "object", "bad-month-day", "garbage-after-T"]) {
      expect(names).toContain(n);
    }
    expect(corpus.cases.length).toBeGreaterThanOrEqual(16);
  });

  it.each(corpus.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(passEntitled(c.override)).toBe(c.entitled);
  });
});
