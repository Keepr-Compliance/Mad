/**
 * BACKLOG-3297 — prints, as JSON on stdout, how the main-process timestamp parser
 * reads SQLite's zone-less UTC values in the timezone THIS process was started in.
 *
 * A jest test cannot change its own timezone (V8 caches the zone and jest hands
 * tests a COPY of `process.env`; see `auditWindowZoneProbe.ts`), so
 * `dbTimestamp.zone-3297.test.ts` starts this file in a child with `TZ` set.
 *
 * `zone` and `bareDateOffsetMs` exist so the test can prove the zone really took
 * effect before trusting anything else in the report: on a UTC runner a child
 * that silently kept UTC would make every parse assertion pass vacuously.
 */
import { parseDbTimestamp } from "../../electron/utils/dbTimestamp";

const NAIVE = "2026-09-13 18:15:21";

const inputs = [
  NAIVE,
  "2026-09-13T18:15:21",
  "2026-09-13 18:15",
  "2026-09-13 18:15:21.5",
  "2026-09-13 18:15:21.123456",
  "2026-09-14T18:15:21.549Z",
  "2026-09-13T12:15:21-06:00",
];

const report = {
  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  /** What a bare `new Date(NAIVE)` gets wrong in this zone, in ms (0 at UTC). */
  bareDateOffsetMs: new Date(NAIVE).getTime() - Date.parse(`${NAIVE.replace(" ", "T")}Z`),
  parsed: Object.fromEntries(inputs.map((raw) => [raw, parseDbTimestamp(raw)?.getTime() ?? null])),
};

process.stdout.write(JSON.stringify(report));
