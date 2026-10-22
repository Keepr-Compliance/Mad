-- Rollback for BACKLOG-3853 PR-2A (20261019030000_backlog_3853_admin_save_deal.sql).
-- Removes only what that file added. PR-1 objects and every saved deal stay as they are.
-- After running it, delete the ledger row: DELETE FROM supabase_migrations.schema_migrations
-- WHERE version = '20261019030000';

DROP FUNCTION IF EXISTS public.admin_get_org_billing(uuid);
DROP FUNCTION IF EXISTS public.admin_save_deal(uuid, text, integer, integer, text, text, uuid, text, integer);
DROP TABLE IF EXISTS public.billing_limits;

DO $post$
BEGIN
  IF to_regprocedure('public.admin_save_deal(uuid,text,integer,integer,text,text,uuid,text,integer)') IS NOT NULL
     OR to_regprocedure('public.admin_get_org_billing(uuid)') IS NOT NULL
     OR to_regclass('public.billing_limits') IS NOT NULL THEN
    RAISE EXCEPTION '3853 PR-2A rollback: an object is still present';
  END IF;
  IF md5(pg_get_functiondef(to_regprocedure('public._billing_save_deal(uuid,jsonb,uuid,text,integer)')))
     IS DISTINCT FROM '4471a965ddbfdde884108a891da73c01' THEN
    RAISE EXCEPTION '3853 PR-2A rollback: _billing_save_deal is not the PR-1 body';
  END IF;
END $post$;
