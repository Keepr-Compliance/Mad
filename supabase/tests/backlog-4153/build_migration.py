#!/usr/bin/env python3
"""BACKLOG-4153: write the migration and the rollback from the 3853 body of unlock_transaction.

The 3853 body (md5(prosrc) c044fab7...) is copied byte-for-byte; the guard is inserted once,
after the "already unlocked" return and before the first credit_ledger read. The new md5 is
computed from the exact text between the $function$ markers and written into both files.
Usage: build_migration.py   (writes both files; prints the new md5)
"""
import hashlib, os
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..', '..')
src = open(os.path.join(root, 'migrations', '20261018230000_backlog_3853_brokerage_suspension_gates.sql')).read()
HEAD = 'CREATE OR REPLACE FUNCTION public.unlock_transaction(p_local_transaction_id text)'
i = src.index(HEAD)
a = src.index('AS $function$', i) + len('AS $function$')
b = src.index('$function$', a)
header = src[i:a]
old_body = src[a:b]
OLD = 'c044fab7e359a66ab472d61d69037f87'
assert hashlib.md5(old_body.encode()).hexdigest() == OLD

ANCHOR = '''  -- CR1: grant net-capacity includes ALL adjustment rows (negatives reduce it), clamped at 0.
'''
assert old_body.count(ANCHOR) == 1
GUARD = '''  -- BACKLOG-4153 guard begin: no credit unlock for a brokerage member whose license is
  -- unassigned, unless another brokerage grants them access. Personal organizations never count.
  IF EXISTS (SELECT 1
               FROM public.organization_members m
               JOIN public.organizations o ON o.id = m.organization_id
              WHERE m.user_id = v_uid
                AND o.personal_owner_user_id IS NULL
                AND m.license_status = 'unassigned')
     AND NOT EXISTS (SELECT 1
               FROM public.organization_members m2
               JOIN public.organizations o2 ON o2.id = m2.organization_id
              WHERE m2.user_id = v_uid
                AND o2.personal_owner_user_id IS NULL
                AND public.member_status_grants_access(m2.license_status)) THEN
    RAISE EXCEPTION 'not_licensed'
      USING ERRCODE = 'P0001', HINT = 'Your brokerage hasn''t assigned you a license. Contact your admin.';
  END IF;
  -- BACKLOG-4153 guard end

'''
new_body = old_body.replace(ANCHOR, GUARD + ANCHOR)
NEW = hashlib.md5(new_body.encode()).hexdigest()
ACL = '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'

mig = f'''-- BACKLOG-4153: unlock_transaction refuses a credit unlock ('not_licensed') when the caller's
-- brokerage membership is 'unassigned' and no brokerage grants them access.
--
-- Rule (checked after the per-user advisory lock and the "already unlocked" return, before any
-- credit_ledger read or write, so a refused call spends nothing and a deal unlocked earlier still
-- returns already=true):
--   refuse when the caller has a brokerage row (organizations.personal_owner_user_id IS NULL)
--   with license_status 'unassigned' AND no brokerage row where member_status_grants_access()
--   is true ('active').
--   - unassigned at one brokerage + active at another: allowed.
--   - personal organizations never count, on either side.
--   - suspended / expired rows alone: allowed (no unassigned row). A deactivated row at one
--     brokerage + unassigned at another: refused (founder recommendation; control (i)).
--   - NULL and claimed 'pending' rows match neither side and are allowed through.
-- The client contract is the MESSAGE 'not_licensed' (entitlementService.ts returns error.message;
-- ExportUnlockPrompt maps it to the no-license sentence).
--
-- Body: the 3853 body (20261018230000, md5(prosrc) {OLD}) plus the guard; same signature,
-- SECURITY DEFINER, search_path public.
-- ACL: left as is. CREATE OR REPLACE keeps it; this file writes no GRANT and no REVOKE. The
-- PUBLIC/anon EXECUTE grant predates this change and is owned by BACKLOG-2177. The post-check
-- below asserts the ACL is unchanged.
-- Pre-check: md5(prosrc) must be {OLD} (the 3853 body) or {NEW} (this body: a re-run is a
-- no-op that still runs the post-check).
-- Rollback: supabase/tests/backlog-4153/rollback-4153.sql. No transaction control in this file.

DO $pre$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.unlock_transaction(text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('{OLD}', '{NEW}') THEN
    RAISE EXCEPTION '4153 pre-check: public.unlock_transaction(text) differs from the expected body (md5(prosrc) %)', v_md5;
  END IF;
  IF to_regprocedure('public.member_status_grants_access(text)') IS NULL THEN
    RAISE EXCEPTION '4153 pre-check: public.member_status_grants_access(text) is missing';
  END IF;
END $pre$;

{header}{new_body}$function$;

DO $post$
DECLARE v_md5 text; v_acl text;
BEGIN
  SELECT md5(prosrc), proacl::text INTO v_md5, v_acl FROM pg_proc WHERE oid = to_regprocedure('public.unlock_transaction(text)');
  IF v_md5 IS DISTINCT FROM '{NEW}' THEN
    RAISE EXCEPTION '4153 post-check: md5(prosrc) is %, expected {NEW}', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{ACL}' THEN
    RAISE EXCEPTION '4153 post-check: ACL changed to %', v_acl;
  END IF;
END $post$;
'''
open(os.path.join(root, 'migrations', '20261106120000_backlog_4153_unlock_unassigned_guard.sql'), 'w').write(mig)

rb = f'''-- BACKLOG-4153 rollback: restores the 3853 body of unlock_transaction (md5(prosrc) {OLD}).
-- Pre-check: md5(prosrc) must be {NEW} (the 4153 body) or {OLD} (already rolled back: no-op).
-- ACL left as is (CREATE OR REPLACE keeps it); the post-check asserts it is unchanged.
-- Run as one transaction. Also remove the ledger row 20261106120000 by hand if the venue keeps one.

DO $pre$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure('public.unlock_transaction(text)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('{NEW}', '{OLD}') THEN
    RAISE EXCEPTION '4153 rollback refused: public.unlock_transaction(text) md5(prosrc) % is neither the 4153 nor the 3853 body', v_md5;
  END IF;
END $pre$;

{header}{old_body}$function$;

DO $post$
DECLARE v_md5 text; v_acl text;
BEGIN
  SELECT md5(prosrc), proacl::text INTO v_md5, v_acl FROM pg_proc WHERE oid = to_regprocedure('public.unlock_transaction(text)');
  IF v_md5 IS DISTINCT FROM '{OLD}' THEN
    RAISE EXCEPTION '4153 rollback post-check: md5(prosrc) is %, expected {OLD}', v_md5;
  END IF;
  IF v_acl IS DISTINCT FROM '{ACL}' THEN
    RAISE EXCEPTION '4153 rollback post-check: ACL changed to %', v_acl;
  END IF;
END $post$;
'''
open(os.path.join(here, 'rollback-4153.sql'), 'w').write(rb)
open(os.path.join(here, 'guard.txt'), 'w').write(GUARD)
print('old', OLD, 'new', NEW)
