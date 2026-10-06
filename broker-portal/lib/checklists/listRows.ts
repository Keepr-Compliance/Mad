/**
 * Template list rows — BACKLOG-3474, BACKLOG-3618.
 *
 * The /dashboard/checklists read and its shaping into rows. Archived means
 * `archived_at` is set and nothing else (the desktop reads `archived_at IS
 * NULL`); required means `is_required` and nothing else.
 *
 * BACKLOG-3618: `owner_user_id` NULL is a brokerage template; set, it is that
 * user's own. Row-level security returns only brokerage rows and the caller's
 * own; splitTemplateRecords drops anything else as well, so the page never
 * shows another user's template whatever the read returns.
 */

import { auditName } from '@/lib/checklists/audit';

export const CHECKLIST_LIST_SELECT =
  'id, name, description, seed_key, archived_at, updated_at, updated_by, sort_order, owner_user_id, include_in_submission, checklist_template_items(is_required)';

export interface TemplateListRecord {
  id: string;
  name: string;
  description: string | null;
  seed_key: string | null;
  archived_at: string | null;
  updated_at: string;
  updated_by: string | null;
  sort_order: number;
  /** NULL = brokerage template. */
  owner_user_id: string | null;
  include_in_submission: boolean;
  checklist_template_items: { is_required: boolean }[] | null;
}

export interface ChecklistListRow {
  id: string;
  name: string;
  description: string | null;
  seeded: boolean;
  archived: boolean;
  /** PostgREST text, display only. */
  updatedAt: string;
  /** Who last edited it: a display name, "a former member", or null (no recorded editor). */
  updatedBy: string | null;
  itemCount: number;
  requiredCount: number;
  /** The caller's own template, set not to be sent with submissions. */
  notSent: boolean;
}

export interface SplitTemplateRecords {
  /** owner_user_id NULL. */
  brokerage: TemplateListRecord[];
  /** owner_user_id = the caller. */
  mine: TemplateListRecord[];
}

/** Brokerage rows and the caller's own; every other owner is dropped. */
export function splitTemplateRecords(records: TemplateListRecord[], userId: string): SplitTemplateRecords {
  return {
    brokerage: records.filter((r) => r.owner_user_id === null),
    mine: records.filter((r) => r.owner_user_id !== null && r.owner_user_id === userId),
  };
}

/** Stable order: equal sort_order and name still sort the same way every time (by id). */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Active before archived, then the organization's own order, then name, then id. */
export function toListRows(
  records: TemplateListRecord[],
  names: Map<string, string> = new Map()
): ChecklistListRow[] {
  return [...records]
    .sort(
      (a, b) =>
        Number(a.archived_at !== null) - Number(b.archived_at !== null) ||
        a.sort_order - b.sort_order ||
        a.name.localeCompare(b.name) ||
        compareIds(a.id, b.id)
    )
    .map((r) => {
      const items = Array.isArray(r.checklist_template_items) ? r.checklist_template_items : [];
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        seeded: r.seed_key !== null,
        archived: r.archived_at !== null,
        updatedAt: r.updated_at,
        updatedBy: auditName(r.updated_by, names),
        itemCount: items.length,
        requiredCount: items.filter((i) => i.is_required === true).length,
        notSent: r.owner_user_id !== null && r.include_in_submission === false,
      };
    });
}
