#!/usr/bin/env python3
"""BACKLOG-3882 mutants.

Each mutant is a list of exact-string replacements on the migration ("edit")
or on rollback-3882.sql ("rbedit"). `apply` raises unless every pattern occurs
exactly once, so a mutant that did not apply can never be counted.

usage: mutants.py list
       mutants.py apply <name> <migration> <rollback> <out-migration> <out-rollback>
       mutants.py classify < status-lines

classify: INVALID (any ERROR, or no status line), KILLED (no ERROR, >=1 FAIL),
SURVIVED (only PASS). Target "race" means race.sh, not a control file.
"""
import sys

SELECT_ID = ("  SELECT lower(i.identity_data->'custom_claims'->>'tid')\n"
             "  INTO v_identity_tid\n"
             "  FROM auth.identities i\n"
             "  WHERE i.user_id = v_user_id\n"
             "    AND i.provider = 'azure'\n"
             "    AND lower(i.identity_data->'custom_claims'->>'tid') = lower(btrim(p_tenant_id))\n"
             "  LIMIT 1;\n")
MISMATCH = ("  IF v_identity_tid IS NULL THEN\n"
            "    RAISE EXCEPTION 'tenant does not match the signed-in identity' USING ERRCODE = '42501';\n"
            "  END IF;\n")
CONSUMER_IF = "  IF v_identity_tid = '9188040d-6c67-4c5b-b112-36a304b66dad' THEN"  # pii-allow-uuid: Microsoft's public personal-account tenant constant
CONSUMER = (CONSUMER_IF + " -- pii-allow-uuid: Microsoft's public personal-account tenant constant\n"
            "    RAISE EXCEPTION 'personal Microsoft accounts cannot provision an organization' USING ERRCODE = '42501';\n"
            "  END IF;\n")
ORG_FAIL = ("  IF v_org_id IS NULL THEN\n"
            "    RETURN jsonb_build_object('success', false, 'error', 'Failed to create organization');\n")
CANON = "  p_tenant_id := v_identity_tid;\n"
REVOKE_IT = "REVOKE EXECUTE ON FUNCTION public.auto_provision_it_admin(text, text, text) FROM PUBLIC, anon;\n"
GRANT_IT = "GRANT EXECUTE ON FUNCTION public.auto_provision_it_admin(text, text, text) TO authenticated, service_role;\n"
REVOKE_G = "REVOKE EXECUTE ON FUNCTION public.auto_provision_google_it_admin(text, text, text) FROM PUBLIC, anon, authenticated;\n"

MUTANTS = {
    # name: (kind, [(old, new), ...], targets)
    "m01-no-tenant-check": ("edit", [(SELECT_ID + "\n" + MISMATCH + "\n" + CONSUMER + "\n" + CANON, "")],
                            "c1-other-tenant-existing-org c2-other-tenant-no-org"),
    # the check placed after the org insert, refusing by RETURN instead of RAISE
    "m02-check-after-org-insert": ("edit", [
        (SELECT_ID + "\n" + MISMATCH + "\n" + CONSUMER + "\n" + CANON, ""),
        (ORG_FAIL, SELECT_ID + "  IF v_identity_tid IS NULL THEN\n"
                   "    RETURN jsonb_build_object('success', false, 'error', 'tenant_mismatch');\n  END IF;\n" + ORG_FAIL)],
        "c2-other-tenant-no-org"),
    # trusting user-editable metadata
    "m03-tid-from-user-metadata": ("edit", [(SELECT_ID,
        "  SELECT lower(u.raw_user_meta_data->'custom_claims'->>'tid')\n"
        "  INTO v_identity_tid\n"
        "  FROM auth.users u\n"
        "  WHERE u.id = v_user_id\n"
        "    AND lower(u.raw_user_meta_data->'custom_claims'->>'tid') = lower(btrim(p_tenant_id))\n"
        "  LIMIT 1;\n")], "c3-metadata-not-trusted"),
    "m04a-case-sensitive-compare": ("edit", [("= lower(btrim(p_tenant_id))\n", "= btrim(p_tenant_id)\n")],
                                    "c4-case-and-canonical-tenant"),
    "m04b-no-trim": ("edit", [("= lower(btrim(p_tenant_id))\n", "= lower(p_tenant_id)\n")],
                     "c4-case-and-canonical-tenant"),
    "m04c-org-keyed-on-caller-value": ("edit", [(CANON, "")], "c4-case-and-canonical-tenant"),
    # matching the user's provider_id (sub/oid) instead of the tenant claim
    "m05-match-provider-id": ("edit", [(
        "    AND lower(i.identity_data->'custom_claims'->>'tid') = lower(btrim(p_tenant_id))\n",
        "    AND i.provider_id = btrim(p_tenant_id)\n")], "c5-provider-id-not-a-tenant"),
    "m06-no-consumer-guard": ("edit", [(CONSUMER, "")], "c6-consumer-tenant"),
    "m07a-no-revoke": ("edit", [(REVOKE_IT, "")], "c7-apply-twice-and-grants"),
    "m07b-revoke-anon-only": ("edit", [(REVOKE_IT, REVOKE_IT.replace("FROM PUBLIC, anon;", "FROM anon;"))],
                              "c7-apply-twice-and-grants"),
    "m07c-authenticated-revoked": ("edit", [(REVOKE_IT + GRANT_IT,
        REVOKE_IT.replace("FROM PUBLIC, anon;", "FROM PUBLIC, anon, authenticated;") +
        GRANT_IT.replace("TO authenticated, service_role;", "TO service_role;"))], "c7-apply-twice-and-grants"),
    "m07d-precheck-rejects-applied-body": ("edit", [(
        "v_md5 NOT IN ('b0541c6347baf9457cf949f5ec5be1e5', 'a88466cc17f1f28a9824ec62c73a2589')",
        "v_md5 NOT IN ('b0541c6347baf9457cf949f5ec5be1e5')")], "c7-apply-twice-and-grants"),
    # first-user-wins
    "m08a-no-row-lock": ("edit", [("  WHERE id = v_org_id\n  FOR UPDATE;\n", "  WHERE id = v_org_id;\n")], "race"),
    "m08b-every-caller-admin": ("edit", [("                ELSE v_default_role\n", "                ELSE 'admin'\n")],
                                "c8-first-user-wins"),
    "m08c-unclaimed-invites-counted": ("edit", [(
        "                  WHERE organization_id = v_org_id\n                    AND user_id IS NOT NULL\n",
        "                  WHERE organization_id = v_org_id\n")], "c8-first-user-wins"),
    "m09-no-google-revoke": ("edit", [(REVOKE_G, "")], "c9-google-revoked"),
    "m10-precheck-ignores-body": ("edit", [("  IF v_md5 IS NULL OR v_md5 NOT IN", "  IF false AND v_md5 NOT IN")],
                                  "c11-drift-aborts"),
    "r01-rollback-keeps-revoke": ("rbedit", [(
        "GRANT EXECUTE ON FUNCTION public.auto_provision_it_admin(text, text, text) TO PUBLIC, anon, authenticated, service_role;\n",
        "")], "c10-rollback"),
    "r02-rollback-keeps-google-revoke": ("rbedit", [(
        "GRANT EXECUTE ON FUNCTION public.auto_provision_google_it_admin(text, text, text) TO PUBLIC, anon, authenticated, service_role;\n",
        "")], "c10-rollback"),
}


def classify(lines):
    status = [l.split("|", 1)[0] for l in lines if l.split("|", 1)[0] in ("PASS", "FAIL", "ERROR")]
    if not status or "ERROR" in status:
        return "INVALID"
    if "FAIL" in status:
        return "KILLED"
    return "SURVIVED"


def main():
    if sys.argv[1] == "classify":
        print(classify(sys.stdin.read().splitlines()))
        return
    if sys.argv[1] == "list":
        for k, v in MUTANTS.items():
            print(f"{k}|{v[-1]}")
        return
    if sys.argv[1] != "apply":
        raise SystemExit(__doc__)
    name, mig, rb, out_mig, out_rb = sys.argv[2:7]
    kind, pairs, _targets = MUTANTS[name]
    srcs = {"edit": open(mig).read(), "rbedit": open(rb).read()}
    for a, b in pairs:
        n = srcs[kind].count(a)
        if n != 1:
            raise SystemExit(f"mutant {name}: pattern occurs {n} times (need exactly 1): {a[:60]!r}")
        srcs[kind] = srcs[kind].replace(a, b)
    open(out_mig, "w").write(srcs["edit"])
    open(out_rb, "w").write(srcs["rbedit"])


if __name__ == "__main__":
    main()
