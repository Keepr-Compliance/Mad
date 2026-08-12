-- GIT<->PROD PARITY MIRROR: this file mirrors the migration applied to PROD
-- (supabase_migrations.schema_migrations version 20260803150425) via MCP
-- apply_migration on 2026-08-03. DO NOT re-apply -- the database already has it.
--
-- BACKLOG-2436: support_list_events returned a ticket's entire event history to
--               any authenticated caller holding a ticket id.
-- BACKLOG-2437: support_delete_template was a bare DELETE with no caller check.
-- BACKLOG-2393: section 8's REVOKE did not do what it reads as (see part 3).
--
-- Both functions are SECURITY DEFINER, which bypasses row-level security, and
-- neither re-implemented the rule the underlying table already enforces. This
-- is the same defect class closed on the attachment RPCs in BACKLOG-2412
-- (20260803105306); the shape below is copied from that migration rather than
-- reinvented, so all of these paths stay on one rule.
--
-- Additive/restrictive only. No table, policy or function is dropped, and the
-- storage.objects policies are NOT touched -- they are correct.

-- ----------------------------------------------------------------------------
-- 1. support_list_events (BACKLOG-2436) -- gate on requester-or-internal.
--
-- THE RULE, identical to BACKLOG-2412: the ticket requester and internal staff,
-- nobody else.
--
-- support_is_ticket_requester(...) is reused rather than restated, and
-- deliberately in preference to `auth.jwt() ->> 'email'`: the helper resolves
-- the address through auth.users exactly as this table's own SELECT policy and
-- the storage.objects policies do. A JWT can carry a stale email after an
-- address change; auth.users cannot disagree with the table. The helper's match
-- is case-sensitive, which can only ever deny, never over-grant.
--
-- On refusal this returns an EMPTY LIST, not an error. An error distinguishes
-- "this ticket exists but is not yours" from "no such ticket", which leaks
-- existence to anyone who obtained an id.
--
-- NO INNER ROW FILTER -- and that is deliberate, not an omission.
-- support_list_attachments needed one because support_ticket_attachments has an
-- internal-notes distinction in its RLS. support_ticket_events does NOT: its
-- policy support_ticket_events_select_public reduces to a flat
-- `internal OR requester` (the second branch's `AND NOT internal` is
-- redundant), so every row on a ticket is visible to that ticket's requester
-- today. Mirroring the table's own policy therefore means the outer gate IS the
-- whole rule. Adding a filter here would invent a second, stricter rule that
-- the table does not have -- the same drift this migration exists to end.
--
-- Return shape is unchanged: same keys, same created_at DESC ordering.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_list_events(p_ticket_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_is_internal boolean;
BEGIN
  v_caller := auth.uid();

  -- Unauthenticated: nothing to authorize against.
  IF v_caller IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  v_is_internal := EXISTS (
    SELECT 1 FROM internal_roles ir WHERE ir.user_id = v_caller
  );

  -- Neither the requester nor internal staff: empty, not an error.
  IF NOT (v_is_internal OR support_is_ticket_requester(p_ticket_id::text)) THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN COALESCE(
    (SELECT jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'ticket_id', e.ticket_id,
        'actor_id', e.actor_id,
        'event_type', e.event_type,
        'old_value', e.old_value,
        'new_value', e.new_value,
        'metadata', e.metadata,
        'created_at', e.created_at
      ) ORDER BY e.created_at DESC
    )
    FROM support_ticket_events e
    WHERE e.ticket_id = p_ticket_id),
    '[]'::jsonb
  );
END;
$function$;

-- ----------------------------------------------------------------------------
-- 2. support_delete_template (BACKLOG-2437) -- internal roles only, loudly.
--
-- Internal-only is the correct shape HERE, and the distinction matters:
-- BACKLOG-1955 (20260711072135) applied this same guard to four functions and
-- was reverted the same day (20260711072207) for exactly one of them,
-- support_add_attachment, BECAUSE THAT ONE IS CUSTOMER-FACING -- customers
-- attach files to their own tickets and are not in internal_roles.
--
-- Response templates have no customer path at all: they are agent tooling,
-- written by support staff into the reply composer. The reverted case does not
-- apply, and the guard below is copied verbatim from the sibling BACKLOG-1955
-- did guard correctly, support_create_template, so create and delete cannot
-- drift apart again.
--
-- Failing loudly is correct: a delete that is silently ignored leaves the
-- caller believing shared internal state was removed when it was not.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_delete_template(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  -- AUTH GUARD: must be authenticated and exist in internal_roles (BACKLOG-2437,
  -- mirroring the support_create_template guard added by BACKLOG-1955).
  IF v_caller_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM internal_roles WHERE user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'Only authenticated agents can delete templates' USING ERRCODE = '42501';
  END IF;

  DELETE FROM support_response_templates WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'deleted', true);
END;
$function$;

-- ----------------------------------------------------------------------------
-- 3. Grant corrections -- the implicit-PUBLIC-grant trap (BACKLOG-2393).
--
-- Postgres attaches an implicit `GRANT EXECUTE ... TO PUBLIC` to every newly
-- created function. anon and authenticated are both members of PUBLIC and
-- inherit it. A `REVOKE ... FROM authenticated, anon` therefore removes nothing
-- unless those roles were granted EXECUTE *directly* -- the implicit PUBLIC
-- grant survives it and the function stays callable. The statement reads as a
-- lockdown and is a no-op.
--
-- 20260802_backlog_2393_support_access_retention.sql section 8 has exactly that
-- form for support_purge_expired_attachments, a destructive purge intended for
-- a scheduled service_role job only. PROD was corrected by hand on 2026-08-03
-- (verified: acl is now postgres=X, service_role=X), so the first statement
-- below is a no-op there. It is carried here anyway because editing the 2393
-- FILE cannot help any environment that already recorded that version -- an
-- applied migration never replays. The file is corrected too, for environments
-- rebuilt from scratch.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.support_purge_expired_attachments() FROM PUBLIC;

-- The internal-only ticket mutators below each carry a has_internal_role check
-- that raises, so the inherited PUBLIC grant was never exploitable -- these are
-- tidied, not fixed. Each already holds an explicit `authenticated` grant, so
-- revoking PUBLIC removes only the inherited anon path and cannot affect the
-- broker portal, which calls them as authenticated internal users.
REVOKE EXECUTE ON FUNCTION public.support_assign_ticket(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.support_update_ticket_category(UUID, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.support_update_ticket_priority(UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.support_update_ticket_status(UUID, TEXT, TEXT) FROM PUBLIC;

-- support_delete_template is agent tooling with no customer path, so anon has
-- no business holding EXECUTE. It carries an explicit `authenticated` grant,
-- which internal staff use and which is preserved; the body guard above remains
-- the actual authorization boundary.
REVOKE EXECUTE ON FUNCTION public.support_delete_template(uuid) FROM PUBLIC, anon;

-- support_list_events keeps its existing grants unchanged. It is customer-facing
-- -- requesters read their own ticket history -- and the body gate is the
-- boundary. An anonymous caller now receives an empty list rather than a
-- ticket's history.

-- ============================================================================
-- ROLLBACK (restores the pre-migration behaviour, holes included -- for
-- reference only; do not run without re-opening BACKLOG-2436/2437)
-- ============================================================================
-- The prior bodies had no caller check at all. Recreate from git history at
-- 20260803105306 if a revert is ever genuinely required.
