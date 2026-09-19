/**
 * @jest-environment node
 *
 * BACKLOG-3297 — the main-process timestamp parser is a MIRROR of the renderer's.
 *
 * `electron/` cannot import from `src/` at build time, so
 * `electron/utils/dbTimestamp.ts` carries its own copy of `normalizeDbTimestamp`
 * and `parseDbTimestamp` (`src/utils/dateFormatters.ts`, BACKLOG-2632). Two
 * parsers for one column format drift silently; this runs both over one corpus
 * that covers every branch of the shared regex and each side of it.
 *
 * `normalizeDbTimestamp` is compared as a string, which carries no ambient
 * timezone, so a divergence shows on any runner. `parseDbTimestamp` is compared
 * by instant.
 */
import {
  normalizeDbTimestamp as mainNormalize,
  parseDbTimestamp as mainParse,
} from "../dbTimestamp";
import {
  normalizeDbTimestamp as rendererNormalize,
  parseDbTimestamp as rendererParse,
} from "../../../src/utils/dateFormatters";

/** Trimmed, non-empty strings: the input contract of `normalizeDbTimestamp`. */
const STRINGS = [
  // space and T separators
  "2026-09-13 18:15:21",
  "2026-09-13T18:15:21",
  // no seconds
  "2026-09-13 18:15",
  "2026-09-13T18:15",
  // 1, 3, 4, 6 and 7 fraction digits
  "2026-09-13 18:15:21.5",
  "2026-09-13 18:15:21.123",
  "2026-09-13 18:15:21.1234",
  "2026-09-13 18:15:21.123456",
  "2026-09-13 18:15:21.1234567",
  // already zoned
  "2026-09-14T18:15:21.549Z",
  "2026-09-13 18:15:21Z",
  "2026-09-13T18:15:21+00:00",
  "2026-09-13T12:15:21-06:00",
  // date-only
  "2026-09-13",
  // garbage and near-misses
  "not a date",
  "2026-9-13 18:15:21",
  "2026-09-13 18:15:21 ",
  "18:15:21",
];

/** Everything `parseDbTimestamp` accepts, including the values it rejects. */
const VALUES: Array<string | Date | null | undefined> = [
  ...STRINGS,
  "",
  "   ",
  "  2026-09-13 18:15:21  ",
  null,
  undefined,
  new Date(Date.UTC(2026, 8, 13, 18, 15, 21)),
  new Date("invalid"),
];

const label = (v: unknown): string =>
  v instanceof Date ? `Date(${isNaN(v.getTime()) ? "invalid" : v.toISOString()})` : JSON.stringify(v);

describe("electron dbTimestamp mirrors src dateFormatters (BACKLOG-3297)", () => {
  it.each(STRINGS.map((s) => [s]))("normalizeDbTimestamp(%j) matches", (raw) => {
    expect(mainNormalize(raw)).toBe(rendererNormalize(raw));
  });

  it.each(VALUES.map((v) => [label(v), v] as const))("parseDbTimestamp(%s) matches", (_name, value) => {
    const main = mainParse(value);
    const renderer = rendererParse(value);
    expect(main === null ? null : main.getTime()).toBe(renderer === null ? null : renderer.getTime());
  });

  it("the corpus exercises both branches: some inputs gain a Z, some are left alone", () => {
    const changed = STRINGS.filter((s) => mainNormalize(s) !== s);
    const unchanged = STRINGS.filter((s) => mainNormalize(s) === s);
    expect(changed.length).toBeGreaterThan(0);
    expect(unchanged.length).toBeGreaterThan(0);
  });
});
