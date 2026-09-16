-- BACKLOG-3364: remove every row postgrest/seed.sql or the probe itself wrote.
-- Deleting the auth users removes their licenses and (after migration 1) their
-- personal organizations by cascade; the brokerage and the plans go explicitly.

BEGIN;

DELETE FROM public.organizations
 WHERE id = '00000000-0000-4000-8000-00003364e0a0'; -- pii-allow-uuid: invented fixture id

DO $cleanup$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.organizations'::regclass
             AND attname = 'personal_owner_user_id' AND NOT attisdropped) THEN
    EXECUTE $q$DELETE FROM public.organizations WHERE personal_owner_user_id IN ('00000000-0000-4000-8000-00003364e001', '00000000-0000-4000-8000-00003364e002')$q$; -- pii-allow-uuid: invented fixture ids
  END IF;
END
$cleanup$;

DELETE FROM public.users
 WHERE id IN ('00000000-0000-4000-8000-00003364e001', '00000000-0000-4000-8000-00003364e002'); -- pii-allow-uuid: invented fixture ids
DELETE FROM auth.users
 WHERE id IN ('00000000-0000-4000-8000-00003364e001', '00000000-0000-4000-8000-00003364e002'); -- pii-allow-uuid: invented fixture ids
DELETE FROM public.plans
 WHERE id IN ('00000000-0000-4000-8000-00003364e110', '00000000-0000-4000-8000-00003364e120'); -- pii-allow-uuid: invented fixture ids

SELECT 'probe rows left: ' ||
       (SELECT count(*) FROM auth.users WHERE email LIKE '%@fixture-3364.example.test') + -- probe users
       (SELECT count(*) FROM public.organizations WHERE slug LIKE 'fixture-3364-%' OR slug LIKE 'personal-00000000000040008000000033640%') +
       (SELECT count(*) FROM public.plans WHERE description = 'fixture-3364-probe') AS remaining;

COMMIT;
