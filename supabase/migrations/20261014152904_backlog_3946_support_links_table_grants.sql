-- BACKLOG-3946 (C of 3): table privileges on support_ticket_backlog_links.
--
-- anon: no privileges. authenticated: SELECT, INSERT, DELETE only (the operations
-- admin-portal performs). Row-level security (support_ticket_backlog_links_internal_all)
-- is unchanged.
--
-- Apply as one transaction. No BEGIN/COMMIT here.
-- Rollback: supabase/tests/backlog-3946/rollback-C.sql

REVOKE ALL ON TABLE public.support_ticket_backlog_links FROM anon;
REVOKE UPDATE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.support_ticket_backlog_links FROM authenticated;
