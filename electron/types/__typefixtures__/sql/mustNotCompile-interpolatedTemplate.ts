/**
 * CONTROL 1 — the BACKLOG-3062 defect shape. BACKLOG-3064.
 *
 * TRANSCRIBED, NOT INVENTED. The pre-3062 source is recorded verbatim in the
 * repo's own characterization suite, which pins both the defect and its fix:
 *
 *   electron/__tests__/message-import-handlers.allTime-2561.test.ts:425
 *     `` `AND message.date > ${plan.cutoffNano}` `` had to appear in the source.
 *   :444  expect(filter.sql).toBe("AND message.date > ?");
 *
 * This is the shape the item exists for, and the shape NO MATCHER CAN SEE. The
 * item body states the reason plainly: this
 *
 *     AND message.date > ${cutoffNano}
 *
 * and this
 *
 *     `${name} and ${other} were both updated`
 *
 * are the same lexical construct. The distinguishing fact — what the value is FOR
 * — is not in the text. Tighten the pattern and it misses the defect; loosen it
 * and it fires on ordinary prose, becomes noise, and is switched off inside a
 * week.
 *
 * A TYPE separates them without looking at the text at all: the prose template is
 * never passed to a database verb, so nothing ever asks it for a `SafeSql`.
 *
 *   BEFORE -> compiles clean, exit 0.
 *   AFTER  -> TS2345 naming `SafeSql`.
 */
import { dbAll } from "../../../services/db/core/dbConnection";

declare const cutoffNano: number;

void dbAll<{ id: string }>(
  `SELECT message.rowid AS id FROM message
    WHERE message.date > ${cutoffNano}`,
);
