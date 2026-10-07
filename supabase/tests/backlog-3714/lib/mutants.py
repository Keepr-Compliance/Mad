#!/usr/bin/env python3
"""BACKLOG-3714 mutants.

Each mutant is a list of exact-string replacements on the migration ("edit")
or on the rollback file ("rbedit"). `apply` raises unless every pattern occurs
exactly once, so a mutant that did not apply can never be counted.

Mutants whose name starts with "x" are MEASUREMENTS: run and reported, never
counted as killed or survived (m03: whether the invite upsert needs `id` in
the grant; `id` stays granted either way).

usage: mutants.py list
       mutants.py apply <name> <migration> <rollback> <out-migration> <out-rollback>
       mutants.py classify < status-lines

classify reads the PASS|/FAIL|/ERROR| lines of every target control run
against one mutant and prints its verdict:
  INVALID   any ERROR line, or no status line at all: the run proved nothing
  KILLED    no ERROR and at least one FAIL: a control's assertion saw the mutant
  SURVIVED  only PASS lines
"""
import sys

LOCKED = ("subscription_tier, subscription_status, trial_ends_at, subscription_started_at, "
          "status, is_active, created_at, login_count, signup_source, do_not_sell_data, "
          "ccpa_opt_out_date, scim_external_id, provisioning_source, is_managed, suspended_at, "
          "suspension_reason, sso_only, last_sso_login_at, last_sso_provider, jit_provisioned, "
          "jit_provisioned_at, idp_claims, current_onboarding_step")

MUTANTS = {
    # name: ([(kind, old, new), ...], target controls)
    # The most likely wrong fix: a column-level REVOKE while the table-level
    # grant stands (Postgres then changes nothing).
    "m01-column-revoke-only": (
        [("edit",
          "REVOKE UPDATE ON TABLE public.users FROM PUBLIC, anon, authenticated;\n",
          f"REVOKE UPDATE ({LOCKED}) ON public.users FROM authenticated;\n")],
        "c2-apply c3-authenticated"),
    "m02-no-onboarding-completed-at": (
        [("edit", "  onboarding_completed_at,\n", "")],
        "c3-authenticated c5-3673-intact"),
    "x03-no-id": (
        [("edit", "  id,\n", "")],
        "c3-authenticated"),
    "m04-subscription-status-granted": (
        [("edit", "  oauth_id\n) ON public.users", "  oauth_id,\n  subscription_status\n) ON public.users")],
        "c2-apply c3-authenticated"),
    "m05-revoke-authenticated-only": (
        [("edit", "FROM PUBLIC, anon, authenticated;\n", "FROM authenticated;\n")],
        "c2-apply c3b-anon"),
    "m06-no-grant-back": (
        [("edit", "GRANT UPDATE (\n", "REVOKE UPDATE (\n"),
         ("edit", ") ON public.users TO authenticated;\n", ") ON public.users FROM authenticated;\n")],
        "c3-authenticated c5-3673-intact"),
    "m07-grant-to-public": (
        [("edit", ") ON public.users TO authenticated;\n", ") ON public.users TO PUBLIC;\n")],
        "c2-apply"),
    "r01-rollback-keeps-column-grants": (
        [("rbedit",
          "REVOKE UPDATE (id, email, first_name, last_name, display_name, avatar_url, last_login_at, "
          "updated_at, terms_accepted_at, terms_version_accepted, privacy_policy_accepted_at, "
          "privacy_policy_version_accepted, email_onboarding_completed_at, onboarding_completed_at, "
          "oauth_provider, oauth_id) ON public.users FROM authenticated;\n",
          "")],
        "c7-rollback"),
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
    edits, _targets = MUTANTS[name]
    srcs = {"edit": open(mig).read(), "rbedit": open(rb).read()}
    for kind, a, b in edits:
        n = srcs[kind].count(a)
        if n != 1:
            raise SystemExit(f"mutant {name}: pattern occurs {n} times (need exactly 1): {a[:60]!r}")
        srcs[kind] = srcs[kind].replace(a, b)
    open(out_mig, "w").write(srcs["edit"])
    open(out_rb, "w").write(srcs["rbedit"])


if __name__ == "__main__":
    main()
