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
    // a refusal counts only as the database's own error (P0001) with the rollback's text
    expect(PY).toContain("caught = ('P0001: ' + HISTORY_REFUSAL) in msg and 'P4263E_RESULT' not in msg");
  });

  it('the reporter refuses an empty expectation table and the selftest has its negative control', () => {
    expect(PY).toMatch(/if not WANT:\n {8}out\('NOT OK: the expectation table is empty/);
    expect(PY).toContain('return 4');
    expect(PY).toContain("sys.exit(selftest(green_ok='--control-green-ok' in a))");
    expect(PY).toContain("mutants()  # the expectation table");
  });

  it('listing assertions say PRECONDITION when the database leaves no room, and the dry-run count is scoped', () => {
    expect(HELPERS).toContain('CREATE FUNCTION pg_temp.room(kind text) RETURNS text');
    for (const k of ['listing', 'rows', 'owners']) expect(HELPERS).toContain(`WHEN kind = '${k}' AND`);
    // listing: c6a, c6b, c6e, c6f; owners: c6f, p_owners; rows: c6d; p_dry_run: rows and listing
    expect((PROBES.match(/IF pg_temp\.room\('listing'\) IS NOT NULL THEN RETURN pg_temp\.room\('listing'\); END IF;/g) ?? []).length).toBe(4);
    expect((PROBES.match(/IF pg_temp\.room\('owners'\) IS NOT NULL THEN RETURN pg_temp\.room\('owners'\); END IF;/g) ?? []).length).toBe(2);
    expect(PROBES).toContain("IF pg_temp.room('rows') IS NOT NULL THEN RETURN pg_temp.room('rows'); END IF;");
    expect(PROBES).toContain("IF coalesce(pg_temp.room('rows'), pg_temp.room('listing')) IS NOT NULL THEN");
    expect(PROBES).toContain("IF (SELECT count(*) FROM public.cloud_blob_erase_runs x WHERE NOT (x.id = ANY (runs_before))) <> 1 THEN");
    expect(PROBES).not.toContain('SELECT count(*) INTO runs_before FROM public.cloud_blob_erase_runs');
  });

  it('every call ends in its one final RAISE (otherwise it commits), checked by harness.py check', () => {
    // the final block is the last part appended, then the parts are joined: nothing can follow it
    const fin = "    parts.append(\"DO $fin4263e$ BEGIN RAISE EXCEPTION '%s %%', (SELECT jsonb_object_agg(k, v) FROM pg_temp.p4263e_out); END $fin4263e$;\" % marker)\n    text = '\\n'.join(parts)";
    expect(PY).toContain(fin);
    expect(PY).toContain("probs += ends_in_raise(compose({'stage': st}, run='0' * 24), st)");
    expect(PY).toContain('if len(fins) != 1 or st[-1] is not fins[0]:');
    expect(PY).toContain('(COMMIT|END|ROLLBACK|ABORT|BEGIN|START');
  });

  it('the clearing locks both tables, runs then leases, before its first DELETE; the history mutant seeds its row', () => {
    const clear = PY.slice(PY.indexOf('CLEAR_HISTORY = """'), PY.indexOf('$hist4263e$;"""'));
    const lock = clear.indexOf('LOCK TABLE public.cloud_blob_erase_runs, public.cloud_blob_erase_leases IN ACCESS EXCLUSIVE MODE;');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(clear.indexOf('DELETE FROM'));
    const seed = PY.slice(PY.indexOf('SEED_HISTORY = """'), PY.indexOf('$seed4263e$;"""'));
    expect(seed).toContain("INSERT INTO public.cloud_blob_erase_runs (mode, counts) VALUES ('live', jsonb_build_object('p4263e', '__RUN__'));");
    expect(PROBES).toContain("IF t NOT LIKE 'ROLLBACK 20261123110000: public.cloud_blob_erase_runs holds 1 rows %' THEN");
  });
});
