#!/usr/bin/env python3
"""BACKLOG-4219 PR2 parity: the desktop builder's REAL output through keepr-test's real submit.

Reads electron/services/learn/__tests__/fixtures/pilotReport-real-4219.json (written by
pilotReport-4219.test.ts from runBaseline0 + scoreRunWithDetector + buildPilotReport), then, in ONE
keepr-test transaction ending in RAISE (nothing persists): a fixture user in a fixture org with
autodetect_eval on calls learn_pilot_report_submit(report) as `authenticated`, the stored row is read
back, learn_pilot_report_withdraw() is called, the rows are counted again.

usage: parity-pr2.py [--extra-key]     (--extra-key = negative control: one unknown top-level key)
keepr-test ONLY (kt-sql refuses the production ref). Prints the P4219_PR2_PARITY json.
"""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
FIXTURE = os.path.join(REPO, "electron/services/learn/__tests__/fixtures/pilotReport-real-4219.json")

report = json.load(open(FIXTURE))["report"]
if "--extra-key" in sys.argv:
    report = {"earliest_day": 3, **report}
payload = json.dumps(report, separators=(",", ":"))
assert "$pj$" not in payload

SQL = """DO $drv$
DECLARE
  u uuid := '00000000-0000-4219-8000-000000000201';
  o uuid := '00000000-0000-4219-8000-000000000231';
  pl uuid := (SELECT id FROM public.plans WHERE name = 'Team');
  rep jsonb := $pj$__PAYLOAD__$pj$::jsonb;
  invalid text; sub text; wd text; allowed text;
  rows_after_submit int; stored_version bigint; stored_equal boolean; rows_after_withdraw int;
BEGIN
  invalid := public._learn_pilot_report_invalid(rep);
  INSERT INTO auth.users (id, email, aud, role, instance_id, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (u, 'p4219-pr2@example.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', '{"provider":"email"}', '{}', now(), now());
  INSERT INTO public.users (id, email, oauth_provider, oauth_id, display_name)
    VALUES (u, 'p4219-pr2@example.test', 'email', u::text, 'P4219 PR2 user') ON CONFLICT (id) DO NOTHING;
  SET LOCAL session_replication_role = replica;
  INSERT INTO public.organizations (id, name, slug) VALUES (o, 'P4219 PR2', 'p4219-pr2');
  INSERT INTO public.organization_members (organization_id, user_id, role, license_status, created_at) VALUES (o, u, 'agent', 'active', now());
  INSERT INTO public.organization_plans (organization_id, plan_id, feature_overrides) VALUES (o, pl, '{"autodetect_eval":{"enabled":true}}');
  SET LOCAL session_replication_role = origin;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', u::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
  allowed := (public.check_feature_access(o, 'autodetect_eval') ->> 'allowed');
  BEGIN
    PERFORM public.learn_pilot_report_submit(rep);
    sub := 'accepted';
  EXCEPTION WHEN OTHERS THEN
    sub := 'ERR ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  SELECT count(*), max(sender_rules_version), bool_and(report = rep) INTO rows_after_submit, stored_version, stored_equal
    FROM public.learn_pilot_reports WHERE user_id = u;
  SET LOCAL ROLE authenticated;
  BEGIN
    wd := public.learn_pilot_report_withdraw()::text;
  EXCEPTION WHEN OTHERS THEN
    wd := 'ERR ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  SELECT count(*) INTO rows_after_withdraw FROM public.learn_pilot_reports WHERE user_id = u;
  RAISE EXCEPTION 'P4219_PR2_PARITY %', json_build_object(
    'validator', coalesce(invalid, 'VALID'), 'feature_allowed', allowed, 'submit', sub,
    'rows_after_submit', rows_after_submit, 'stored_sender_rules_version', stored_version,
    'stored_report_equals_payload', stored_equal, 'withdraw_returned', wd, 'rows_after_withdraw', rows_after_withdraw);
END
$drv$;
""".replace("__PAYLOAD__", payload)

with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
    f.write(SQL)
out = subprocess.run([os.path.expanduser("~/.claude/bin/kt-sql"), f.name], capture_output=True, text=True)
os.unlink(f.name)
m = re.search(r"P4219_PR2_PARITY (\{.*?\})", (out.stdout + out.stderr).replace('\\"', '"'))
print(m.group(1) if m else (out.stdout + out.stderr)[-800:])
