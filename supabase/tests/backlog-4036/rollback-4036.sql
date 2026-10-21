-- BACKLOG-4036 rollback (keepr-test or prod, with a go). Removes the activity triggers, the
-- reader and the two columns. The rows the triggers wrote stay (they are ordinary log rows).
DROP TRIGGER IF EXISTS org_member_change_log ON public.organization_members;
DROP TRIGGER IF EXISTS user_phone_change_log ON public.user_phones;
DROP FUNCTION IF EXISTS public.admin_get_org_activity(uuid, integer);
DROP FUNCTION IF EXISTS public._org_member_change_log();
DROP FUNCTION IF EXISTS public._user_phone_change_log();
DROP FUNCTION IF EXISTS public._activity_actor();
ALTER TABLE public.billing_change_log DROP COLUMN IF EXISTS txid, DROP COLUMN IF EXISTS source;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261021060000';
