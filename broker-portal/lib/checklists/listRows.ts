/**
 * Template list rows — BACKLOG-3474.
 *
 * The /dashboard/checklists read and its shaping into rows. Archived means
 * `archived_at` is set and nothing else (the desktop reads `archived_at IS
 * NULL`); required means `is_required` and nothing else.
 */

import { auditName } from '@/lib/checklists/audit';

export const CHECKLIST_LIST_SELECT =
  'id, name, description, seed_key, archived_at, updated_at, updated_by, sort_order, checklist_template_items(is_required)';

export interface TemplateListRecord {
  id: string;
  name: string;
  description: string | null;
  seed_key: string | null;
  archived_at: string | null;
  updated_at: string;
  updated_by: string | null;
  sort_order: number;
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
}

/** Active before archived, then the organization's own order, then name. */
export function toListRows(
  records: TemplateListRecord[],
  names: Map<string, string> = new Map()
): ChecklistListRow[] {
  return [...records]
    .sort(
      (a, b) =>
        Number(a.archived_at !== null) - Number(b.archived_at !== null) ||
        a.sort_order - b.sort_order ||
        a.name.localeCompare(b.name)
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
      };
    });
}
