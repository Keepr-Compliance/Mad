/**
 * Broker shared reports: reply parsers — BACKLOG-3513 PR-3b.
 *
 * PURE (no Supabase, no React), so the server page and the browser api share
 * them. Shapes are transcribed from migration 20261112200000:
 *  - broker_report_share_list(p_def) -> {owner {id, name, role, is_you},
 *    general_access, row_scope, level, entries [{kind, id, name, detail, level}]}
 *    (person detail = the raw organization role; role ids agent, broker,
 *    admins, admin, it_admin)
 *  - broker_report_share_candidates(p_def) -> {people [{kind 'person', id, name,
 *    detail}], roles [{kind 'role', id, name, detail}]} (three roles: agent,
 *    broker, admins). Never an email.
 *  - broker_report_def_get(p_def) -> {id, organization_id, dataset_key, name,
 *    description, definition, row_scope, general_access, level, owner {name,
 *    is_you}, updated_at, take_over_available} (take_over_available: 20261112210000)
 *
 * Mappers keep only the kit's keys, so nothing else a reply might carry
 * reaches the page.
 */

import type { SharingEntry, SharingLevel, SharingPrincipal } from '@keepr/ui';

export type ReportLevel = 'owner' | 'editor' | 'viewer';
export type GeneralAccess = 'restricted' | 'organization';
export type RowScope = 'all' | 'own';

/** organization_members.role -> the label the portal shows. */
const ROLE_LABELS: Record<string, string> = { agent: 'Agent', broker: 'Broker', admin: 'Admin', it_admin: 'IT Admin' };

export function roleLabel(role: unknown): string | undefined {
  return typeof role === 'string' ? ROLE_LABELS[role] : undefined;
}

export interface ShareOwner {
  /** null: the owner's account no longer exists. */
  id: string | null;
  name: string;
  /** The owner's role when they are an active member; null when they are not (deactivated or gone). */
  role: string | null;
  isYou: boolean;
}

export interface ShareState {
  owner: ShareOwner;
  generalAccess: GeneralAccess;
  rowScope: RowScope;
  level: ReportLevel | null;
  entries: SharingEntry[];
}

export interface DefinitionRecord {
  id: string;
  name: string;
  description: string | null;
  definition: unknown;
  rowScope: RowScope;
  generalAccess: GeneralAccess;
  level: ReportLevel | null;
  updatedAt: string;
  /** def_get (migration 20261112210000): this caller may take the report over (its owner is gone). */
  takeOverAvailable: boolean;
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const level = (v: unknown): SharingLevel => (v === 'editor' ? 'editor' : 'viewer');

export function parseLevel(v: unknown): ReportLevel | null {
  return v === 'owner' || v === 'editor' || v === 'viewer' ? v : null;
}

function principal(raw: unknown): SharingPrincipal | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id || (r.kind !== 'person' && r.kind !== 'role')) return null;
  const out: SharingPrincipal = { id, kind: r.kind, name: str(r.name) || (r.kind === 'person' ? 'Member' : id) };
  const detail = r.kind === 'person' ? (roleLabel(r.detail) ?? (str(r.detail) || undefined)) : str(r.detail) || undefined;
  if (detail) out.detail = detail;
  return out;
}

/** share_candidates -> picker rows: people first, then the role targets, exactly as the server sends them. */
export function parseCandidates(raw: unknown): SharingPrincipal[] {
  const r = obj(raw);
  const people = Array.isArray(r.people) ? r.people : [];
  const roles = Array.isArray(r.roles) ? r.roles : [];
  return [...people, ...roles].map(principal).filter((p): p is SharingPrincipal => p !== null);
}

/** share_list -> owner, general access, row scope, the caller's level and the entries. */
export function parseShareState(raw: unknown): ShareState {
  const r = obj(raw);
  const o = obj(r.owner);
  const entries = (Array.isArray(r.entries) ? r.entries : [])
    .map((e) => {
      const p = principal(e);
      return p ? { ...p, level: level(obj(e).level) } : null;
    })
    .filter((e): e is SharingEntry => e !== null);
  return {
    owner: {
      id: typeof o.id === 'string' && o.id ? o.id : null,
      name: str(o.name),
      role: typeof o.role === 'string' && o.role ? o.role : null,
      isYou: o.is_you === true,
    },
    generalAccess: r.general_access === 'organization' ? 'organization' : 'restricted',
    rowScope: r.row_scope === 'own' ? 'own' : 'all',
    level: parseLevel(r.level),
    entries,
  };
}

export function parseDefinition(raw: unknown): DefinitionRecord | null {
  const r = obj(raw);
  if (!str(r.id)) return null;
  return {
    id: str(r.id),
    name: str(r.name),
    description: typeof r.description === 'string' ? r.description : null,
    definition: r.definition ?? {},
    rowScope: r.row_scope === 'own' ? 'own' : 'all',
    generalAccess: r.general_access === 'organization' ? 'organization' : 'restricted',
    level: parseLevel(r.level),
    updatedAt: str(r.updated_at),
    takeOverAvailable: r.take_over_available === true,
  };
}

/** A report whose owner is gone or deactivated (broker_report_orphans, migration 20261112210000). */
export interface OrphanReport {
  id: string;
  name: string;
  ownerName: string;
  ownerState: 'gone' | 'deactivated';
  /** The caller's own level; null when the report is not shared with them. */
  level: ReportLevel | null;
}

/**
 * broker_report_orphans -> [{id, name, dataset_key, owner_name, owner_state, level}].
 * Only Submissions reports; anything malformed is skipped.
 */
export function parseOrphans(raw: unknown): OrphanReport[] {
  if (!Array.isArray(raw)) return [];
  const out: OrphanReport[] = [];
  for (const item of raw) {
    const r = obj(item);
    if (!str(r.id) || r.dataset_key !== 'submissions') continue;
    out.push({
      id: str(r.id),
      name: str(r.name),
      ownerName: str(r.owner_name),
      ownerState: r.owner_state === 'gone' ? 'gone' : 'deactivated',
      level: parseLevel(r.level),
    });
  }
  return out;
}

