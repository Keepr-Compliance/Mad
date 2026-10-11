#!/usr/bin/env python3
"""BACKLOG-3845 mutants of the migration ("mig") and of rollback-3845.sql ("rb").

Each mutant is a list of edits (old, new[, count[, nth]]). `apply` raises unless
`old` occurs exactly `count` times (default 1); with `nth` set only that
occurrence (1-based) is replaced. A mutant that did not apply is never counted.

usage: mutants.py list                      -> name|file|target controls
       mutants.py apply <name> <src> <out>
       mutants.py classify < status-lines
classify: INVALID (any ERROR or no line), KILLED (>=1 FAIL), SURVIVED (all PASS).
"""
import sys

# The statement each resolver gained (6-space indent in the two loop resolvers,
# 2-space in check_feature_access).
BLOCK6 = ("      IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN\n"
          "        v_override := NULL;\n"
          "      END IF;\n")
BLOCK2 = ("  IF v_override IS NOT NULL AND NOT public._override_effective(v_override) THEN\n"
          "    v_override := NULL;\n"
          "  END IF;\n")
GUARDS = ("  IF v_s !~ '^\\d{4}-\\d{2}-\\d{2}T' THEN\n"
          "    RETURN false;\n"
          "  END IF;\n"
          "  IF NOT pg_input_is_valid(v_s, 'timestamptz') THEN\n"
          "    RETURN false;\n"
          "  END IF;\n")
VALID_GUARD = ("  IF NOT pg_input_is_valid(v_s, 'timestamptz') THEN\n"
               "    RETURN false;\n"
               "  END IF;\n")
GRANT_TEST_CHECK = ("  IF p_mode = 'test' AND v_is_test IS NOT TRUE THEN\n"
                    "    RAISE EXCEPTION 'grant_unlimited_from_subscription: test mode requires an is_test personal organization' USING ERRCODE = '42501';\n"
                    "  END IF;\n")
GRANT_LIVE_CHECK = ("  IF p_mode = 'live' AND v_is_test IS NOT FALSE THEN\n"
                    "    RAISE EXCEPTION 'grant_unlimited_from_subscription: live mode refuses an is_test personal organization' USING ERRCODE = '42501';\n"
                    "  END IF;\n")
GRANT_NULL_CHECK = ("  IF p_paid_through IS NULL THEN\n"
                    "    RAISE EXCEPTION 'grant_unlimited_from_subscription: paid_through required' USING ERRCODE = '22004';\n"
                    "  END IF;\n")
GRANT_NOORG = ("  IF v_org_id IS NULL THEN\n"
               "    RAISE EXCEPTION 'grant_unlimited_from_subscription: user has no personal organization' USING ERRCODE = '42501';\n"
               "  END IF;\n")
GRANT_SUSP = ("  IF EXISTS (SELECT 1 FROM public.licenses l WHERE l.user_id = p_user_id AND l.status = 'suspended') THEN\n"
              "    RETURN jsonb_build_object('status', 'refused', 'reason', 'licence_suspended', 'organization_id', v_org_id);\n"
              "  END IF;\n")
GRANT_NONSTRIPE = ("  IF v_existing IS NOT NULL AND (v_existing ->> 'source') IS DISTINCT FROM 'stripe' THEN\n"
                   "    RETURN jsonb_build_object('status', 'refused', 'reason', 'non_stripe_override', 'organization_id', v_org_id);\n"
                   "  END IF;\n")
REVOKE_NONSTRIPE = ("  IF (v_existing ->> 'source') IS DISTINCT FROM 'stripe' THEN\n"
                    "    RETURN jsonb_build_object('status', 'noop', 'reason', 'non_stripe_override', 'organization_id', v_org_id);\n"
                    "  END IF;\n")
REVOKE_TEST_CHECK = ("  IF p_mode = 'test' AND v_is_test IS NOT TRUE THEN\n"
                     "    RAISE EXCEPTION 'revoke_unlimited_from_subscription: test mode requires an is_test personal organization' USING ERRCODE = '42501';\n"
                     "  END IF;\n")
TRG_SC = ("CREATE TRIGGER guard_stripe_mode_is_test\n"
          "  BEFORE INSERT OR UPDATE OF stripe_mode, user_id ON public.stripe_customers\n"
          "  FOR EACH ROW EXECUTE FUNCTION public._guard_stripe_mode_is_test();\n")
TRG_BS = ("CREATE TRIGGER guard_stripe_mode_is_test\n"
          "  BEFORE INSERT OR UPDATE OF stripe_mode, user_id, organization_id ON public.billing_subscriptions\n"
          "  FOR EACH ROW EXECUTE FUNCTION public._guard_stripe_mode_is_test();\n")
ORG_FIRST = ("  IF v_org_id IS NOT NULL THEN\n"
             "    SELECT o.is_test INTO v_is_test FROM public.organizations o WHERE o.id = v_org_id;\n"
             "  ELSIF v_user_id IS NOT NULL THEN\n")
LEASE = "       AND (b.claimed_until IS NULL OR b.claimed_until < now())\n"
RB_OVERRIDE_GUARD = "  IF n > 0 THEN RAISE EXCEPTION 'BACKLOG-3845 rollback: % override(s) carry paid_through or source=stripe', n; END IF;\n"
RB_TEST_GUARD = "  IF n > 0 THEN RAISE EXCEPTION 'BACKLOG-3845 rollback: % non-live stripe_customers row(s); purge them first', n; END IF;\n"

MUTANTS = {
    # name: (file, [edits], target controls)
    # -- paid_through rule
    "m01-missing-paid-through-is-expired": ("mig", [(
        "  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN\n    RETURN true;\n",
        "  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN\n    RETURN false;\n")], "k01"),
    "m02a-broker-not-patched": ("mig", [(BLOCK6, "", 2, 2)], "k02"),
    "m02b-check-access-not-patched": ("mig", [(BLOCK2, "")], "k02"),
    "m02c-only-get-org-features-patched": ("mig", [(BLOCK6, "", 2, 2), (BLOCK2, "")], "k02"),
    "m03a-direct-cast-no-guards": ("mig", [(GUARDS, "")], "k03 k06"),
    "m03b-regex-only-no-validity": ("mig", [(VALID_GUARD, "")], "k03 k06"),
    "m04-ge-instead-of-gt": ("mig", [("  RETURN v_s::timestamptz > now();\n", "  RETURN v_s::timestamptz >= now();\n")], "k04"),
    "m05-expired-short-circuits-off": ("mig", [
        ("        v_override := NULL;\n", "        v_override := '{\"enabled\": false}'::jsonb;\n", 2),
        ("    v_override := NULL;\n", "    v_override := '{\"enabled\": false}'::jsonb;\n", 1)], "k05"),
    # -- RC7 grants: each REVOKE / RLS line on its own
    "m06a-no-revoke-override-effective": ("mig", [("REVOKE EXECUTE ON FUNCTION public._override_effective(jsonb) FROM PUBLIC, anon, authenticated;\n", "")], "k10"),
    "m06b-no-revoke-trigger-fn": ("mig", [("REVOKE EXECUTE ON FUNCTION public._guard_stripe_mode_is_test() FROM PUBLIC, anon, authenticated;\n", "")], "k10"),
    "m06c-no-revoke-claim": ("mig", [("REVOKE EXECUTE ON FUNCTION public.billing_outbox_claim(text, integer) FROM PUBLIC, anon, authenticated;\n", "")], "k10"),
    "m06d-no-revoke-grant": ("mig", [("REVOKE EXECUTE ON FUNCTION public.grant_unlimited_from_subscription(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;\n", "")], "k10"),
    "m06e-no-revoke-revoke": ("mig", [("REVOKE EXECUTE ON FUNCTION public.revoke_unlimited_from_subscription(uuid, text) FROM PUBLIC, anon, authenticated;\n", "")], "k10"),
    "m06f-revoke-only-from-anon": ("mig", [("REVOKE EXECUTE ON FUNCTION public.grant_unlimited_from_subscription(uuid, timestamptz, text) FROM PUBLIC, anon, authenticated;\n",
                                            "REVOKE EXECUTE ON FUNCTION public.grant_unlimited_from_subscription(uuid, timestamptz, text) FROM PUBLIC, anon;\n")], "k10"),
    "m06g-no-rls-subscriptions": ("mig", [("ALTER TABLE public.billing_subscriptions ENABLE ROW LEVEL SECURITY;\n", "")], "k10 k13"),
    "m06h-no-rls-outbox": ("mig", [("ALTER TABLE public.billing_outbox ENABLE ROW LEVEL SECURITY;\n", "")], "k10"),
    "m06i-no-revoke-outbox-table": ("mig", [("REVOKE ALL ON public.billing_outbox FROM PUBLIC, anon, authenticated;\n", "")], "k10 k13"),
    "m06j-no-revoke-subscriptions-table": ("mig", [("REVOKE ALL ON public.billing_subscriptions FROM PUBLIC, anon, authenticated;\n", "")], "k10 k13"),
    "m06k-grant-is-security-definer": ("mig", [(
        "  p_user_id uuid, p_paid_through timestamptz, p_mode text)\nRETURNS jsonb\nLANGUAGE plpgsql\nSECURITY INVOKER\n",
        "  p_user_id uuid, p_paid_through timestamptz, p_mode text)\nRETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER\n")], "k10"),
    # -- RC8 / D7 trigger (separate from the RPC checks)
    "m07-trigger-null-is-allowed": ("mig", [("  IF v_is_test IS NOT TRUE THEN\n    RAISE EXCEPTION 'stripe_mode test requires",
                                             "  IF v_is_test IS FALSE THEN\n    RAISE EXCEPTION 'stripe_mode test requires")], "k09"),
    "m08a-no-trigger-stripe-customers": ("mig", [(TRG_SC, "")], "k09"),
    "m08b-no-trigger-subscriptions": ("mig", [(TRG_BS, "")], "k09"),
    "m08c-trigger-ignores-row-org": ("mig", [(ORG_FIRST, "  IF false THEN\n    NULL;\n  ELSIF v_user_id IS NOT NULL THEN\n")], "k09"),
    # -- grant / revoke RPC checks (each on its own)
    "m09-grant-no-test-check": ("mig", [(GRANT_TEST_CHECK, "")], "k07"),
    "m10-grant-no-live-check": ("mig", [(GRANT_LIVE_CHECK, "")], "k07"),
    "m11-grant-null-paid-through-allowed": ("mig", [(GRANT_NULL_CHECK, "")], "k07"),
    "m12-grant-no-suspended-check": ("mig", [(GRANT_SUSP, "")], "k07"),
    "m13-grant-overwrites-support-override": ("mig", [(GRANT_NONSTRIPE, "")], "k07"),
    "m14-revoke-removes-any-override": ("mig", [(REVOKE_NONSTRIPE, "")], "k08"),
    "m15-grant-value-as-text": ("mig", [("'paid_through', to_jsonb(p_paid_through),", "'paid_through', to_jsonb(p_paid_through::text),")], "k07"),
    "m16-grant-no-personal-org-check": ("mig", [(GRANT_NOORG, "")], "k07"),
    "m17-revoke-no-test-check": ("mig", [(REVOKE_TEST_CHECK, "")], "k08"),
    # -- stripe_customers policy / PK / default
    "m18-select-policy-not-narrowed": ("mig", [(" AND stripe_mode = 'live')\n", ")\n")], "k11"),
    "m19-no-default-live": ("mig", [("ALTER TABLE public.stripe_customers\n  ADD COLUMN IF NOT EXISTS stripe_mode text NOT NULL DEFAULT 'live';\n",
                                     "ALTER TABLE public.stripe_customers\n  ADD COLUMN IF NOT EXISTS stripe_mode text NOT NULL;\n")], "k14"),
    "m20-pk-not-widened": ("mig", [("    ALTER TABLE public.stripe_customers DROP CONSTRAINT stripe_customers_pkey;\n    ALTER TABLE public.stripe_customers ADD CONSTRAINT stripe_customers_pkey PRIMARY KEY (user_id, stripe_mode);\n",
                                    "    NULL;\n")], "k14 k11"),
    # -- outbox / subscriptions
    "m21-claim-no-lease": ("mig", [(LEASE, "")], "k12"),
    "m22-claim-ignores-mode": ("mig", [("     WHERE b.stripe_mode = p_mode\n       AND b.processed_at IS NULL\n", "     WHERE b.processed_at IS NULL\n")], "k12"),
    "m23-no-one-open-subscription-index": ("mig", [(
        "CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_one_open_per_user_mode\n"
        "  ON public.billing_subscriptions (user_id, stripe_mode)\n"
        "  WHERE status IN ('active', 'trialing', 'past_due', 'incomplete');\n", "")], "k13"),
    # -- drift precondition
    "m24-no-drift-precheck": ("mig", [("    IF r.actual <> r.expected AND NOT r.ours THEN\n", "    IF false THEN\n")], "k19"),
    # -- rollback refusals
    "r01-rollback-ignores-stripe-overrides": ("rb", [(RB_OVERRIDE_GUARD, "")], "k17"),
    "r02-rollback-ignores-test-rows": ("rb", [(RB_TEST_GUARD, "")], "k18"),
    "r03-rollback-keeps-new-bodies": ("rb", [("DROP FUNCTION IF EXISTS public._override_effective(jsonb);\n", "")], "k16"),
}


def apply(name, src_path, out_path):
    src = open(src_path).read()
    out = src
    for edit in MUTANTS[name][1]:
        old, new = edit[0], edit[1]
        want = edit[2] if len(edit) > 2 else 1
        nth = edit[3] if len(edit) > 3 else None
        n = out.count(old)
        if n != want:
            raise SystemExit(f"mutant {name}: pattern occurs {n} times (want {want}): {old[:70]!r}")
        if nth is None:
            out = out.replace(old, new)
        else:
            idx = -1
            for _ in range(nth):
                idx = out.index(old, idx + 1)
            out = out[:idx] + new + out[idx + len(old):]
    if out == src:
        raise SystemExit(f"mutant {name}: changed nothing")
    open(out_path, "w").write(out)


def classify(lines):
    lines = [l for l in lines if l.strip()]
    if not lines or any(l.startswith("ERROR|") for l in lines):
        return "INVALID"
    return "KILLED" if any(l.startswith("FAIL|") for l in lines) else "SURVIVED"


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "list":
        for k, (f, _, t) in MUTANTS.items():
            print(f"{k}|{f}|{t}")
    elif cmd == "apply":
        apply(sys.argv[2], sys.argv[3], sys.argv[4])
    elif cmd == "classify":
        print(classify(sys.stdin.read().splitlines()))
    else:
        raise SystemExit("usage: mutants.py list|apply|classify")
