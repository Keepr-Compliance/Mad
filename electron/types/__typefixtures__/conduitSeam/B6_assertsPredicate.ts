/**
 * BACKLOG-3086 launder fixture — Seam B / P14 — an assertion predicate, same unchecked claim.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run. A guard
 * whose detector quietly dies passes just as loudly as one that works.
 *
 * It compiles clean under the real settings — that is the whole point.
 */
import { dbAll } from "../../../services/db/core/dbConnection";
import type { SafeSql } from "../../../services/db/core/sqlText";

function assertSql(s: string): asserts s is SafeSql {
  void s;
}

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

export function laundered(): unknown[] {
  assertSql(handWritten);
  return dbAll(handWritten, ["x"]);
}
