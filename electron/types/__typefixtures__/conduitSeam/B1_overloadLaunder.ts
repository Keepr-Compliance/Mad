/**
 * BACKLOG-3086 launder fixture — Seam B / F6 — function overload launder. The brand is a RETURN ANNOTATION.
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

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

// TypeScript does NOT require an implementation signature to be assignable to its
// overloads. No cast, no `any`, and `SafeSql` never appears in an assertion.
function launder(s: string): SafeSql;
function launder(s: string): string {
  return s;
}

export const laundered = dbAll(launder(handWritten), ["x"]);
