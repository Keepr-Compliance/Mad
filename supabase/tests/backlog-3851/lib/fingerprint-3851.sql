-- BACKLOG-3851 fingerprint of every production object M1/M2 replace, read or depend on.
-- Read-only. Runs unchanged against production (Supabase MCP execute_sql, as postgres) and
-- inside the harness venue; pins-3851.sql compares the venue to the production read.
-- One row per object: k = object, v = md5 of its definition (+ ACL for functions).
WITH fns AS (
  SELECT 'fn ' || p.oid::regprocedure::text AS k,
         md5(pg_get_functiondef(p.oid) || '|' || coalesce(p.proacl::text, '')) AS v
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN (
     'get_org_features','check_feature_access','guard_invite_acceptance','auto_provision_it_admin',
     'admin_invite_user','claim_pending_invite','member_status_grants_access','jit_join_organization',
     'auto_provision_google_it_admin','_ensure_personal_organization_for','_retire_personal_membership',
     'ensure_personal_organization','update_updated_at_column','guard_organization_client_update',
     '_guard_personal_owner_user_id','broker_get_org_features',
     -- new in 3851 (must be absent before M1)
     'member_status_holds_seat','member_status_is_deactivated','member_origin_is_idp','member_row_holds_seat',
     '_enforce_member_seat_limit','set_member_license','_revert_deactivated_member_to_paygo')
), cons AS (
  SELECT 'con ' || c.conname, md5(pg_get_constraintdef(c.oid))
    FROM pg_constraint c WHERE c.conrelid = 'public.organization_members'::regclass
), trg AS (
  SELECT 'trg ' || cl.relname || '.' || t.tgname, md5(pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text)
    FROM pg_trigger t JOIN pg_class cl ON cl.oid = t.tgrelid
   WHERE t.tgrelid IN ('public.organization_members'::regclass, 'public.organizations'::regclass) AND NOT t.tgisinternal
), cols AS (
  SELECT 'cols ' || table_name,
         md5(string_agg(column_name || ':' || data_type || ':' || coalesce(column_default, '') || ':' || is_nullable, '|' ORDER BY column_name))
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name IN ('organization_members', 'organizations')
   GROUP BY table_name
)
SELECT k, v FROM fns UNION ALL SELECT * FROM cons UNION ALL SELECT * FROM trg UNION ALL SELECT * FROM cols
ORDER BY 1;
