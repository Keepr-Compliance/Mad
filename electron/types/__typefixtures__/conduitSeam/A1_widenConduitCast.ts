/**
 * BACKLOG-3086 launder fixture — Seam A / F4 — widen the conduit itself. Names SafeSql nowhere.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run. A guard
 * whose detector quietly dies passes just as loudly as one that works.
 *
 * It compiles clean under the real settings — that is the whole point.
 */
import { dbAll } from "../../../services/db/core/dbConnection";

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

// `as` requires only COMPARABILITY, and `(s: string) => unknown[]` IS assignable to
// `(s: SafeSql) => T[]` by parameter contravariance — so the cast is legal in that
// direction, and the brand is gone.
const widened = dbAll as (s: string, p?: unknown[]) => unknown[];

export const laundered = widened(handWritten, ["x"]);
