#!/usr/bin/env python3
"""BACKLOG-3986: compose one keepr-test call.  usage: compose.py <out.sql> <mode>
modes: baseline | file | twice | rollback | M1 | M2 | M3 | M4
  baseline  controls against the database as it is (no ALTER)
  file      the migration file, then the controls
  twice     the migration file applied twice (idempotency), then the controls
  rollback  the migration file, then the rollback file, then the controls
  M1..M4    the migration's ALTER POLICY statement ALONE, mutated, then the controls
            (the file's POSTCHECK is left out so the controls, not the POSTCHECK, are the detector)
Every mutation is an exact-string replace that exits non-zero when it matches nothing; the
mutated qual is read back from pg_policies and carried in the result ('mutation')."""
import pathlib, re, sys

here = pathlib.Path(__file__).resolve().parent
root = here.parents[2]
mig = (root / "supabase/migrations/20261116120000_backlog_3986_scim_policies_admin.sql").read_text()
rollback = (here / "rollback-scim-policies-admin.sql").read_text()
controls = (here / "controls-scim-policies.sql").read_text()
out, mode = sys.argv[1], sys.argv[2]

m = re.search(r'ALTER POLICY "IT admins can manage SCIM tokens".*?\)\)\);', mig, re.S)
alter = m.group(0)

MUT = {
    "M1": ("token_manager.role IN ('admin', 'it_admin')", "token_manager.role = 'it_admin'"),
    "M2": ("\n       AND public.member_status_grants_access(token_manager.license_status)", ""),
    "M3": ("token_manager.organization_id = scim_tokens.organization_id\n       AND ", ""),
    "M4": ("token_manager.role IN ('admin', 'it_admin')", "token_manager.role IN ('admin', 'it_admin', 'agent')"),
}

parts = ["BEGIN;", "set local pg_stat_statements.track = 'none';",
         "CREATE TEMP TABLE _p3986_mut (label text, qual text) ON COMMIT DROP;"]
if mode == "file":
    parts.append(mig)
elif mode == "twice":
    parts += [mig, mig]
elif mode == "rollback":
    parts += [mig, rollback]
elif mode in MUT:
    old, new = MUT[mode]
    if alter.count(old) != 1:
        sys.exit(f"MUTATION NOT APPLIED: {mode} pattern matched {alter.count(old)} times")
    mutated = alter.replace(old, new)
    assert mutated != alter
    print(f"MUTATION APPLIED {mode}:\n{mutated}")
    parts.append(mutated)
elif mode != "baseline":
    sys.exit(f"unknown mode {mode}")
parts.append(f"""INSERT INTO _p3986_mut SELECT '{mode}', qual FROM pg_policies
 WHERE schemaname = 'public' AND tablename = 'scim_tokens' AND policyname = 'IT admins can manage SCIM tokens';""")
parts.append(controls)
parts.append("ROLLBACK;  -- unreachable: the controls always raise")
pathlib.Path(out).write_text("\n".join(parts) + "\n")
