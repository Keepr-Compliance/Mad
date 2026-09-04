/**
 * BACKLOG-3086 launder fixture — Seam B / C1 — the brand is what an interface METHOD RETURNS.
 *
 * NOT a mistake and NOT dead code. This file exists to BE detected:
 * `electron/services/db/core/__tests__/sqlText.conduitSeam.test.ts` adds this
 * directory to its program and asserts this file is reported, every run.
 *
 * Found by SR review of PR #2488, planted in `electron/utils/exportUtils.ts` with
 * real SQL reaching `dbAll`: type-check 0, type-check:tests 0, escape ratchet 8/8,
 * SQL gate OK, and this guard 9/9 GREEN — while a positive control in the same file
 * went RED, so the green was readable and the miss was real.
 *
 * The cause was an UNVISITED AXIS in `carriesBrand`, not an exhausted depth budget.
 */
import { dbAll } from "../../../services/db/core/dbConnection";
import type { SafeSql } from "../../../services/db/core/sqlText";

// A CLASS implementing this with `make(s: string): string` is refused — TS2416,
// because return position stays covariant even under method syntax. So the interface
// is not the hole; the AMBIENT declaration below is, because it has no implementation
// for the compiler to check at all.
interface Maker {
  make(s: string): SafeSql;
}

declare const maker: Maker;

const handWritten = `SELECT id FROM contacts WHERE display_name = 'x'`;

export const laundered = dbAll(maker.make(handWritten), ["x"]);
