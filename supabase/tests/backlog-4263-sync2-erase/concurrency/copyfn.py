#!/usr/bin/env python3
"""Own-name copy of one E1 function for the erase two-session controls (BACKLOG-4263). No database.

usage: copyfn.py <E1 migration> <function> <signature> <case> <mutant name or ''>
Prints, on stdout, one call that CREATEs public.<function>_m4263 (never CREATE OR REPLACE, never the live name) from
the E1 text with at most one exact-string change, then REVOKEs it from every API role (the sessions call it as the
owner). On stderr: 'MUTATION APPLIED' with the change. Exits 1 (prints nothing on stdout) when the change does not match
exactly once or the copy would still name the live function.
"""
import sys

E1, NAME, SIG, CASE, MUT = sys.argv[1:6]
LOCK = '       FOR SHARE SKIP LOCKED;                                                                /*SCRUB:settings_lock*/'
CHANGES = {  # (case, mutant) -> (function, old, new); '' = the pristine instrumented copy
    ('attach', 'single_statement_fence'): ('cloud_blob_erase_claim',
        '      v_n_orphan := v_n_orphan + public._cloud_fence_unreferenced(r.owner, r.ids);          /*ORPHAN:fence*/',
        '      UPDATE public.cloud_blobs b SET purge_requested_at = now() WHERE b.id = ANY (r.ids) AND b.owner_user_id = r.owner'
        ' AND b.purge_requested_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id);'),
    ('c6g_skip', 'no_skip_locked'): ('cloud_blob_erase_scrub', LOCK, '       FOR SHARE;'),
    ('c6g_wait', ''): ('cloud_blob_erase_scrub', LOCK, '       FOR SHARE SKIP LOCKED;\n    PERFORM pg_sleep(4);'),
    ('c6g_wait', 'read_before_lock'): ('cloud_blob_erase_scrub', """  ELSE
    SELECT true, s.active_install_id INTO v_found, v_active
      FROM public.cloud_autosave_settings s WHERE s.user_id = p_owner
""" + LOCK, """  ELSE
    SELECT s.active_install_id INTO v_active FROM public.cloud_autosave_settings s WHERE s.user_id = p_owner;
    PERFORM pg_sleep(4);
    SELECT true INTO v_found
      FROM public.cloud_autosave_settings s WHERE s.user_id = p_owner
""" + LOCK),
}
if (CASE, MUT) not in CHANGES or CHANGES[(CASE, MUT)][0] != NAME:
    sys.exit(f'MUTATION NOT APPLIED: no change for {CASE} {MUT!r} on {NAME}')
_, old, new = CHANGES[(CASE, MUT)]
t = open(E1, encoding='utf-8').read()
head = f'CREATE OR REPLACE FUNCTION public.{NAME}('
if t.count(head) != 1:
    sys.exit(f'MUTATION NOT APPLIED: {head} found {t.count(head)} times')
i = t.index(head)
j = t.index('$f$;', t.index('AS $f$', i)) + 4
fn = t[i:j]
n = fn.count(old)
if n != 1:
    sys.exit(f'MUTATION NOT APPLIED: matched {n} times: {old[:100]!r}')
fn = fn.replace(old, new)
mine = f'{NAME}_m4263'
fn = f'CREATE FUNCTION public.{mine}(' + fn[len(head):]
if f'public.{NAME}(' in fn:
    sys.exit('MUTATION NOT APPLIED: the copy still names the live function')
sys.stderr.write('MUTATION APPLIED %s\n  - %s\n  + %s\n' % (mine, old.strip()[:140], new.strip()[:140]))
print("-- /*t:copy*/ own-name copy, committed; drop-copies.sql removes it\nSET LOCAL lock_timeout = '3s';")
print(fn)
print(f'REVOKE ALL ON FUNCTION public.{mine}({SIG}) FROM PUBLIC, anon, authenticated, service_role;')
