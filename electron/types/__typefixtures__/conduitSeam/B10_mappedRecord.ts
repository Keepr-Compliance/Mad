/**
 * BACKLOG-3086 launder fixture — Seam B / C3 — a MAPPED type over an open key set.
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

// `Record<string, SafeSql>` has no properties to descend either. Over a CLOSED key
// set — `Record<"a" | "b", SafeSql>` — it would, which is exactly why sampling one
// mapped type would have proved nothing about the other.
declare const table: Record<string, SafeSql>;

export const laundered = dbAll(table.anythingAtAll, ["x"]);
