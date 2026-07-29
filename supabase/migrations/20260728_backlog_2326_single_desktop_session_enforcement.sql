-- BACKLOG-2326 / PR #2122 — Option B: single desktop session enforcement (spare companion)
--
-- Goal: when a user completes a broker DESKTOP login, revoke the user's OTHER desktop
-- sessions while SPARING the Android companion (phone) session and the broker web sessions.
--
-- Why a tracking table (not user_agent heuristics): GoTrue overwrites auth.sessions.user_agent
-- on token refresh, so a refreshed desktop-app (Electron) session drifts its UA to `node` and
-- is indistinguishable from a broker-portal web session (also `node`), and a refreshed companion
-- shows `okhttp`. UA cannot separate desktop / web / companion after refresh. This migration
-- positively identifies desktop-app logins by recording their auth.sessions.id at login time.
--
-- Mechanism: deleting an auth.sessions row cascades to auth.refresh_tokens
-- (refresh_tokens_session_id_fkey ... ON DELETE CASCADE) => that IS the per-session revoke.
--
-- SECURITY (SR merge-gating conditions, see BACKLOG-2326 SR plan review):
--   * All functions are SECURITY DEFINER with `SET search_path = ''` and fully schema-qualified
--     objects (SECURITY DEFINER search_path-hijack hardening; Supabase advisor requirement).
--   * EXECUTE is REVOKED from PUBLIC and GRANTED only to service_role (these delete/read
--     auth.sessions and take a user_id argument — must never be reachable by anon/authenticated).
--   * revoke_desktop_sessions is scoped to a single user_id, takes an explicit id allowlist,
--     and carries a HARD companion/mobile-UA backstop so a companion session can never be
--     deleted even if it were somehow mis-tracked.
--
-- NOT APPLIED by the engineer. Deploy step (PM/founder): apply on a Supabase BRANCH/PREVIEW
-- first and prove the revoke cascade + companion-UA survival before prod (CLAUDE.md
-- "observe the outcome", BACKLOG-1875). This cannot be exercised in CI.

-- ---------------------------------------------------------------------------
-- Tracking table: which auth.sessions rows are desktop-app logins.
-- RLS is enabled with NO policies on purpose: only service_role (which bypasses RLS) may
-- read/write it. anon/authenticated are fully denied. Do NOT add a policy "to fix the
-- advisor RLS-enabled-no-policy info flag" — the closed state is intended.
-- The FK to auth.sessions(id) ON DELETE CASCADE auto-GCs a tracking row when GoTrue deletes
-- the session (expiry / logout / this feature's own revoke).
-- ---------------------------------------------------------------------------
create table if not exists public.desktop_login_sessions (
  session_id uuid primary key references auth.sessions (id) on delete cascade,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists desktop_login_sessions_user_id_idx
  on public.desktop_login_sessions (user_id);

alter table public.desktop_login_sessions enable row level security;
revoke all on table public.desktop_login_sessions from anon, authenticated;

comment on table public.desktop_login_sessions is
  'BACKLOG-2326: auth.sessions ids that are broker desktop-app logins. RLS enabled with no policy by design (service_role only). Used to revoke a user''s OTHER desktop sessions on new desktop login while sparing the companion and web sessions.';

-- ---------------------------------------------------------------------------
-- track_desktop_session: record the current desktop login (idempotent). Called LAST in the
-- enforcement flow (LIST -> REVOKE -> TRACK) so the just-created session can never appear in
-- its own "other sessions" set.
-- ---------------------------------------------------------------------------
create or replace function public.track_desktop_session(p_user_id uuid, p_session_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.desktop_login_sessions (session_id, user_id)
  values (p_session_id, p_user_id)
  on conflict (session_id) do nothing;
$$;

-- ---------------------------------------------------------------------------
-- list_other_desktop_sessions: the user's tracked desktop sessions that still exist in
-- auth.sessions, EXCLUDING the current one, annotated with user_agent so the caller (TS) can
-- apply the companion backstop and the revoke selection in testable code.
-- NULL-safe current filter: when p_current_session_id is NULL (JWT decode failed) IS DISTINCT
-- FROM keeps all rows — safe because TRACK runs last, so the current session is not yet tracked.
-- ---------------------------------------------------------------------------
create or replace function public.list_other_desktop_sessions(
  p_user_id uuid,
  p_current_session_id uuid
)
returns table (session_id uuid, user_agent text)
language sql
security definer
set search_path = ''
as $$
  select d.session_id, s.user_agent
  from public.desktop_login_sessions d
  join auth.sessions s on s.id = d.session_id
  where d.user_id = p_user_id
    and d.session_id is distinct from p_current_session_id;
$$;

-- ---------------------------------------------------------------------------
-- revoke_desktop_sessions: delete the given auth.sessions rows (cascades to refresh_tokens =>
-- revokes the session). Scoped to p_user_id and an explicit id allowlist.
-- HARD backstop: never delete a session whose user_agent marks it a companion/mobile client,
-- regardless of the ids passed. FAIL-SAFE NULL handling: a NULL user_agent makes the `!~*`
-- test NULL, so the row is EXCLUDED from deletion (we never delete a session we cannot
-- classify). Do NOT wrap user_agent in COALESCE(...,'') — that would start deleting null-UA rows.
-- Returns the number of sessions actually revoked. Tracking rows auto-GC via the FK cascade.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_desktop_sessions(
  p_user_id uuid,
  p_session_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_session_ids is null or array_length(p_session_ids, 1) is null then
    return 0;
  end if;

  with del as (
    delete from auth.sessions s
    where s.user_id = p_user_id
      and s.id = any (p_session_ids)
      and s.user_agent !~* '(android|iphone|ipad|ipod|mobile|okhttp|keepr[-_ ]?companion)'
    returning s.id
  )
  select count(*) into v_deleted from del;

  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (SR BLOCKING-2): Postgres grants EXECUTE to PUBLIC by default on CREATE FUNCTION.
-- These functions delete/read auth.sessions and take a user_id argument, so PUBLIC access would
-- be a privilege-escalation / forced-logout vector. Lock every function to service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.track_desktop_session(uuid, uuid) from public;
revoke all on function public.list_other_desktop_sessions(uuid, uuid) from public;
revoke all on function public.revoke_desktop_sessions(uuid, uuid[]) from public;

grant execute on function public.track_desktop_session(uuid, uuid) to service_role;
grant execute on function public.list_other_desktop_sessions(uuid, uuid) to service_role;
grant execute on function public.revoke_desktop_sessions(uuid, uuid[]) to service_role;
