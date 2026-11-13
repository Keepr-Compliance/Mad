#!/usr/bin/env python3
"""BACKLOG-3962 PR4a: build one SQL text for a single kt-sql call on keepr-test.

Usage: compose-pr4a.py <out.sql> <mode> [--applied]
  base | <mutant>   migration (mutated for a mutant) + controls-pr4a.sql. Ends in RAISE.
  live              controls-pr4a.sql only, against the objects applied on the venue.
  rollback          migration + rollback-3962-pr4a.sql + a probe of the restored state.
  --applied         the venue already has the migration: rollback-3962-pr4a.sql runs first, in
                    the same transaction (so the pinned bodies are back before the migration).
A mutation is an exact, once-only text replacement; a pattern that does not match exactly once,
or leaves the text unchanged, exits 2 (BACKLOG-2645, PR-SOP 4.4). A RUNTIME mutation patches a
function the migration does not own (pg_get_functiondef + replace) and raises if it matches
nothing.
"""
import difflib, os, sys

here = os.path.dirname(os.path.abspath(__file__))
MIG = os.path.join(here, '..', '..', 'migrations', '20261112120000_backlog_3962_jit_and_solo_block.sql')
RB = os.path.join(here, 'rollback-3962-pr4a.sql')
CTL = os.path.join(here, 'controls-pr4a.sql')

EMAIL_CLAIM = ("     OR NOT EXISTS (SELECT 1 FROM public.domain_claims c\n"
               "                     WHERE c.organization_id = v_org.id\n"
               "                       AND c.status = 'verified'\n"
               "                       AND c.domain = v_email_domain) THEN\n")
EXISTING = ("  IF EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = v_uid)\n"
            "     OR EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_uid) THEN\n"
            "    RETURN jsonb_build_object('success', false, 'error', 'existing_account');\n")
EXEMPT_ROWS = ("              WHERE m.user_id = p_user AND o.personal_owner_user_id IS NULL) THEN\n"
               "    RETURN NULL;\n")
EXEMPT_ACTIVE = ("              WHERE m.user_id = p_user AND o.personal_owner_user_id IS NULL\n"
                 "                AND m.license_status = 'active') THEN\n"
                 "    RETURN NULL;\n")

MUTANTS = {
    # J1, the most likely wrong build: brand-new = "no personal organization" (licence-only and
    # personal-row-only people would be joined)
    'M_brand_new_is_no_personal_org': [(EXISTING, EXISTING.replace(
        "  IF EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = v_uid)\n"
        "     OR EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = v_uid) THEN\n",
        "  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.personal_owner_user_id = v_uid AND false) THEN\n"))],
    # J2: the existing_account step dropped
    'M_no_existing_account': [(EXISTING, EXISTING.replace("  IF EXISTS (SELECT 1 FROM public.licenses l", "  IF false AND EXISTS (SELECT 1 FROM public.licenses l"))],
    # J3: lapsed claim accepted (status term dropped from the email-domain check)
    'M_claim_any_status': [(EMAIL_CLAIM, EMAIL_CLAIM.replace("                       AND c.status = 'verified'\n", ""))],
    # J3: suffix match on the email domain
    'M_claim_suffix_match': [(EMAIL_CLAIM, EMAIL_CLAIM.replace("AND c.domain = v_email_domain", "AND v_email_domain LIKE '%' || c.domain"))],
    # J3d: the claim may belong to any brokerage
    'M_claim_any_org': [(EMAIL_CLAIM, EMAIL_CLAIM.replace("                     WHERE c.organization_id = v_org.id\n", "                     WHERE true\n"))],
    # J4 (R8): the identity's tenant / hd no longer checked against the identifier asked for
    'M_no_identity_tid': [("     AND lower(i.identity_data -> 'custom_claims' ->> v_claim) = v_ident\n", "")],
    # JG2: Google hd need not equal the email domain
    'M_google_hd_not_email': [("     OR (v_provider = 'google' AND v_email_domain IS DISTINCT FROM v_ident)\n", "")],
    # JG4: Google brokerage found by any claim status (the email-domain check still holds: expected vacuous)
    'M_google_lookup_any_status': [("       AND c.status = 'verified'\n       AND c.domain = v_ident\n", "       AND c.domain = v_ident\n")],
    # J2c: placement in another brokerage counted for active rows only
    'M_placed_active_only': [("              WHERE m.user_id = v_uid AND o.personal_owner_user_id IS NULL) THEN\n"
                              "    RETURN jsonb_build_object('success', false, 'error', 'already_placed');\n",
                              "              WHERE m.user_id = v_uid AND o.personal_owner_user_id IS NULL AND m.license_status = 'active') THEN\n"
                              "    RETURN jsonb_build_object('success', false, 'error', 'already_placed');\n")],
    # S1 (R6): exemption counts active rows only
    'M_exempt_active_only': [(EXEMPT_ROWS, EXEMPT_ACTIVE)],
    # S1: suffix match in the block lookup
    'M_block_suffix_match': [("   WHERE c.domain = v_domain\n", "   WHERE v_domain LIKE '%' || c.domain\n")],
    # S1: block on a claim of any status
    'M_block_any_status': [("     AND c.status = 'verified'\n     AND c.block_solo_signups\n", "     AND c.block_solo_signups\n")],
    # S1d: invitation expiry ignored
    'M_invite_no_expiry': [("                AND (invitation_expires_at IS NULL OR invitation_expires_at >= now())) THEN\n", ") THEN\n")],
    # S2: the gate keyed on the caller instead of p_user_id
    'M_gate_on_caller': [("    v_block := public._solo_signup_block_org(p_user_id);\n", "    v_block := public._solo_signup_block_org(auth.uid());\n")],
    # E2 (v2 item 3): the no-licence condition dropped from ensure_personal_organization
    'M_ensure_any_licence': [("  IF NOT EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = v_uid)\n     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.personal_owner_user_id = v_uid) THEN\n",
                              "  IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.personal_owner_user_id = v_uid) THEN\n")],
    # C2 (v2 item 4): caller_domain_managed ignores the licence
    'M_managed_any_licence': [("  IF v_uid IS NULL OR EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = v_uid)\n     OR EXISTS", "  IF v_uid IS NULL\n     OR EXISTS")],
    # S1j: the personal-org exemption dropped from the licence gate
    'M_lic_no_personal_exempt': [("     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.personal_owner_user_id = p_user_id) THEN\n    v_block", " THEN\n    v_block")],
    # C6: the personal-org exemption dropped from caller_domain_managed
    'M_managed_no_personal_exempt': [("     OR EXISTS (SELECT 1 FROM public.organizations o WHERE o.personal_owner_user_id = v_uid) THEN\n    RETURN jsonb_build_object('blocked', false);", " THEN\n    RETURN jsonb_build_object('blocked', false);")],
    # T1: the toggle without the organization check
    'M_toggle_no_org_check': [("  IF NOT FOUND OR NOT public.is_org_admin(v_uid, v_row.organization_id) THEN\n", "  IF NOT FOUND THEN\n")],
    # T1c: the toggle turns on for any status
    'M_toggle_any_status': [("  IF p_on AND v_row.status <> 'verified' THEN\n", "  IF false THEN\n")],
    # POSTCHECK (R11): the internal function granted to authenticated
    'M_grant_internal': [("-- POSTCHECK BEGIN\n", "GRANT EXECUTE ON FUNCTION public._solo_signup_block_org(uuid) TO authenticated;\n-- POSTCHECK BEGIN\n")],
    # POSTCHECK: the overload left in place
    'M_keep_overload': [("DROP FUNCTION IF EXISTS public.jit_join_organization(text);\n", "")],
    # pin: a wrong md5 must stop the migration
    'M_pin_wrong_md5': [("IS DISTINCT FROM 'b8823ca1ec3a9d31daa353ad5116b611' THEN\n", "IS DISTINCT FROM '00000000000000000000000000000000' THEN\n")],
}

# S3 (C19, R6): the gate moved into _ensure_personal_organization_for. Alone it is vacuous for S3
# (the deactivated member is exempt by their brokerage row: SR 193b87d8); with the exemption
# narrowed to active rows it must red. Runtime patch of a function this migration does not own.
FOR_LOCK = "  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 3364));\n"
FOR_GATE = FOR_LOCK + "  IF public._solo_signup_block_org(p_user_id) IS NOT NULL THEN RETURN jsonb_build_object('status', 'domain_managed'); END IF;\n"
RUNTIME = {
    'M_gate_in_for': [('public._ensure_personal_organization_for(uuid)', FOR_LOCK, FOR_GATE)],
    'M_gate_in_for_active_only': [('public._ensure_personal_organization_for(uuid)', FOR_LOCK, FOR_GATE)],
}
MUTANTS['M_gate_in_for'] = []
MUTANTS['M_gate_in_for_active_only'] = [(EXEMPT_ROWS, EXEMPT_ACTIVE)]


def mutate(src, mode):
    out = src
    for old, new in MUTANTS[mode]:
        n = out.count(old)
        if n != 1:
            print(f'MUTATION NOT APPLIED: {mode}: pattern found {n} times', file=sys.stderr)
            sys.exit(2)
        out = out.replace(old, new)
    if MUTANTS[mode] and out == src:
        print(f'MUTATION NOT APPLIED: {mode}: text unchanged', file=sys.stderr)
        sys.exit(2)
    diff = [l for l in difflib.unified_diff(src.splitlines(), out.splitlines(), lineterm='', n=0)
            if l[:1] in '+-' and not l.startswith(('+++', '---'))]
    if diff:
        print(f'MUTATION APPLIED {mode}: ' + ' | '.join(diff)[:400])
    return out


def sqlstr(s):
    return "E'" + s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n') + "'"


def runtime(mode):
    parts = []
    for sig, old, new in RUNTIME.get(mode, []):
        print(f'RUNTIME MUTATION {mode}: {sig}: + {new[len(old):].strip()[:160]}')
        parts.append(f"""DO $rt$
DECLARE d text; n int; m1 text; m2 text; o text := {sqlstr(old)}; w text := {sqlstr(new)};
BEGIN
  d := pg_get_functiondef(to_regprocedure('{sig}'));
  n := (length(d) - length(replace(d, o, ''))) / length(o);
  IF n <> 1 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: % matches in {sig}', n; END IF;
  m1 := md5(d);
  EXECUTE replace(d, o, w);
  m2 := md5(pg_get_functiondef(to_regprocedure('{sig}')));
  IF m1 = m2 THEN RAISE EXCEPTION 'MUTATION NOT APPLIED: md5 unchanged {sig}'; END IF;
END
$rt$;
""")
    return '\n'.join(parts)


out, mode = sys.argv[1], sys.argv[2]
applied = '--applied' in sys.argv[3:]
mig = open(MIG).read()
rb = open(RB).read()
ctl = open(CTL).read()
if mode in MUTANTS:
    mig = mutate(mig, mode)
elif mode not in ('base', 'live', 'rollback'):
    print(f'unknown mode {mode}', file=sys.stderr)
    sys.exit(2)

head = "set local pg_stat_statements.track = 'none';\n" + f"SELECT set_config('p3962.mode', '{mode}', true);\n"
if applied and mode != 'live':
    head += rb + '\n'
if mode == 'live':
    body = ctl
elif mode == 'rollback':
    body = mig + '\n' + rb + """
DO $p$
BEGIN
  RAISE EXCEPTION 'P3962_RESULT %', jsonb_build_object('mode', 'rollback',
    'jit2', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.jit_join_organization(text, text)')),
    'jit1', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.jit_join_organization(text)')),
    'jit1_acl', (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.jit_join_organization(text)')),
    'lic', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.create_active_individual_license(uuid)')),
    'lic_acl', (SELECT proacl::text FROM pg_proc WHERE oid = to_regprocedure('public.create_active_individual_license(uuid)')),
    'epo', (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.ensure_personal_organization()')),
    'new_fns', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                 AND proname IN ('_solo_signup_block_org', 'domain_claim_set_block_solo', 'caller_domain_managed')),
    'column', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.domain_claims'::regclass
                       AND attname = 'block_solo_signups' AND NOT attisdropped));
END
$p$;
"""
else:
    body = mig + '\n' + ctl.replace('-- __MODE__\n', runtime(mode) + '\n-- __MODE__\n')
open(out, 'w').write(head + body)
