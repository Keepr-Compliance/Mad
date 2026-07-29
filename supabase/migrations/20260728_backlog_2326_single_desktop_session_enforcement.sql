-- BACKLOG-2326 / PR #2122 — Single active (non-companion) session enforcement.
--
-- Founder rule: on broker DESKTOP login, revoke the user's ENTIRE set of other sessions
-- (old sessions on this computer, other computers, other browsers, web) EXCEPT
--   (a) the current/new desktop session, and
--   (b) the Android companion (phone) session(s).
-- Net: only ONE non-companion session alive at a time; the phone is ALWAYS spared.
--
-- The crux is robustly SPARING the companion — a misidentification KICKS THE PHONE (the exact
-- bug being fixed). Companion sessions are identified by TWO independent signals; a session is
-- spared if EITHER says companion, and revoked only if NEITHER does:
--   1. PRIMARY — an explicit mark: the companion calls mark_companion_session() right after its
--      OAuth login, recording its OWN session id (derived from auth.jwt(), never a parameter).
--   2. BACKSTOP — user_agent matches android/okhttp/KeeprCompanion (covers the race window where
--      a companion has logged in but not finished marking yet, and legacy sessions).
--
-- Revoke primitive: deleting an auth.sessions row cascades to auth.refresh_tokens
-- (refresh_tokens_session_id_fkey ... ON DELETE CASCADE).
--
-- SECURITY (SR merge-gating): every function is SECURITY DEFINER, SET search_path = '', fully
-- schema-qualified. EXECUTE is REVOKED from PUBLIC. The two service-side functions
-- (list_user_sessions_with_companion_flag, revoke_sessions) are GRANTED to service_role only.
-- mark_companion_session is GRANTED to authenticated (the companion is not service-role) but can
-- ONLY ever record the CALLER'S OWN session (auth.uid() + auth.jwt()->>'session_id'); it takes
-- no parameters, so a caller cannot mark another user or session.
--
-- NOT APPLIED by the engineer. Deploy step (PM/founder): apply on a Supabase BRANCH/PREVIEW
-- first and prove the revoke spares both the current session and companion rows before prod
-- (CLAUDE.md "observe the outcome", BACKLOG-1875). This cannot be exercised in CI.

-- ---------------------------------------------------------------------------
-- companion_sessions: auth.sessions ids that belong to the Android companion. RLS enabled with
-- NO policies by design — only service_role (bypasses RLS) and the SECURITY DEFINER functions
-- below touch it. Do NOT add a policy "to fix the advisor RLS-enabled-no-policy info flag": the
-- closed state is intended. The FK to auth.sessions(id) ON DELETE CASCADE auto-GCs a row when
-- GoTrue deletes the session.
-- ---------------------------------------------------------------------------
create table if not exists public.companion_sessions (
  session_id uuid primary key references auth.sessions (id) on delete cascade,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);

create index if not exists companion_sessions_user_id_idx
  on public.companion_sessions (user_id);

alter table public.companion_sessions enable row level security;
revoke all on table public.companion_sessions from anon, authenticated;

comment on table public.companion_sessions is
  'BACKLOG-2326: auth.sessions ids marked as Android companion sessions (via mark_companion_session). Used to SPARE the phone when a desktop login revokes the user''s other sessions. RLS enabled, no policy by design.';

-- ---------------------------------------------------------------------------
-- mark_companion_session: the companion marks its OWN current session as a companion session.
-- Identity is derived ENTIRELY from the caller's verified JWT — no parameters — so a caller can
-- only ever mark the session it is currently authenticated with. Idempotent.
-- Granted to `authenticated` (the companion authenticates with a user JWT, not service_role).
-- ---------------------------------------------------------------------------
create or replace function public.mark_companion_session()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  -- Only a fully-authenticated session with a session_id can mark itself.
  if v_uid is null or v_sid is null then
    return;
  end if;

  insert into public.companion_sessions (session_id, user_id)
  values (v_sid, v_uid)
  on conflict (session_id) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- list_user_sessions_with_companion_flag: every live session for the user, annotated with
-- whether it has been explicitly marked as a companion session. The caller (TS) combines this
-- with the user_agent backstop to decide the spare/revoke set — keeping the security-critical
-- selection in unit-tested code.
-- ---------------------------------------------------------------------------
create or replace function public.list_user_sessions_with_companion_flag(p_user_id uuid)
returns table (session_id uuid, user_agent text, is_companion boolean)
language sql
security definer
set search_path = ''
as $$
  select
    s.id,
    s.user_agent,
    exists (
      select 1 from public.companion_sessions c where c.session_id = s.id
    ) as is_companion
  from auth.sessions s
  where s.user_id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- revoke_sessions: delete the given auth.sessions rows (cascades to refresh_tokens => revoke),
-- scoped to p_user_id and an explicit id allowlist. TWO hard SQL backstops guarantee the phone
-- is never kicked even if the caller's list were wrong:
--   * never delete a session marked in companion_sessions, and
--   * never delete a session whose user_agent looks like a companion/mobile client.
-- FAIL-SAFE NULL handling: a NULL user_agent makes `!~*` NULL, so the row is EXCLUDED from
-- deletion (we never delete a session we cannot classify). Do NOT wrap user_agent in
-- COALESCE(...,'') — that would start deleting null-UA rows. Returns the number revoked.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_sessions(
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
      and not exists (
        select 1 from public.companion_sessions c where c.session_id = s.id
      )
      and s.user_agent !~* '(android|iphone|ipad|ipod|mobile|okhttp|keepr[-_ ]?companion)'
    returning s.id
  )
  select count(*) into v_deleted from del;

  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges (SR BLOCKING-2): CREATE FUNCTION grants EXECUTE to PUBLIC by default. Lock each
-- function down. mark_companion_session is reachable by the authenticated companion; the two
-- service-side functions are service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.mark_companion_session() from public;
revoke all on function public.list_user_sessions_with_companion_flag(uuid) from public;
revoke all on function public.revoke_sessions(uuid, uuid[]) from public;

grant execute on function public.mark_companion_session() to authenticated;
grant execute on function public.list_user_sessions_with_companion_flag(uuid) to service_role;
grant execute on function public.revoke_sessions(uuid, uuid[]) to service_role;
