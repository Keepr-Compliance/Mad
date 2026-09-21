-- BACKLOG-3473: remove every row postgrest/seed.sql wrote. Templates and items
-- go with their organizations (ON DELETE CASCADE); memberships and plan rows
-- are removed explicitly first.

BEGIN;

DELETE FROM public.organization_members
 WHERE organization_id IN ('00000000-0000-4000-8000-00003473e5a1', '00000000-0000-4000-8000-00003473e5a2'); -- pii-allow-uuid: invented fixture ids
DELETE FROM public.organization_plans
 WHERE organization_id IN ('00000000-0000-4000-8000-00003473e5a1', '00000000-0000-4000-8000-00003473e5a2'); -- pii-allow-uuid: invented fixture ids
DELETE FROM public.organizations
 WHERE id IN ('00000000-0000-4000-8000-00003473e5a1', '00000000-0000-4000-8000-00003473e5a2'); -- pii-allow-uuid: invented fixture ids
DELETE FROM public.users
 WHERE id IN ('00000000-0000-4000-8000-00003473e501', '00000000-0000-4000-8000-00003473e502'); -- pii-allow-uuid: invented fixture ids
DELETE FROM auth.users
 WHERE id IN ('00000000-0000-4000-8000-00003473e501', '00000000-0000-4000-8000-00003473e502'); -- pii-allow-uuid: invented fixture ids

SELECT 'probe rows left: ' ||
       ((SELECT count(*) FROM auth.users WHERE email LIKE '%@fixture-3473.example.test') +
        (SELECT count(*) FROM public.organizations WHERE slug LIKE 'fixture-3473-%') +
        (SELECT count(*) FROM public.checklist_templates)) AS remaining;

COMMIT;
