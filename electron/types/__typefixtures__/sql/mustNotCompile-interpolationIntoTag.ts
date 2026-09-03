/**
 * CONTROL 1 — the authoring site, which is the half a boundary check can never
 * reach. BACKLOG-3064.
 *
 * The four `plainStringTo*` fixtures prove the BOUNDARY refuses an unbranded
 * string. This one proves the PRODUCER refuses to mint a brand around a spliced
 * value — so the natural thing to write is also the correct thing, rather than a
 * thing that compiles and is caught later by review.
 *
 * `sql` is typed `(strings: TemplateStringsArray, ...values: SafeSql[])`. An
 * interpolation is therefore only legal if it is ITSELF already branded SQL — a
 * clause, a column list, a generated placeholder list. A VALUE cannot be spliced,
 * because a value is not SQL. That is the BACKLOG-3062 defect made unwritable at
 * the keystroke rather than refused at the door.
 *
 * This fixture has NO before-leg and the PR says so: the `sql` tag does not exist
 * at the base commit, so there is nothing to compile. Its before-evidence is
 * `mustNotCompile-interpolatedTemplate.ts`, which is the same defect expressed in
 * the syntax available today and DOES compile clean at the base commit.
 *
 *   AFTER -> TS2345: `number` is not assignable to `SafeSql`.
 */
import { dbAll } from "../../../services/db/core/dbConnection";
import { sql } from "../../../services/db/core/sqlText";

declare const cutoffNano: number;

void dbAll<{ id: string }>(
  sql`SELECT message.rowid AS id FROM message
       WHERE message.date > ${cutoffNano}`,
);
