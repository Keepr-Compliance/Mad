/**
 * Checklist template audit fields — BACKLOG-3474.
 *
 * Who created, last edited and archived a template. The three `*_by` columns
 * reference auth.users, so PostgREST cannot embed the person; their names are
 * read in a second query from `public.users` (same ids), whose SELECT policy
 * lets a member read the other members of their organizations. `profiles` is
 * NOT used: its only SELECT policy is the caller's own row.
 *
 * A non-null id that does not resolve (the person left the organization, or
 * the account is gone) reads "a former member". A null id (seeded templates,
 * rows edited before these columns existed, a never-edited template) shows the
 * date alone. A raw id is never shown.
 */

import { formatUserDisplayName } from '@/lib/utils/userDisplay';

export const FORMER_MEMBER = 'a former member';

export const AUDIT_USER_SELECT = 'id, email, display_name, first_name, last_name';

export interface AuditUserRecord {
  id: string;
  email: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
}

/** One audit event: when, and who (a display name, or null for no one). */
export interface AuditEntry {
  at: string | null;
  by: string | null;
}

export interface TemplateAudit {
  created: AuditEntry;
  edited: AuditEntry;
  /** null while the template is active. */
  archived: AuditEntry | null;
}

/** Minimal client shape: `from('users').select(...).in('id', ids)`. */
interface UsersReader {
  from: (table: 'users') => {
    select: (columns: string) => {
      in: (column: 'id', values: string[]) => PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
}

/** Distinct non-empty ids. */
export function auditUserIds(...ids: (string | null | undefined)[]): string[] {
  return Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id !== '')));
}

/** id -> display name for every id the caller may read. A failed read resolves nobody. */
export async function resolveAuditNames(supabase: unknown, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const { data, error } = await (supabase as UsersReader).from('users').select(AUDIT_USER_SELECT).in('id', ids);
  if (error || !Array.isArray(data)) return names;
  for (const u of data as AuditUserRecord[]) {
    if (typeof u?.id === 'string') names.set(u.id, formatUserDisplayName(u, u.email));
  }
  return names;
}

/** The name to show for an id: null for no one, FORMER_MEMBER when it does not resolve. */
export function auditName(id: string | null | undefined, names: Map<string, string>): string | null {
  if (typeof id !== 'string' || id === '') return null;
  return names.get(id) ?? FORMER_MEMBER;
}

export function formatAuditDate(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Created Sep 24, 2026 by Jane Doe", "Created Sep 24, 2026", or "" with no date. */
export function auditText(label: string, entry: AuditEntry): string {
  const date = formatAuditDate(entry.at);
  if (!date) return '';
  return entry.by ? `${label} ${date} by ${entry.by}` : `${label} ${date}`;
}
