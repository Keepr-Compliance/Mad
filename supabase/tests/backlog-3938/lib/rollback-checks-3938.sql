-- Rollback fingerprints, used by run.sh rollback. Production values read 2026-10-14
-- (same values as lib/pins-3938.sql).
CREATE FUNCTION pg_temp.fn_now() RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(p.oid::regprocedure::text || '=' || md5(pg_get_functiondef(p.oid)) || '/' || p.proacl::text, ';' ORDER BY 1)
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('get_user_org_ids','is_org_admin','broker_get_org_features') $f$;
CREATE FUNCTION pg_temp.links_now() RETURNS text LANGUAGE sql AS $f$
  SELECT string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || md5(coalesce(qual,'') || '|' || coalesce(with_check,'')), ';' ORDER BY 1)
    FROM pg_policies WHERE tablename = 'support_ticket_backlog_links' $f$;
CREATE FUNCTION pg_temp.fn_prod() RETURNS text LANGUAGE sql AS $f$
  SELECT 'broker_get_org_features(uuid)=b61e499f7c1c0ed83f551c0cc46707a0/{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres};'
      || 'get_user_org_ids(uuid)=46e19a432fe087843e6442f6da7e0e36/{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres};'
      || 'is_org_admin(uuid,uuid)=325f08f47d5266c3dceb85ca39ab1dba/{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' $f$;
CREATE FUNCTION pg_temp.links_prod() RETURNS text LANGUAGE sql AS $f$
  SELECT 'Admins can manage links|ALL|{public}|84ac569390eb4ead7da1723cd89a0467;'
      || 'Authenticated users can read links|SELECT|{public}|97caa439c76824f55cc97930a41fb789' $f$;
