/**
 * BACKLOG-3086 MUST-NOT-FIRE fixture — the legitimate path, kept next to the launders.
 *
 * Every other file in this directory exists to be DETECTED. This one exists to be
 * IGNORED, and the guard asserts that on every run alongside the rest.
 *
 * It is the shape Phase B will write hundreds of times: a fragment helper that returns
 * `SafeSql`, composed into a statement with the tag, handed to a conduit verb. It has
 * a BODY, so the compiler checks that it really produces the brand — which is exactly
 * the line Seam B draws, and the reason Seam B can stay silent here without weakening.
 *
 * A guard that fires on the correct path does not get tightened; it gets deleted. So
 * "does not fire on legitimate code" is an assertion, not an assumption — and it lives
 * here rather than in a reviewer's memory of one PR.
 */
import { dbAll } from "../../../services/db/core/dbConnection";
import { sql } from "../../../services/db/core/sqlText";
import type { SafeSql } from "../../../services/db/core/sqlText";

/** A bodied producer. The compiler checks the return; nothing is taken on trust. */
export function activeContactsClause(): SafeSql {
  return sql`c.deleted_at IS NULL`;
}

export function listActiveContacts(): Array<{ id: string }> {
  return dbAll<{ id: string }>(
    sql`SELECT c.id FROM contacts c WHERE ${activeContactsClause()}`,
    [],
  );
}
