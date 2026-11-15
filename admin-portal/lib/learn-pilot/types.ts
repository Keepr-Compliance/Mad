/**
 * Learn pilot — shapes for the admin page (BACKLOG-4219). Pure: no Supabase, no React.
 *
 * `AdminListRow` is one row of public.learn_pilot_report_admin_list()
 * (supabase/migrations/20261112130000_backlog_4219_learn_pilot_report.sql), restricted to the
 * fields the page reads. The page never reads version_canary_org (it names another org).
 *
 * `PilotViewModel` is what page.tsx (server) hands to LearnPilotView (client). It is serialised
 * into the browser payload, so it carries no org id and no canary-org id; the one id in it is each
 * pilot user's Keepr user id, which the page shows and links (founder ruling 2026-11-11).
 */

export interface KN {
  k: number;
  n: number;
}

export interface AdminListRow {
  org_id: string;
  org_name: string | null;
  user_id: string;
  user_name: string | null;
  sender_rules_version: number;
  version_released: boolean | null;
  version_bundled: boolean | null;
  version_was_canary_for_this_org: boolean;
  org_current_pin_version: number | null;
  org_current_pin_at: string | null;
  report: Record<string, unknown>;
  app_version: string | null;
  submitted_at: string;
}

export type AdminListResult =
  | { ok: true; rows: AdminListRow[]; truncated: boolean }
  | { ok: false; message: string };

/** How a version stood when the row was read, from the row's own version_* fields. */
export type VersionMark = 'released' | 'test-this-org' | 'test-other-org' | 'unknown';

export interface VersionColumn {
  version: number;
  submittedAt: string;
  appVersion: string | null;
  mark: VersionMark;
  /** The version shipped inside the app (only meaningful when released). */
  bundled: boolean;
}

export type Cell = { kind: 'kn'; k: number; n: number } | { kind: 'count'; value: number } | null;

/** The difference from the column to the left (the next lower version this user has). */
export type Change = { kind: 'kn'; dk: number; dn: number } | { kind: 'count'; d: number } | null;

export interface MetricRow {
  /** Stable key within a user table. */
  id: string;
  /** Section heading the row sits under. */
  section: string;
  label: string;
  /** One per column, same order as `columns`. */
  cells: Cell[];
  /** One per column; the first is always null. */
  changes: Change[];
}

export interface UserGroup {
  /** Keepr user id: shown, and linked to /dashboard/users/<id>. */
  userId: string;
  userName: string | null;
  columns: VersionColumn[];
  rows: MetricRow[];
}

export interface OrgGroup {
  name: string;
  /** The org's current test pin, or null when it is on the released rules. */
  pin: { version: number; since: string | null } | null;
  users: UserGroup[];
}

export type PilotViewModel =
  | { ok: true; truncated: boolean; orgs: OrgGroup[] }
  | { ok: false; message: string };
