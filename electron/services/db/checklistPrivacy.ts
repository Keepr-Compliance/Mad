/**
 * The private per-deal checklist ("My items") — BACKLOG-3966.
 *
 * One reserved checklist row per deal carries the agent's own items. It is
 * marked by its `template_id`, which holds the reserved value below instead of
 * a broker template's cloud id. No column is added for it: UNIQUE
 * (transaction_id, template_id) already keeps it to one row per deal.
 *
 * PRIVATE means the row and everything under it (items, links, members) never
 * reach a broker-facing reader: the submission snapshot sent to the cloud, the
 * submit pre-flight, the members sent although outside the audit dates, the
 * export's checklist section and the pre-submit warning. Agent-side readers
 * (the Checklist tab, the Recent ring, the Todo list) still count it.
 *
 * This module is the ONLY place that knows the reserved value. Every reader
 * decides through `isPrivateChecklist` (object readers) or
 * `NOT_PRIVATE_CHECKLIST_SQL` (raw SQL). Matching is EXACT: a template id that
 * merely starts with `keepr:` is not private.
 *
 * Nothing writes the row yet (the write path is a later slice), so today every
 * exclusion here is inert.
 */

import { sql } from "./core/sqlText";

/** The reserved `transaction_checklists.template_id` of the private checklist. */
export const MY_ITEMS_TEMPLATE_ID = "keepr:my-items";

/** True only for the reserved id, compared exactly. */
export function isPrivateChecklist(templateId: string | null | undefined): boolean {
  return templateId === MY_ITEMS_TEMPLATE_ID;
}

/**
 * SQL fragment: the checklist aliased `cl` is NOT the private one. Splice it
 * into any statement whose `transaction_checklists` alias is `cl`. The literal
 * is the value of {@link MY_ITEMS_TEMPLATE_ID}; `checklistPrivacy-3966.test.ts`
 * holds the two in step.
 */
export const NOT_PRIVATE_CHECKLIST_SQL = sql`cl.template_id <> 'keepr:my-items'`;

/** Who a checklist read is for. `broker` leaves the private checklist out. */
export type ChecklistAudience = "agent" | "broker";
