-- GIT<->PROD PARITY MIRROR: this file mirrors the migration already applied to PROD
-- (supabase_migrations.schema_migrations version 20260711071820) via MCP apply_migration
-- on 2026-07-11. DO NOT re-apply — the database already has it. Refs BACKLOG-1953 / BACKLOG-1954.
-- Security hardening (BACKLOG-1953 / BACKLOG-1954):
-- Remove anon/PUBLIC/authenticated EXECUTE on two SECURITY DEFINER functions that lack body guards.
--  * create_token_claim: restore intended service_role-only (unauth session-fixation vector).
--  * jit_join_organization: interim mitigation for cross-org escalation via unbounded p_tenant_id
--    (legit caller uses a different, currently-broken signature; full tenant-binding rewrite tracked in BACKLOG-1954).
REVOKE EXECUTE ON FUNCTION public.create_token_claim(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.jit_join_organization(text) FROM PUBLIC, anon, authenticated;
