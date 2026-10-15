#!/usr/bin/env python3
"""BACKLOG-3851 mutants. Each is an exact-string edit of M1 or M2 that must match exactly
once (else the mutant is INVALID and the run says so). `list [fragment]` prints
name|part|controls, where controls is the control-file fragment run.sh runs against the
mutant ('race:<scenario>' = race.sh). `apply <name> <src> <dst>` writes the mutant and
prints MUTATION APPLIED plus the changed line count.

Usage: mutants.py list [fragment] | apply <name> <src> <dst>
"""
import sys

SEAT_LOCK = """  SELECT o.max_seats INTO v_max_seats
    FROM public.organizations o WHERE o.id = NEW.organization_id
    FOR NO KEY UPDATE;"""
SEAT_COUNT = """  SELECT count(*) INTO v_used
    FROM public.organization_members m
   WHERE m.organization_id = NEW.organization_id
     AND m.id <> NEW.id
     AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);"""
R4_BLOCK = """  IF NEW.user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.organization_members m
     WHERE m.organization_id = NEW.organization_id
       AND m.id <> NEW.id
       AND m.user_id IS NOT NULL
       AND public.member_status_grants_access(m.license_status)
  ) THEN
    RAISE NOTICE 'seat_limit_first_member_over_limit organization_id=%', NEW.organization_id;
    RETURN NEW;
  END IF;
"""
GOF_GATE = """    WHERE user_id = auth.uid() AND organization_id = p_org_id
      AND public.member_status_grants_access(license_status)
  ) THEN
    RETURN jsonb_build_object('error', 'not_authorized', 'features', '[]'::jsonb);"""
CFA_GATE = """    WHERE user_id = auth.uid() AND organization_id = p_org_id
      AND public.member_status_grants_access(license_status)
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'error', 'not_authorized');"""
RPC_LOCK = """  SELECT o.personal_owner_user_id IS NOT NULL INTO v_personal
    FROM public.organizations o WHERE o.id = v_org_id
    FOR NO KEY UPDATE;"""
HOLDS = """    p_license_status = 'active'
    OR (p_license_status = 'pending'
        AND (p_user_id IS NOT NULL OR p_invitation_expires_at IS NULL OR p_invitation_expires_at >= now())),"""
REVERT_GUARDED = """  BEGIN
    PERFORM public._ensure_personal_organization_for(NEW.user_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'revert_deactivated_member: personal organization not attached for member % (%: %)',
      NEW.id, SQLSTATE, SQLERRM;
  END;"""

# name: (part, controls, [(old, new), ...])
MUTANTS = {
  # --- seat trigger: locking and counting (two-session) ---
  "W2_no_lock":            ("M1", "race:c04r",
                            [(SEAT_LOCK, SEAT_LOCK.replace("\n    FOR NO KEY UPDATE;", ";"))]),
  "W2_no_lock_commit":     ("M1", "race:c04c",
                            [(SEAT_LOCK, SEAT_LOCK.replace("\n    FOR NO KEY UPDATE;", ";"))]),
  "R2_count_before_lock":  ("M1", "race:c04c",
                            [(SEAT_LOCK + "\n  IF v_max_seats IS NULL OR v_max_seats <= 0 THEN\n    RETURN NEW;\n  END IF;\n\n  -- Counted after the lock: a committed writer ahead of us is visible here.\n" + SEAT_COUNT,
                              SEAT_COUNT + "\n" + SEAT_LOCK + "\n  IF v_max_seats IS NULL OR v_max_seats <= 0 THEN\n    RETURN NEW;\n  END IF;\n")]),
  "R1_for_update":         ("M1", "race:c15",
                            [(SEAT_LOCK, SEAT_LOCK.replace("FOR NO KEY UPDATE", "FOR UPDATE"))]),
  "W14_r4_before_lock":    ("M1", "race:c12b",
                            [(R4_BLOCK, ""),
                             (SEAT_LOCK, R4_BLOCK + "\n" + SEAT_LOCK)]),
  "R11_rpc_no_lock":       ("M1", "race:c14",
                            [(RPC_LOCK, RPC_LOCK.replace("\n    FOR NO KEY UPDATE;", ";"))]),
  # --- seat trigger: rules ---
  "R3_rewrite_on_update":  ("M1", "c11",
                            [("  IF TG_OP = 'INSERT' AND public.member_origin_is_idp(NEW.provisioned_by) THEN",
                              "  IF public.member_origin_is_idp(NEW.provisioned_by) THEN")]),
  "W3_current_user_exempt":("M1", "c02",
                            [("BEGIN\n  -- Timestamp first, before any early return",
                              "BEGIN\n  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;\n  -- Timestamp first, before any early return")]),
  "W3b_service_exempt":    ("M1", "c03",
                            [("BEGIN\n  -- Timestamp first, before any early return",
                              "BEGIN\n  IF current_setting('request.jwt.claims', true)::jsonb ->> 'role' = 'service_role' THEN RETURN NEW; END IF;\n  -- Timestamp first, before any early return")]),
  "R4_removed":            ("M1", "c12", [(R4_BLOCK, "")]),
  "R4_any_member":         ("M1", "c12",
                            [("       AND m.user_id IS NOT NULL\n       AND public.member_status_grants_access(m.license_status)\n  ) THEN\n    RAISE NOTICE",
                              "       AND m.user_id IS NOT NULL\n  ) THEN\n    RAISE NOTICE")]),
  "IDP_origin_any":        ("M1", "c03",
                            [("  SELECT COALESCE(p_provisioned_by IN ('jit', 'scim', 'directory_sync'), false);",
                              "  SELECT COALESCE(p_provisioned_by IN ('jit', 'scim', 'directory_sync', 'manual', 'invite'), false);")]),
  "W13_no_expires_col":    ("M1", "c16",
                            [("BEFORE INSERT OR UPDATE OF license_status, organization_id, invitation_expires_at, user_id, license_assigned_at",
                              "BEFORE INSERT OR UPDATE OF license_status, organization_id, user_id, license_assigned_at")]),
  "W13b_status_only_seat": ("M1", "c16", [(HOLDS, "    p_license_status IN ('active', 'pending'),")]),
  "Q4_guard_old_count":    ("M1", "c16b",
                            [("       WHERE m.organization_id = NEW.organization_id\n         AND public.member_row_holds_seat(m.license_status, m.invitation_expires_at, m.user_id);\n      IF v_used >= v_max_seats THEN",
                              "       WHERE m.organization_id = NEW.organization_id\n         AND m.license_status IN ('active', 'pending');\n      IF v_used >= v_max_seats THEN")]),
  "Q4_admin_invite_old_count": ("M1", "c16b",
                            [("        AND public.member_row_holds_seat(license_status, invitation_expires_at, user_id);\n\n      IF v_member_count >= v_max_seats THEN",
                              "        AND license_status IN ('active', 'pending');\n\n      IF v_member_count >= v_max_seats THEN")]),
  "Q4_expiry_strict":      ("M1", "c07",
                            [("p_invitation_expires_at >= now()", "p_invitation_expires_at > now() + interval '1 day'")]),
  "PERSONAL_not_skipped":  ("M1", "c02",
                            [("  IF v_personal IS DISTINCT FROM false THEN\n    RETURN NEW;  -- personal organization",
                              "  IF false THEN\n    RETURN NEW;  -- personal organization")]),
  "NOLIMIT_zero_counts":   ("M1", "c02",
                            [("  IF v_max_seats IS NULL OR v_max_seats <= 0 THEN\n    RETURN NEW;\n  END IF;\n\n  -- Counted after the lock",
                              "  IF v_max_seats IS NULL THEN\n    RETURN NEW;\n  END IF;\n\n  -- Counted after the lock")]),
  "R9_no_timestamp":       ("M1", "c02",
                            [("    ELSE\n      NEW.license_assigned_at := now();\n    END IF;", "    END IF;")]),
  "R9_not_cleared":        ("M1", "c02",
                            [("  ELSE\n    NEW.license_assigned_at := NULL;\n  END IF;\n\n  IF NOT public.member_row_holds_seat",
                              "  END IF;\n\n  IF NOT public.member_row_holds_seat")]),
  "R9_forgeable":          ("M1", "c02",
                            [("      NEW.license_assigned_at := OLD.license_assigned_at;", "      NULL;")]),
  # --- set_member_license ---
  "R10_broker_reactivate": ("M1", "c01",
                            [("     OR (p_action = 'reactivate' AND v_caller_role NOT IN ('admin', 'it_admin')) THEN",
                              "     OR (p_action = 'reactivate' AND v_caller_role NOT IN ('admin', 'it_admin', 'broker')) THEN")]),
  "RPC_caller_status_ignored": ("M1", "c01",
                            [("     AND m.user_id = v_uid\n     AND public.member_status_grants_access(m.license_status);",
                              "     AND m.user_id = v_uid;")]),
  "RPC_agent_allowed":     ("M1", "c01",
                            [("     OR v_caller_role NOT IN ('broker', 'admin', 'it_admin')\n", "     OR v_caller_role NOT IN ('broker', 'admin', 'it_admin', 'agent')\n")]),
  "RPC_own_row_allowed":   ("M1", "c01",
                            [("  IF v_target.user_id = v_uid THEN", "  IF false THEN")]),
  "RPC_it_admin_target_open": ("M1", "c01",
                            [("  IF v_target.role = 'it_admin' AND v_caller_role <> 'it_admin' THEN", "  IF false THEN")]),
  "RPC_pending_assignable":("M1", "c01",
                            [("  IF p_action = 'assign' AND v_target.license_status = 'unassigned' THEN",
                              "  IF p_action = 'assign' AND v_target.license_status IN ('unassigned', 'pending') THEN"),
                             ("  IF v_personal IS DISTINCT FROM false OR v_target.user_id IS NULL THEN",
                              "  IF v_personal IS DISTINCT FROM false THEN")]),
  "RPC_seat_error_swallowed": ("M1", "c11",
                            [("      RETURN jsonb_build_object('success', false, 'error', 'seat_limit_reached', 'action', p_action);",
                              "      RETURN jsonb_build_object('success', true, 'member_id', v_target.id, 'license_status', v_target.license_status);")]),
  "RPC_reactivate_any":    ("M1", "c01",
                            [("  ELSIF p_action = 'reactivate' AND public.member_status_is_deactivated(v_target.license_status) THEN",
                              "  ELSIF p_action = 'reactivate' THEN")]),
  "RPC_other_org_caller":  ("M1", "c01",
                            [("   WHERE m.organization_id = v_org_id\n     AND m.user_id = v_uid\n",
                              "   WHERE m.user_id = v_uid\n")]),
  # --- feature lookups ---
  "W4_gof_not_narrowed":   ("M1", "c05", [(GOF_GATE, GOF_GATE.replace("\n      AND public.member_status_grants_access(license_status)", ""))]),
  "W4b_cfa_not_narrowed":  ("M1", "c05", [(CFA_GATE, CFA_GATE.replace("\n      AND public.member_status_grants_access(license_status)", ""))]),
  # --- grants / catalog ---
  "W8_anon_exec_rpc":      ("M1", "c08",
                            [("REVOKE ALL ON FUNCTION public.set_member_license(uuid, text) FROM PUBLIC, anon;",
                              "REVOKE ALL ON FUNCTION public.set_member_license(uuid, text) FROM PUBLIC;\nGRANT EXECUTE ON FUNCTION public.set_member_license(uuid, text) TO anon;")]),
  "W8b_public_exec_helper":("M1", "c08",
                            [("REVOKE ALL ON FUNCTION public.member_row_holds_seat(text, timestamptz, uuid) FROM PUBLIC, anon;",
                              "REVOKE ALL ON FUNCTION public.member_row_holds_seat(text, timestamptz, uuid) FROM anon;")]),
  "W8c_trigger_fn_authenticated": ("M1", "c08",
                            [("REVOKE ALL ON FUNCTION public._enforce_member_seat_limit() FROM PUBLIC, anon, authenticated;",
                              "REVOKE ALL ON FUNCTION public._enforce_member_seat_limit() FROM PUBLIC, anon;")]),
  "CHECK_no_unassigned":   ("M1", "c08",
                            [("  CHECK (license_status IN ('pending', 'active', 'suspended', 'expired', 'unassigned'));",
                              "  CHECK (license_status IN ('pending', 'active', 'suspended', 'expired', 'unassigned', 'bogus'));")]),
  # --- M2 ---
  "W6_retire_not_extended":("M2", "m06",
                            [("  AFTER INSERT OR UPDATE OF user_id, organization_id, license_status ON public.organization_members",
                              "  AFTER INSERT OR UPDATE OF user_id, organization_id ON public.organization_members")]),
  "W6b_retire_no_skip":    ("M2", "m06",
                            [("  IF public.member_status_is_deactivated(NEW.license_status) THEN\n    RETURN NULL;\n  END IF;\n", "")]),
  "W7_ensure_active_only": ("M2", "m06",
                            [("      AND NOT public.member_status_is_deactivated(m.license_status)",
                              "      AND m.license_status = 'active'")]),
  "W7b_ensure_unchanged":  ("M2", "m06",
                            [("      AND NOT public.member_status_is_deactivated(m.license_status)\n", "")]),
  "REVERT_trigger_dropped":("M2", "m06",
                            [("CREATE TRIGGER revert_deactivated_member\n  AFTER UPDATE OF license_status ON public.organization_members\n  FOR EACH ROW\n  EXECUTE FUNCTION public._revert_deactivated_member_to_paygo();",
                              "")]),
  "R8_no_exception_guard": ("M2", "m13",
                            [(REVERT_GUARDED, "  PERFORM public._ensure_personal_organization_for(NEW.user_id);")]),
}

def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "list":
        frag = sys.argv[2] if len(sys.argv) > 2 else ""
        for name, (part, ctl, _) in MUTANTS.items():
            if frag and frag not in name:
                continue
            print(f"{name}|{part}|{ctl}")
        return 0
    if len(sys.argv) == 5 and sys.argv[1] == "apply":
        name, src, dst = sys.argv[2:5]
        if name not in MUTANTS:
            print(f"unknown mutant {name}", file=sys.stderr); return 2
        s = open(src).read()
        for old, new in MUTANTS[name][2]:
            c = s.count(old)
            if c != 1:
                print(f"INVALID|{name}|pattern matched {c} times: {old[:60]!r}", file=sys.stderr); return 1
            s = s.replace(old, new)
        open(dst, "w").write(s)
        print(f"MUTATION APPLIED|{name}|{len(MUTANTS[name][2])} edit(s)")
        return 0
    print(__doc__, file=sys.stderr); return 2

sys.exit(main())
