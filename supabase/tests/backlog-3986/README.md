# BACKLOG-3986: SCIM creates a brand-new person

Unit controls only (no database run): `tests/edge-functions/scimSeats.test.ts`,
describe `POST brand-new person (BACKLOG-3986)`, controls C1-C16 and C9b.

`ts_mutations.py` applies each mutation as an exact, once-only replacement in
`supabase/functions/scim/handlers/users.ts`, prints `MUTATION APPLIED` with the line, runs
the suite, fails on a zero test count, lists the tests that went red, and restores the
file from the text read before mutating.

```
python3 supabase/tests/backlog-3986/ts_mutations.py
```

Recorded run: `ts-mutations-2026-11-14.txt` (18 mutations, all red; restored suite 61/61).
