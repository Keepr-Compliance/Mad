/**
 * BACKLOG-3086 launder fixture — Seam B / C2 — an INDEX SIGNATURE, which is not a property.
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

// `getProperties()` returns NOTHING for this type: an index signature is a different
// axis. No depth budget reaches it, because the walk never asked.
declare const bag: { [k: string]: SafeSql };

export const laundered = dbAll(bag.anythingAtAll, ["x"]);
