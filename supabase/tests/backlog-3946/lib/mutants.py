# BACKLOG-3946 mutants: each is a plausible wrong version of migration A, B or C.
# Exact-string replace; the pattern must match exactly once or the mutant is INVALID.
#   python3 mutants.py list                      -> name|A|B|C
#   python3 mutants.py apply <name> <src> <out>  -> prints MUTATION APPLIED <name>
import sys
MUT = {
 "mA1-hir-guard-dropped": ("A", "    WHERE user_id = check_user_id\n      AND check_user_id = (SELECT auth.uid())\n  );", "    WHERE user_id = check_user_id\n  );"),
 "mA2-hp-guard-dropped": ("A", "    AND check_user_id = (SELECT auth.uid())\n    AND ap.key = required_permission", "    AND ap.key = required_permission"),
 "mA3-hap-guard-dropped": ("A", "      AND check_user_id = (SELECT auth.uid())\n      AND ap.key = ANY(permission_keys)", "      AND ap.key = ANY(permission_keys)"),
 "mA4-isa-guard-dropped": ("A", "AND check_user_id = (SELECT auth.uid()) AND ar.is_system", "AND ar.is_system"),
 "mA5-gup-guard-dropped": ("A", "  WHERE ir.user_id = check_user_id\n    AND check_user_id = (SELECT auth.uid());", "  WHERE ir.user_id = check_user_id;"),
 "mA6-hir-guard-not-null": ("A", "    WHERE user_id = check_user_id\n      AND check_user_id = (SELECT auth.uid())\n  );", "    WHERE user_id = check_user_id\n      AND (SELECT auth.uid()) IS NOT NULL\n  );"),
 "mA7-hir-param-ignored": ("A", "    WHERE user_id = check_user_id\n      AND check_user_id = (SELECT auth.uid())\n  );", "    WHERE user_id = (SELECT auth.uid())\n  );"),
 "mA8-hp-param-ignored": ("A", "    WHERE ir.user_id = check_user_id\n    AND check_user_id = (SELECT auth.uid())\n    AND ap.key = required_permission", "    WHERE ir.user_id = (SELECT auth.uid())\n    AND ap.key = required_permission"),
 "mA9-gup-param-ignored": ("A", "  WHERE ir.user_id = check_user_id\n    AND check_user_id = (SELECT auth.uid());", "  WHERE ir.user_id = (SELECT auth.uid());"),
 "mA10-isa-param-ignored": ("A", "WHERE ir.user_id = check_user_id AND check_user_id = (SELECT auth.uid()) AND ar.is_system", "WHERE ir.user_id = (SELECT auth.uid()) AND ar.is_system"),
 "mB1-hir-revoke-dropped": ("B", "REVOKE EXECUTE ON FUNCTION public.has_internal_role(uuid) FROM PUBLIC, anon;\n", ""),
 "mB2-hir-revoke-anon-only": ("B", "public.has_internal_role(uuid) FROM PUBLIC, anon;", "public.has_internal_role(uuid) FROM anon;"),
 "mB3-internal_roles-policy-not-moved": ("B", 'ALTER POLICY "Super admins can manage internal roles" ON public.internal_roles TO authenticated;\n', ""),
 "mB4-users-policy-not-moved": ("B", "ALTER POLICY users_select_public ON public.users TO authenticated;\n", ""),
 "mB5-om-all-not-moved": ("B", "ALTER POLICY organization_members_all_public ON public.organization_members TO authenticated;\n", ""),
 "mB6-isa-revoke-dropped": ("B", "REVOKE EXECUTE ON FUNCTION public.is_super_admin(uuid) FROM PUBLIC, anon;\n", ""),
 "mC1-anon-revoke-dropped": ("C", "REVOKE ALL ON TABLE public.support_ticket_backlog_links FROM anon;\n", ""),
 "mC2-authenticated-revoke-all": ("C", "REVOKE UPDATE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.support_ticket_backlog_links FROM authenticated;", "REVOKE ALL ON TABLE public.support_ticket_backlog_links FROM authenticated;"),
 "mC3-anon-writes-only": ("C", "REVOKE ALL ON TABLE public.support_ticket_backlog_links FROM anon;", "REVOKE INSERT, UPDATE, DELETE ON TABLE public.support_ticket_backlog_links FROM anon;"),
 "mC4-authenticated-untouched": ("C", "REVOKE UPDATE, REFERENCES, TRIGGER, TRUNCATE ON TABLE public.support_ticket_backlog_links FROM authenticated;\n", ""),
 "mS1-hir-invoker-no-guard": ("A", "STABLE SECURITY DEFINER\n SET search_path TO 'public'\nAS $function$\n  SELECT EXISTS (\n    SELECT 1 FROM public.internal_roles\n    WHERE user_id = check_user_id\n      AND check_user_id = (SELECT auth.uid())\n  );", "STABLE SECURITY INVOKER\n SET search_path TO 'public'\nAS $function$\n  SELECT EXISTS (\n    SELECT 1 FROM public.internal_roles\n    WHERE user_id = check_user_id\n  );"),
 "mS2-gup-definer-dropped": ("A", " RETURNS TABLE(key text)\n LANGUAGE sql\n STABLE SECURITY DEFINER", " RETURNS TABLE(key text)\n LANGUAGE sql\n STABLE"),
 "mS3-hp-service-role-exemption": ("A", "    AND check_user_id = (SELECT auth.uid())\n    AND ap.key = required_permission", "    AND (check_user_id = (SELECT auth.uid()) OR (SELECT auth.role()) = 'service_role')\n    AND ap.key = required_permission"),
 "mS4-hir-service-role-exemption": ("A", "    WHERE user_id = check_user_id\n      AND check_user_id = (SELECT auth.uid())\n  );", "    WHERE user_id = check_user_id\n      AND (check_user_id = (SELECT auth.uid()) OR (SELECT auth.role()) = 'service_role')\n  );"),
 "mS5-hap-service-role-exemption": ("A", "      AND check_user_id = (SELECT auth.uid())\n      AND ap.key = ANY(permission_keys)", "      AND (check_user_id = (SELECT auth.uid()) OR (SELECT auth.role()) = 'service_role')\n      AND ap.key = ANY(permission_keys)"),
 "mS6-isa-service-role-exemption": ("A", "AND check_user_id = (SELECT auth.uid()) AND ar.is_system", "AND (check_user_id = (SELECT auth.uid()) OR (SELECT auth.role()) = 'service_role') AND ar.is_system"),
 "mS7-gup-service-role-exemption": ("A", "  WHERE ir.user_id = check_user_id\n    AND check_user_id = (SELECT auth.uid());", "  WHERE ir.user_id = check_user_id\n    AND (check_user_id = (SELECT auth.uid()) OR (SELECT auth.role()) = 'service_role');"),
}
if sys.argv[1] == "list":
    for k, (f, _, _) in MUT.items(): print(k + "|" + f)
else:
    name, src, out = sys.argv[2], sys.argv[3], sys.argv[4]; f, old, new = MUT[name]
    s = open(src).read(); n = s.count(old)
    if n != 1: raise SystemExit(f"MUTATION NOT APPLIED {name}: pattern count={n}")
    open(out, "w").write(s.replace(old, new)); print(f"MUTATION APPLIED {name}")
