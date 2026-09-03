/**
 * BACKLOG-3086 launder fixture — Seam B / P8 — the same overload launder wearing a class.
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

class Launderer {
  make(s: string): SafeSql;
  make(s: string): string {
    return s;
  }
}

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

export const laundered = dbAll(new Launderer().make(handWritten), ["x"]);
