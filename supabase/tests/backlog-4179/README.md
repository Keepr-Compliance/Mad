# BACKLOG-4179 harness (keepr-test only, via ~/.claude/bin/kt-sql)

| File | What |
|---|---|
| `controls.sql` | G1, G2, G4, G6, R1 (replica bypass), C1 (catalog). One call, always ends in RAISE. |
| `compose.py` | Builds migration + controls for a mode: `base`, `M_active_only`, `M_insert_only`, `M_org_exclusion`, `M_no_retire`, `G7`, `live`; `M_no_lock` with `--mig-only`. |
| `run.sh` | `bash run.sh base M_active_only ...` prints one result line per mode. |
| `concurrency.sh` | G3 + G5: two concurrent kt-sql backends against the COMMITTED guard; committed fixtures removed at the end. `bash concurrency.sh [base|M_no_lock]`. |
| `ts_mutations.py` | TS controls T1-T4 (route + SCIM mapping, both helpers). |
| `rollback-4179.sql` | Drops the trigger, the function and the ledger row. |
| `results-2026-11-12.txt` | Recorded runs. |
