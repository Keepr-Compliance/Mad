/**
 * BACKLOG-3086 launder fixture — Seam A / P1 — method-syntax bivariance. No cast at all.
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

// `strictFunctionTypes` exempts parameters declared with METHOD syntax from
// contravariance. Rewrite `all` as a property (`all: (s: string) => unknown[]`)
// and this file stops compiling — that one-token difference is the whole launder.
interface LooseConduit {
  all(s: string, p?: unknown[]): unknown[];
}

const holder: LooseConduit = { all: dbAll };

export const laundered = holder.all(handWritten, ["x"]);
