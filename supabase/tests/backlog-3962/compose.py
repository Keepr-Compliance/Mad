#!/usr/bin/env python3
"""BACKLOG-3962 PR1: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose.py <out.sql> <mode>
  mode = base | <mutant> | rollback
  base / mutants: migration (mutated for a mutant) + controls.sql. Ends in RAISE: nothing persists.
  rollback: migration + rollback-3962-pr1.sql + a probe that every object is gone.
A mutation is an exact, once-only text replacement; it must change the text, else exit 2
(BACKLOG-2645, PR-SOP 4.4). The POSTCHECK block is kept in every mode: it pins no body of this
migration, and the grant mutant needs it.
"""
import difflib, os, re, sys

here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261112100000_backlog_3962_domain_claims.sql')
RB = os.path.join(here, 'rollback-3962-pr1.sql')

MUTANTS = {
    # (a) token match: substring instead of exact equality
    'M_token_substring': [("     WHERE btrim(a.answer) = v_row.token\n",
                           "     WHERE btrim(a.answer) LIKE '%' || v_row.token || '%'\n")],
    # (a) / C2 token match: any claim's token for the domain, not this row's
    'M_token_any_claim': [("     WHERE btrim(a.answer) = v_row.token\n",
                           "     WHERE btrim(a.answer) IN (SELECT t.token FROM public.domain_claims t WHERE t.domain = v_row.domain)\n")],
    # (b) caller check on create dropped
    'M_create_no_admin_check': [("  IF p_org IS NULL OR NOT public.is_org_admin(v_uid, p_org) THEN\n",
                                 "  IF p_org IS NULL THEN\n")],
    # (b) caller check on withdraw dropped
    'M_withdraw_no_admin_check': [("  IF NOT FOUND OR NOT public.is_org_admin(v_uid, v_row.organization_id) THEN\n",
                                   "  IF NOT FOUND THEN\n")],
    # (b) personal-org refusal dropped
    'M_create_personal_ok': [("              WHERE o.id = p_org AND o.personal_owner_user_id IS NOT NULL) THEN\n",
                              "              WHERE o.id = p_org AND false) THEN\n")],
    # (b) R2: begin_check ignores the org
    'M_begin_check_any_org': [("   WHERE c.id = p_claim\n     AND c.organization_id = p_org\n     AND c.status IN ('pending', 'verified', 'lapsed')\n",
                               "   WHERE c.id = p_claim\n     AND c.status IN ('pending', 'verified', 'lapsed')\n")],
    # (b) R1 / C4b: record_check's inside role check dropped
    'M_record_check_no_role_check': [("    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';\n  END IF;\n  IF p_source IS NULL",
                                      "    NULL;\n  END IF;\n  IF p_source IS NULL")],
    # (c) one verified claim per domain: the partial unique index dropped
    'M_no_verified_unique': [("CREATE UNIQUE INDEX domain_claims_one_verified_per_domain\n  ON public.domain_claims (domain) WHERE status = 'verified';\n",
                              "")],
    # C5: comcast.net taken out of the consumer list
    'M_consumer_no_comcast': [("'fastmail.com', 'comcast.net', ", "'fastmail.com', ")],
    # C8: rate limit dropped
    'M_no_rate_limit': [("     AND (c.last_checked_at IS NULL OR c.last_checked_at <= now() - interval '30 seconds')\n", "")],
    # R5: every re-check miss counts (no 20 h spacing)
    'M_r5_no_spacing': [("     AND (v_row.last_miss_counted_at IS NULL OR v_row.last_miss_counted_at <= now() - interval '20 hours') THEN\n",
                         "     THEN\n")],
    # R5: manual misses count too
    'M_r5_manual_counts': [("  IF v_row.status = 'verified' AND p_source = 'recheck'\n", "  IF v_row.status = 'verified'\n")],
    # R11: one service-only function granted to authenticated; the POSTCHECK must raise
    'M_grant_authenticated': [("-- POSTCHECK BEGIN\n",
                               "GRANT EXECUTE ON FUNCTION public._domain_claim_record_check(uuid, uuid, text[], boolean, text) TO authenticated;\n-- POSTCHECK BEGIN\n")],
}

out, mode = sys.argv[1], sys.argv[2]
mig = open(MIG).read()
ctl = open(os.path.join(here, 'controls.sql')).read()

if mode in MUTANTS:
    m = mig
    for old, new in MUTANTS[mode]:
        n = m.count(old)
        if n != 1:
            print(f'MUTATION NOT APPLIED: {mode}: pattern found {n} times', file=sys.stderr)
            sys.exit(2)
        m = m.replace(old, new)
    if m == mig:
        print(f'MUTATION NOT APPLIED: {mode}: text unchanged', file=sys.stderr)
        sys.exit(2)
    diff = [l for l in difflib.unified_diff(mig.splitlines(), m.splitlines(), lineterm='', n=0)
            if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    print(f'MUTATION APPLIED {mode}: ' + ' | '.join(diff)[:400])
    mig = m
elif mode not in ('base', 'rollback'):
    print(f'unknown mode {mode}', file=sys.stderr)
    sys.exit(2)

head = f"SELECT set_config('p3962.mode', '{mode}', true);\n"
if mode == 'rollback':
    probe = """
DO $rb$
BEGIN
  RAISE EXCEPTION 'P3962_RESULT %', jsonb_build_object('mode', 'rollback',
    'table', to_regclass('public.domain_claims') IS NOT NULL,
    'functions', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                   AND proname IN ('_normalize_claim_domain', '_is_consumer_email_domain', 'domain_claim_create',
                                   'domain_claim_withdraw', '_domain_claim_begin_check', '_domain_claim_record_check',
                                   '_domain_claims_due_for_recheck', 'admin_list_domain_claims',
                                   'admin_revoke_domain_claim')));
END
$rb$;
"""
    text = head + mig + '\n' + open(RB).read() + '\n' + probe
else:
    text = head + mig + '\n' + ctl
text += "\nDO $end$ BEGIN RAISE EXCEPTION 'P3962_END_NO_RESULT'; END $end$;\n"
assert not re.search(r'^\s*COMMIT\b', text, re.I | re.M), 'COMMIT statement in composed text'
open(out, 'w').write(text)
