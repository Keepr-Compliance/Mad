#!/usr/bin/env python3
"""BACKLOG-4007 People v2 rollback (keepr-test only). Usage: rollback.py <out.sql> [--dry]
Composes: drop this file's triggers / functions / table, put org_contacts' columns back (EMPTY:
names, emails and phones are not restorable), member_id nullable with ON DELETE SET NULL, then
re-run the PR-4 function bodies (20261020180000 minus its pre-check) and PR-1's
admin_get_org_billing / broker_get_billing_setup. --dry ends in RAISE so nothing persists."""
import os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = lambda n: open(os.path.join(here, '..', '..', 'migrations', n)).read()
pr4 = mig('20261020180000_backlog_4007_pr4_contacts_billing_login.sql')
pr4 = pr4[pr4.index('END $pre$;') + len('END $pre$;'):]
pr1 = mig('20261020100000_backlog_4007_onboarding_billing_setup.sql')
def fn(src, name):
    i = src.index(f'CREATE OR REPLACE FUNCTION public.{name}(')
    j = src.index('TO authenticated, service_role;', i) + len('TO authenticated, service_role;')
    return src[i:j]
head = """
DROP TRIGGER IF EXISTS user_phones_claim_pending ON public.organization_members;
DROP TRIGGER IF EXISTS org_billing_login_orphan_rekey ON public.organization_members;
DROP TRIGGER IF EXISTS org_billing_contact_member_delete_guard ON public.organization_members;
DROP TRIGGER IF EXISTS org_billing_contact_on_deprovision ON public.organization_members;
DROP TRIGGER IF EXISTS _guard_it_admin_grant_ins ON public.organization_members;
DROP TRIGGER IF EXISTS _guard_it_admin_grant_upd ON public.organization_members;
DROP FUNCTION IF EXISTS public._user_phones_claim_pending(), public._org_billing_login_orphan_rekey(),
  public._org_billing_contact_member_delete_guard(), public._org_billing_contact_on_deprovision(),
  public._guard_it_admin_grant(), public._org_billing_contact_reassign(uuid, uuid, text),
  public.org_people_invite(uuid, jsonb), public._org_people_invite_row(uuid, text, text, text, text, uuid),
  public._org_billing_login_refusal(uuid, text), public.org_member_phone_set(uuid, uuid, text),
  public.my_phone_get(), public.my_phone_set(text), public._org_billing_contact_phone(uuid),
  public._org_billing_contact_link(uuid, uuid, text, uuid, boolean), public._org_account_admin_member(uuid, uuid),
  public._member_role_idp_managed(uuid), public._member_phone_put(uuid, text, uuid), public._member_person(uuid),
  public._member_phone(uuid), public._can_read_person_phone(uuid, uuid), public._org_people_caller(uuid, boolean);
DROP TABLE IF EXISTS public.user_phones;
DROP INDEX IF EXISTS public.org_contacts_one_person_per_slot_idx;
DROP INDEX IF EXISTS public.org_contacts_one_it_idx;
DROP INDEX IF EXISTS public.org_contacts_member_idx;
ALTER TABLE public.org_contacts DROP CONSTRAINT IF EXISTS org_contacts_member_id_fkey;
ALTER TABLE public.org_contacts ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE public.org_contacts ADD CONSTRAINT org_contacts_member_id_fkey FOREIGN KEY (member_id)
  REFERENCES public.organization_members(id) ON DELETE SET NULL;
ALTER TABLE public.org_contacts ADD COLUMN IF NOT EXISTS full_name text, ADD COLUMN IF NOT EXISTS email text, ADD COLUMN IF NOT EXISTS phone text;
UPDATE public.org_contacts c SET full_name = coalesce(nullif(btrim(u.display_name), ''), u.email, m.invited_email, 'Unknown'),
  email = lower(coalesce(u.email, m.invited_email, 'unknown@example.invalid'))
  FROM public.organization_members m LEFT JOIN public.users u ON u.id = m.user_id WHERE m.id = c.member_id;
"""
text = head + pr4 + '\n' + fn(pr1, 'admin_get_org_billing') + '\n' + fn(pr1, 'broker_get_billing_setup') + "\nDELETE FROM supabase_migrations.schema_migrations WHERE version = '20261020200000';\n"
if '--dry' in sys.argv:
    text += "\nDO $$ BEGIN RAISE EXCEPTION 'ROLLBACK_DRYRUN_OK'; END $$;\n"
open(sys.argv[1], 'w').write(text)
print(sys.argv[1], len(text))
