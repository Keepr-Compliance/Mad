-- BACKLOG-3549: remove TRUNCATE from anon and authenticated on schema public.
--
-- 1. Revokes TRUNCATE on every existing table and view in schema public from
--    anon and authenticated. service_role and postgres are not touched.
-- 2. Changes the default privileges of role postgres in schema public so that
--    tables it creates later are not granted TRUNCATE for anon and
--    authenticated. All other default privileges are unchanged.
--
-- SELECT, INSERT, UPDATE, DELETE, REFERENCES and TRIGGER grants are unchanged.

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;
