/**
 * BACKLOG-3086 launder fixture — Seam B / P9 — BACKLOG-3072's spelling problem, inside Seam B.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run. A guard
 * whose detector quietly dies passes just as loudly as one that works.
 *
 * It compiles clean under the real settings — that is the whole point.
 */
import { dbAll } from "../../../services/db/core/dbConnection";
import type { SafeSql as Ok } from "../../../services/db/core/sqlText";

// The brand is reached through an IMPORT ALIAS behind a TYPE ALIAS, so the string
// "SafeSql" appears nowhere below. Only checker-resolved type identity finds it;
// this fixture is what stops a future rewrite from regressing to a name set.
type Sneaky = Ok;

function launder(s: string): Sneaky;
function launder(s: string): string {
  return s;
}

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

export const laundered = dbAll(launder(handWritten), ["x"]);
