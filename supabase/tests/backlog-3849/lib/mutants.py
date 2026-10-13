#!/usr/bin/env python3
"""BACKLOG-3849 mutants of migration A (S4 controls).

Each mutant is a list of (old, new) edits; `apply` exits 1 unless every `old`
occurs exactly once. A mutant that did not apply is never counted.

usage: mutants.py list                  -> name|target controls
       mutants.py apply <name> <src> <out>
       mutants.py classify < status-lines
classify: INVALID (any ERROR or no line), KILLED (>=1 FAIL), SURVIVED (all PASS).
"""
import sys

WHITELIST = ("  IF p_target IS NULL OR p_target NOT IN ('live', 'test') THEN\n"
             "    RAISE EXCEPTION 'billing_drain_invoke: target must be live or test' USING ERRCODE = '22023';\n"
             "  END IF;\n")
ROLE_CHECK = ("  IF auth.role() IS DISTINCT FROM 'service_role' THEN\n"
              "    RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501';\n"
              "  END IF;\n")

MUTANTS = {
    # R1: service_role keeps the default-ACL EXECUTE on the invoker.
    "invoke-revoke-misses-service-role": (
        [("REVOKE ALL ON FUNCTION public.billing_drain_invoke(text) FROM PUBLIC, anon, authenticated, service_role;",
          "REVOKE ALL ON FUNCTION public.billing_drain_invoke(text) FROM PUBLIC, anon, authenticated;")],
        "s4a s4c"),
    # R1: no whitelist -> any vault name billing_drain_url_<anything> is looked up.
    "invoke-no-target-whitelist": ([(WHITELIST, "")], "s4c"),
    # R1: whitelist checked only after the "not configured" check.
    # (Placed between the vault reads and that check it is an EQUIVALENT mutant:
    # same SQLSTATE, nothing posted. Measured 2026-10-13, recorded on BACKLOG-3849.)
    "invoke-whitelist-after-config-check": (
        [(WHITELIST, ""),
         ("  RETURN net.http_post(\n", WHITELIST + "  RETURN net.http_post(\n")],
        "s4c"),
    # The accessor relies on grants alone.
    "secret-no-role-check": ([(ROLE_CHECK, "")], "s4b"),
    # authenticated keeps the default-ACL EXECUTE on the accessor.
    "secret-revoke-misses-authenticated": (
        [("REVOKE ALL ON FUNCTION public.billing_drain_secret() FROM PUBLIC, anon, authenticated;",
          "REVOKE ALL ON FUNCTION public.billing_drain_secret() FROM PUBLIC, anon;")],
        "s4a s4b"),
    # The secret regenerated on every apply.
    "secret-regenerated": (
        [("  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'billing_drain_secret') THEN\n",
          "  DELETE FROM vault.secrets WHERE name = 'billing_drain_secret';\n  IF true THEN\n")],
        "s4b"),
    # Wrong header name on the request.
    "invoke-wrong-header": (
        [("'x-billing-drain-secret', v_secret", "'x-webhook-secret', v_secret")], "s4c"),
}


def main() -> int:
    cmd = sys.argv[1]
    if cmd == "list":
        for name, (_, targets) in MUTANTS.items():
            print(f"{name}|{targets}")
        return 0
    if cmd == "apply":
        name, src, out = sys.argv[2], sys.argv[3], sys.argv[4]
        text = open(src).read()
        for old, new in MUTANTS[name][0]:
            n = text.count(old)
            if n != 1:
                print(f"mutant {name}: pattern found {n} times, expected 1", file=sys.stderr)
                return 1
            text = text.replace(old, new)
        open(out, "w").write(text)
        return 0
    if cmd == "classify":
        lines = [l.strip() for l in sys.stdin if l.strip()]
        if not lines or any(l.startswith("ERROR|") for l in lines):
            print("INVALID")
        elif any(l.startswith("FAIL|") for l in lines):
            print("KILLED")
        else:
            print("SURVIVED")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
