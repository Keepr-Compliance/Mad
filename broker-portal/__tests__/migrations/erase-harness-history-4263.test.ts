/**
 * BACKLOG-4263 — erase harness: the run history is cleared inside the call, the rollback's refusal on history is a
 * control, the reporter refuses an empty expectation table.
 *
 * supabase/tests/backlog-4263-sync2-erase/harness.py composes every call at run time (no generated file is committed),
 * so this pins the source text that composes it: the clearing statement and its place before the embedded E1
 * rollback, the guard first, the new control and its rollback-text mutant, the call-level history mutant, and the
 * reporter's refusal. `harness.py check` asserts the same on the composed text of every stage.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const DIR = join(__dirname, '../../../supabase/tests/backlog-4263-sync2-erase');
const read = (f: string): string => readFileSync(join(DIR, f), 'utf8').replace(/\r\n?/g, '\n');
const PY = read('harness.py');
const PROBES = read('lib/probes.sql');
const HELPERS = read('lib/helpers.sql');
const RB1 = read('rollback-20261123110000.sql');

describe('BACKLOG-4263 erase harness run history', () => {
  it('clears run and lease rows inside the call, before the embedded rollback, and reports the counts only', () => {
    const clear = PY.slice(PY.indexOf('CLEAR_HISTORY = """'), PY.indexOf('$hist4263e$;"""'));
    expect(clear).toContain('DELETE FROM public.cloud_blob_erase_leases;');
    expect(clear).toContain('DELETE FROM public.cloud_blob_erase_runs;');
    expect(clear).toContain("INSERT INTO pg_temp.p4263e_out VALUES ('history_cleared', jsonb_build_object('runs', nr, 'leases', nl)::text);");
    expect(PY).toContain("head.append(SEED_HISTORY if stage == 'history_mutant' else CLEAR_HISTORY)");
    expect(PY).toContain('parts = head + [RB3, RB1, E1, HL, PR]');
    // the guard is the first statement of every call, then the timeouts
    expect(PY).toMatch(/head = \[GUARD\.replace\('__GUARD__', guard\), "SET LOCAL pg_stat_statements\.track = 'none';", "SET LOCAL lock_timeout = '3s';",/);
  });

  it('the new control is in the controls list and asserts the rollback text, not a count', () => {
    expect(PY).toContain("'p_rollback_refuses_history(%s, %s)' % (q(RB3), q(RB1))]");
    const fn = PROBES.slice(PROBES.indexOf('CREATE FUNCTION pg_temp.p_rollback_refuses_history('));
    expect(fn).toContain("IF t NOT LIKE 'ROLLBACK 20261123110000: public.cloud_blob_erase_runs holds % rows (the erase job''s run history); keep a copy, then delete them first' THEN");
    expect(fn).toContain("DELETE FROM public.cloud_blob_erase_runs x WHERE x.counts ->> 'p4263e' = '__RUN__';");
    expect(fn).toContain("RETURN 'FAIL refused with the run row gone: '");
    // the asserted text is the rollback's own
    expect(RB1).toContain("RAISE EXCEPTION 'ROLLBACK 20261123110000: public.cloud_blob_erase_runs holds % rows (the erase job''s run history); keep a copy, then delete them first', n;");
  });

  it('the two new mutants exist: the rollback check neutralised (control level) and the clearing left out (call level)', () => {
    expect(PY).toContain("m.append(rb_mutant('RB1_history_check_dropped', [(\"  IF n > 0 THEN\\n    RAISE EXCEPTION 'ROLLBACK 20261123110000: public.cloud_blob_erase_runs holds % rows\",");
    expect(PY).toMatch(/^ {4}m\.append\(rb_mutant\('RB1_history_check_dropped', /m);
    expect(PY).toContain("'mutants': ['M_Invoke_without_url_check', 'M_Invoke_granted_service_role', 'M_RB1_history_check_dropped']}");
    expect(PY).toContain("v := pg_temp.p_rollback_refuses_history(%s, %s);");
    expect(PY).toContain("IF md5(%s) IS DISTINCT FROM %s THEN\\n      v := 'NOT APPLIED IN DB';");
    expect(PY).toContain('HISTORY_REFUSAL = "ROLLBACK 20261123110000: public.cloud_blob_erase_runs holds "');
    expect(PY).toContain("caught = HISTORY_REFUSAL in msg and 'P4263E_RESULT' not in msg");
  });

  it('the reporter refuses an empty expectation table and the selftest has its negative control', () => {
    expect(PY).toMatch(/if not WANT:\n {8}out\('NOT OK: the expectation table is empty/);
    expect(PY).toContain('return 4');
    expect(PY).toContain("sys.exit(selftest(green_ok='--control-green-ok' in a))");
    expect(PY).toContain("mutants()  # the expectation table");
  });

  it('listing assertions say PRECONDITION when the database leaves no room, and the dry-run count is scoped', () => {
    expect(HELPERS).toContain('CREATE FUNCTION pg_temp.room() RETURNS text');
    expect((PROBES.match(/IF pg_temp\.room\(\) IS NOT NULL THEN RETURN pg_temp\.room\(\); END IF;/g) ?? []).length).toBe(3);
    expect(PROBES).toContain("IF (SELECT count(*) FROM public.cloud_blob_erase_runs x WHERE NOT (x.id = ANY (runs_before))) <> 1 THEN");
    expect(PROBES).not.toContain('SELECT count(*) INTO runs_before FROM public.cloud_blob_erase_runs');
  });
});
