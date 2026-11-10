#!/usr/bin/env python3
"""BACKLOG-4170 PR4 mutations. For each mode: exact-string replace on the migration and/or rollback FILE
(exits unless each fragment matches exactly the expected number of times), refresh the post-md5 pins in
the migration's $pin$ and $post$ and in the rollback's pre-pin so the second apply passes (a wrong author
would pin their own text), print MUTATION APPLIED + the changed lines, show `git diff --numstat`, run the
controls (one keepr-test transaction ending in RAISE, so nothing persists), assert a non-zero control
count, restore both files with `git checkout --`, and assert the tree is clean. Commit before running this:
the restore is a checkout.

Usage: mutate.py <mode>[,<mode>...]   (or: mutate.py all)
Run it while keepr-test holds the pre-PR4 bodies: the call starts with the rollback file, whose pre-pin
is repinned to the mutant text, so it refuses the PR4 bodies once the migration is applied there.
"""
import os, re, subprocess, sys, json
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from compose import bodies, c201  # noqa: E402
root = subprocess.check_output(['git', '-C', here, 'rev-parse', '--show-toplevel'], text=True).strip()
MIG = 'supabase/migrations/20261111140000_backlog_4170_billing_write_permissions.sql'
RB = 'supabase/tests/backlog-4170-p4/rollback-4170-p4.sql'
PIN = {'suspend': 'public.admin_suspend_user(uuid,text)', 'unsuspend': 'public.admin_unsuspend_user(uuid)',
       'update_license': 'public.admin_update_license(uuid,jsonb)',
       'adjust_credits': 'public.admin_adjust_credits(uuid,integer,text,jsonb)',
       'reinstate': 'public.reinstate_suspended_account(uuid,text)',
       'create_license': 'public.create_active_individual_license(uuid)',
       'finalize': 'public.finalize_paid_unlock(uuid,text,integer,uuid,jsonb)',
       'purchase': 'public.record_credit_purchase(uuid,integer,integer,jsonb)',
       'refund': 'public.record_refund(uuid,text,jsonb)'}
ACL_B = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
ACL_C = '{postgres=X/postgres,service_role=X/postgres}'
C_NEW = "  IF COALESCE(auth.role(), '') <> 'service_role' THEN\n"
C_OLD = "  IF auth.role() <> 'service_role' AND NOT public.has_internal_role(auth.uid()) THEN\n"
CL_NEW = ("AND NOT (public.has_internal_role(auth.uid())\n"
          "                                                    AND public.has_permission(auth.uid(), 'licenses.edit')))) THEN")
CL_OLD = "AND NOT public.has_internal_role(auth.uid()))) THEN"


def refund_from_c201(text):
    """record_refund rebuilt on the body BACKLOG-2345 replaced, with the new guard (no refund floor)."""
    old = c201()
    body = old[old.index('AS $rb$') + len('AS $rb$'):old.index('$rb$;')]
    body = body.replace(C_OLD, C_NEW)
    assert C_NEW in body
    i = text.index('CREATE OR REPLACE FUNCTION public.record_refund(')
    a = text.index('AS $function$', i) + len('AS $function$')
    b = text.index('$function$;', a)
    return text[:a] + body + text[b:]


# file -> [(old, new, expected match count)]; a callable entry transforms the whole file
MUT = {
  # suspend: internal role OR permission instead of AND
  'INTERNAL_ORed': {MIG: [("  v_licenses_suspended INT;\nBEGIN\n  IF NOT public.has_internal_role(auth.uid()) OR NOT public.has_permission(auth.uid(), 'users.suspend') THEN",
                           "  v_licenses_suspended INT;\nBEGIN\n  IF NOT public.has_internal_role(auth.uid()) AND NOT public.has_permission(auth.uid(), 'users.suspend') THEN", 1)]},
  # no database change at all (the UI hides buttons only): the migration file is the rollback's text
  'HIDE_ONLY': {MIG: [lambda t: open(os.path.join(root, RB)).read()]},
  # admin_adjust_credits keyed on billing.manage
  'WRONG_KEY_credits': {MIG: [("public.has_permission(auth.uid(), 'credits.adjust')", "public.has_permission(auth.uid(), 'billing.manage')", 1)]},
  # super-admin not granted credits.adjust (post-check edited to match)
  'SA_not_granted': {MIG: [("(r.slug IN ('super-admin', 'sales', 'support-supervisor') AND p.key = 'credits.adjust')",
                            "(r.slug IN ('sales', 'support-supervisor') AND p.key = 'credits.adjust')", 1),
                           ("IS DISTINCT FROM 'sales,super-admin,support-supervisor' THEN", "IS DISTINCT FROM 'sales,support-supervisor' THEN", 1)]},
  # support-supervisor not granted billing.suspend (post-check disabled)
  'SUP_billing_suspend_missing': {MIG: [("\n    OR (r.slug = 'support-supervisor' AND p.key = 'billing.suspend')", "", 1),
                                        ("  IF NOT EXISTS (SELECT 1 FROM public.admin_role_permissions rp\n",
                                         "  IF false AND NOT EXISTS (SELECT 1 FROM public.admin_role_permissions rp\n", 1)]},
  # the credits.adjust key is never inserted (post-check disabled)
  'KEY_not_inserted': {MIG: [("INSERT INTO public.admin_permissions (key, label, description, category) VALUES\n"
                              "  ('credits.adjust', 'Adjust credits', 'Grant or claw back a user''s credits', 'billing')\n"
                              "ON CONFLICT (key) DO NOTHING;\n", "", 1),
                             ("IS DISTINCT FROM 'sales,super-admin,support-supervisor' THEN", "IS DISTINCT FROM NULL THEN", 1)]},
  # finalize_paid_unlock keeps the internal-role branch
  'C_body_left': {MIG: [(C_NEW + "    RAISE EXCEPTION 'Unauthorized';\n  END IF;\n  IF p_unit_price_cents < 0",
                         C_OLD + "    RAISE EXCEPTION 'Unauthorized';\n  END IF;\n  IF p_unit_price_cents < 0", 1)]},
  # record_credit_purchase keeps EXECUTE for authenticated (post-check edited to match)
  'C_grant_left': {MIG: [("REVOKE EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) FROM PUBLIC, anon, authenticated;",
                          "REVOKE EXECUTE ON FUNCTION public.record_credit_purchase(uuid, integer, integer, jsonb) FROM PUBLIC, anon;", 1),
                         ("('public.record_credit_purchase(uuid,integer,integer,jsonb)', '%s', '" + ACL_C + "')",
                          "('public.record_credit_purchase(uuid,integer,integer,jsonb)', '%s', '" + ACL_B + "')", 1)]},
  # the three C guards without COALESCE
  'NULL_ROLE_unsafe': {MIG: [(C_NEW, "  IF auth.role() <> 'service_role' THEN\n", 3)]},
  # record_refund EXECUTE widened to authenticated (post-check edited to match)
  'REFUND_acl_widened': {MIG: [("GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO service_role;",
                                "GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO service_role;\n"
                                "GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO authenticated;", 1),
                               ("('public.record_refund(uuid,text,jsonb)', '%s', '" + ACL_C + "')",
                                "('public.record_refund(uuid,text,jsonb)', '%s', '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}')", 1)]},
  # record_refund rebuilt on the pre-2345 body (refund floor lost)
  'REFUND_from_c201': {MIG: [refund_from_c201]},
  # create_active_individual_license keeps the internal-only branch
  'CREATE_branch_left': {MIG: [(CL_NEW, CL_OLD, 1)]},
  # create_active_individual_license gates the self path too
  'CREATE_self_gated': {MIG: [("OR (p_user_id IS DISTINCT FROM auth.uid() AND NOT (public.has_internal_role(auth.uid())",
                               "OR (NOT (public.has_internal_role(auth.uid())", 1)]},
  # admin_get_user_detail not dropped (post-check removed)
  'DETAIL_not_dropped': {MIG: [("DROP FUNCTION IF EXISTS public.admin_get_user_detail(uuid);\n", "", 1),
                               ("  IF to_regprocedure('public.admin_get_user_detail(uuid)') IS NOT NULL THEN\n"
                                "    RAISE EXCEPTION 'BACKLOG-4170 PR4 post-check: admin_get_user_detail(uuid) still exists';\n  END IF;\n", "", 1)]},
  # anon keeps EXECUTE on admin_suspend_user (post-check edited to match)
  'ANON_not_revoked': {MIG: [("REVOKE EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) FROM PUBLIC, anon;",
                              "REVOKE EXECUTE ON FUNCTION public.admin_suspend_user(uuid, text) FROM PUBLIC;", 1),
                             ("('public.admin_suspend_user(uuid,text)', '%s', '" + ACL_B + "')",
                              "('public.admin_suspend_user(uuid,text)', '%s', '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}')", 1)]},
  # a refusal's RAISE text changed (admin_adjust_credits)
  'REFUSAL_text_changed': {MIG: [("public.has_permission(auth.uid(), 'credits.adjust') THEN\n    RAISE EXCEPTION 'Unauthorized';",
                                  "public.has_permission(auth.uid(), 'credits.adjust') THEN\n    RAISE EXCEPTION 'Unauthorized: credits.adjust required';", 1)]},
  # the pre-pin accepts any body
  'PIN_drift': {MIG: [("    IF r.cur NOT IN (r.prev, r.post) THEN", "    IF false THEN", 1)]},
  # the pre-pin does not check that 20261110100000 is recorded
  'PIN_no_2345_check': {MIG: [("  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261110100000') THEN",
                               "  IF false THEN", 1)]},
  # rollback leaves record_refund granted to authenticated
  'ROLLBACK_drift_acl': {RB: [("GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO service_role;\n",
                               "GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO service_role;\n"
                               "GRANT EXECUTE ON FUNCTION public.record_refund(uuid, text, jsonb) TO authenticated;\n", 1)]},
  # rollback leaves support-supervisor's billing.suspend
  'ROLLBACK_drift_catalog': {RB: [("AND r.slug = 'support-supervisor' AND p.key = 'billing.suspend';", "AND false;", 1)]},
  # rollback restores a different finalize_paid_unlock comment
  'ROLLBACK_drift_comment': {RB: [("'BACKLOG-2005a: PAYG purchase-and-unlock. service_role/internal only.", "'BACKLOG-2005a: PAYG purchase-and-unlock. service_role only.", 1)]},
  # rollback pre-pin removed (would overwrite a later body)
  'ROLLBACK_pin_removed': {RB: [("    IF r.cur IS NULL OR r.cur NOT IN (r.prev, r.post) THEN", "    IF false THEN", 1)]},
}


def sh(*a):
    return subprocess.run(a, capture_output=True, text=True, cwd=root)


def repin(mig, rb):
    for k, h in bodies(mig).items():
        sig = re.escape(PIN[k])
        for text_name in ('mig', 'rb'):
            t = mig if text_name == 'mig' else rb
            t, n = re.subn(r"(\('%s', '[0-9a-f]{32}', ')[0-9a-f]{32}('\))" % sig, r'\g<1>%s\g<2>' % h, t)
            if n != 1:
                sys.exit('pin for %s in %s matched %d times' % (k, text_name, n))
            if text_name == 'mig':
                t, n = re.subn(r"(\('%s', ')[0-9a-f]{32}(', '\{)" % sig, r'\g<1>%s\g<2>' % h, t)
                if n != 1:
                    sys.exit('post pin for %s matched %d times' % (k, n))
                mig = t
            else:
                rb = t
    return mig, rb


if __name__ == '__main__':
    if sh('git', 'status', '--porcelain', '--', MIG, RB).stdout.strip():
        sys.exit('migration or rollback has uncommitted changes; commit before mutating')
    modes = list(MUT) if sys.argv[1] == 'all' else sys.argv[1].split(',')
    for mode in modes:
        texts = {MIG: open(os.path.join(root, MIG)).read(), RB: open(os.path.join(root, RB)).read()}
        post = bodies(texts[MIG])
        for f, edits in MUT[mode].items():
            for ed in edits:
                if callable(ed):
                    new = ed(texts[f])
                    if new == texts[f]:
                        sys.exit('%s MUTATION NOT APPLIED: transform changed nothing' % mode)
                    texts[f] = new
                    continue
                old, new, cnt = ed
                if '%s' in old:
                    k = [k for k, s in PIN.items() if old.startswith("('" + s + "'")][0]
                    old, new = old % post[k], new % post[k]
                n = texts[f].count(old)
                if n != cnt:
                    sys.exit('%s MUTATION NOT APPLIED: fragment matched %d times, expected %d' % (mode, n, cnt))
                texts[f] = texts[f].replace(old, new)
        if mode != 'HIDE_ONLY':
            texts[MIG], texts[RB] = repin(texts[MIG], texts[RB])
        for f, t in texts.items():
            open(os.path.join(root, f), 'w').write(t)
        ns = sh('git', 'diff', '--numstat', '--', MIG, RB).stdout.strip()
        if not ns:
            sys.exit('%s MUTATION NOT APPLIED: git diff empty' % mode)
        changed = [l for l in sh('git', 'diff', '-U0', '--', MIG, RB).stdout.splitlines()
                   if l[:1] in '+-' and not l.startswith(('+++', '---'))]
        print('== %s' % mode)
        print('MUTATION APPLIED numstat=%s' % ns.replace('\n', ' | ').replace('\t', '/'))
        for l in changed[:12]:
            print('  %s %s' % (l[0], l[1:].strip()[:160]))
        if len(changed) > 12:
            print('  ... %d changed lines' % len(changed))
        try:
            out = subprocess.run([os.path.join(here, 'run.sh')], capture_output=True, text=True)
            o = out.stdout
            try:
                d = json.loads(o[o.index('{'):o.rindex('}') + 1])
                print('RESULT total=%s pass=%s fail=%s' % (d['total'], d['pass'], d['fail']))
                print('REDS ' + ','.join(sorted(d['reds'])))
                if not d['total']:
                    print('ZERO CONTROLS RAN')
                if not d['fail']:
                    print('MUTANT SURVIVED')
            except Exception:
                print('NO RESULT ' + o[:800] + out.stderr[:400])
        finally:
            sh('git', 'checkout', '--', MIG, RB)
            st = sh('git', 'status', '--porcelain', '--', MIG, RB).stdout.strip()
            print('RESTORED clean=%s' % (st == ''))
            if st:
                sys.exit('restore failed')
