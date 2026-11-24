/**
 * BACKLOG-4263 (sync plan P3) — CI tripwire for the cloud blob erase migrations.
 *
 * WHAT THIS CAN PROVE: what the migration files, the rollback files and config.toml say. CI has no database.
 * Behaviour is proved on the test project by supabase/tests/backlog-4263-sync2-erase (harness.py, controls and
 * mutants). This file pins the lines a later edit is most likely to drop or loosen.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8').replace(/\r\n?/g, '\n');
const statements = (raw: string): string =>
  raw.split('\n').map((l) => l.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ').trim();

const E1_RAW = read('supabase/migrations/20261123110000_backlog_4263_cloud_blob_erase.sql');
const E1 = statements(E1_RAW);
const E3 = statements(read('supabase/migrations/20261123120000_backlog_4263_cloud_blob_erase_schedule.sql'));
const RB1 = statements(read('supabase/tests/backlog-4263-sync2-erase/rollback-20261123110000.sql'));
const RB3 = statements(read('supabase/tests/backlog-4263-sync2-erase/rollback-20261123120000.sql'));
const CONFIG = read('supabase/config.toml');

function fnBody(name: string): string {
  const start = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const s = E1.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(E1.indexOf(start, s + 1)).toBe(-1);
  const open = E1.indexOf('AS $f$', s) + 6;
  return E1.slice(open, E1.indexOf('$f$;', open));
}
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe('BACKLOG-4263 cloud blob erase migration (E1)', () => {
  it('refuses to apply before 20261123100000', () => {
    expect(E1).toContain("RAISE EXCEPTION 'BACKLOG-4263 E1: apply 20261123100000 first'");
    for (const col of ["a.attname = 'one_computer'", "a.attname = 'active_install_id'", "a.attname = 'active_since'"]) {
      expect(E1).toContain(col);
    }
  });

  it('creates the secret in the database and never seeds the URL (ruling 1)', () => {
    expect(E1).toContain("IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cloud_blob_erase_secret') THEN");
    expect(E1).toContain("encode(extensions.gen_random_bytes(32), 'hex')");
    expect(count(E1, 'vault.create_secret(')).toBe(1);
    expect(E1_RAW).not.toMatch(/https?:\/\//);
    expect(E1_RAW).not.toMatch(/supabase\.co/);
  });

  it('invoke refuses when the URL secret is absent, and has no API role', () => {
    const body = fnBody('cloud_blob_erase_invoke');
    expect(body).toContain("WHERE s.name = 'cloud_blob_erase_url'");
    expect(body).toContain("IF v_url IS NULL OR btrim(v_url) = '' THEN");
    expect(body).toContain("USING ERRCODE = '55000'");
    expect(body).toContain('timeout_milliseconds := 150000');
    expect(E1).toContain('REVOKE ALL ON FUNCTION public.cloud_blob_erase_invoke() FROM PUBLIC, anon, authenticated, service_role;');
    expect(E1).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.cloud_blob_erase_invoke\(\)/);
    expect(E1).toMatch(/CREATE OR REPLACE FUNCTION public\.cloud_blob_erase_invoke\(\) RETURNS bigint LANGUAGE plpgsql VOLATILE SET search_path = '' AS/);
  });

  it('every DEFINER function checks the service role in its body and is granted to service_role only', () => {
    const sigs: Record<string, string> = {
      cloud_blob_erase_secret: '',
      cloud_blob_erase_claim: 'boolean, integer, integer',
      cloud_blob_erase_finish: 'uuid, uuid[], jsonb, text',
      cloud_blob_erase_scrub: 'uuid, uuid, boolean, integer',
      cloud_blob_erase_note: 'uuid, jsonb, text',
    };
    for (const [fn, sig] of Object.entries(sigs)) {
      expect(fnBody(fn)).toContain("IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role only' USING ERRCODE = '42501'");
      expect(E1).toContain(`REVOKE ALL ON FUNCTION public.${fn}(${sig}) FROM PUBLIC, anon, authenticated, service_role;`);
      expect(E1).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(${sig}) TO service_role;`);
    }
    expect(count(E1, 'GRANT EXECUTE ON FUNCTION')).toBe(5);
    expect(E1).not.toMatch(/GRANT [^;]+ TO [^;]*\b(anon|authenticated|PUBLIC)\b/);
  });

  it('new tables: RLS on, every API role revoked, TRUNCATE revoked, no policy', () => {
    for (const t of ['cloud_blob_erase_runs', 'cloud_blob_erase_leases']) {
      expect(E1).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(E1).toContain(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated, service_role;`);
      expect(E1).toContain(`REVOKE TRUNCATE ON TABLE public.${t} FROM anon, authenticated;`);
    }
    expect(E1).not.toMatch(/CREATE POLICY|GRANT [A-Z, ]+ ON TABLE/);
  });

  it('claim: dry run writes nothing but its run row; every write sits in the live arm', () => {
    const body = fnBody('cloud_blob_erase_claim');
    expect(E1).toContain('p_dry_run boolean DEFAULT true');
    const live = body.indexOf('ELSE DELETE FROM public.cloud_blob_erase_runs WHERE started_at');
    const dry = body.indexOf('IF p_dry_run THEN');
    const end = body.indexOf('SELECT coalesce(jsonb_agg(o.user_id');
    expect(dry).toBeGreaterThan(0);
    expect(live).toBeGreaterThan(dry);
    const dryArm = body.slice(dry, live);
    expect(dryArm).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b|_cloud_fence_unreferenced|FOR UPDATE/);
    const liveArm = body.slice(live, end);
    for (const w of ['DELETE FROM public.cloud_deal_messages', 'DELETE FROM public.cloud_deal_files', 'UPDATE public.cloud_deal_files',
                     'INSERT INTO public.cloud_blob_erase_leases', '_cloud_fence_unreferenced']) {
      expect(liveArm).toContain(w);
    }
    const tail = body.slice(end);
    expect(tail).not.toMatch(/\bDELETE\b|\bINSERT\b|_cloud_fence_unreferenced/);
    expect(count(tail, 'UPDATE ')).toBe(1);
    expect(tail).toContain('UPDATE public.cloud_blob_erase_runs SET counts = v_counts WHERE id = v_run;');
  });

  it('claim: 24 h age on every arm; the orphan sweep fences only through _cloud_fence_unreferenced (lock, then check)', () => {
    const body = fnBody('cloud_blob_erase_claim');
    expect(body).toContain("v_cut timestamptz := now() - interval '24 hours';");
    expect(body).toContain('WHERE m.removed_at < v_cut');
    expect(body).toContain('WHERE x.removed_at < v_cut');
    expect(body).toContain('greatest(x.created_at, coalesce(x.uploaded_at, x.created_at)) < v_cut');
    expect(body).toContain("WHERE o.bucket_id = 'cloud-deal-files' AND o.created_at < v_cut");
    expect(body).toContain('v_n_orphan := v_n_orphan + public._cloud_fence_unreferenced(r.owner, r.ids);');
    expect(body).not.toMatch(/UPDATE public\.cloud_blobs/);
    expect(body).not.toMatch(/removed_at IS NOT NULL/);
    // the helper still locks first and checks references in a later statement (M1)
    const m1 = statements(read('supabase/migrations/20261112190000_backlog_4236_cloud_autosave_schema.sql'));
    expect(m1).toContain('ORDER BY b.id FOR UPDATE; UPDATE public.cloud_blobs b SET purge_requested_at = now()');
    expect(m1).toContain("IF auth.uid() IS DISTINCT FROM p_owner AND auth.role() IS DISTINCT FROM 'service_role' THEN");
  });

  it('claim: a message row is hard-deleted only after its live file rows are removed and their blobs fenced', () => {
    const body = fnBody('cloud_blob_erase_claim');
    const tomb = body.indexOf('filename = NULL, blob_id = NULL');
    const del = body.indexOf('DELETE FROM public.cloud_deal_messages m WHERE m.id = ANY (v_msg) AND m.removed_at < v_cut;');
    expect(tomb).toBeGreaterThan(0);
    expect(del).toBeGreaterThan(tomb);
    expect(body).toContain('WHERE x.cloud_message_id = ANY (v_msg) AND x.removed_at IS NULL');
    expect(body.slice(tomb, del)).toContain('public._cloud_fence_unreferenced(r.owner, r.blobs)');
  });

  it('claim: records how many listings reached their limit', () => {
    const body = fnBody('cloud_blob_erase_claim');
    expect(body).toContain("'listing_capped', (v_n_blobs >= p_limit)::integer + (v_n_rowless >= p_limit)::integer);");
  });

  it('claim: lists only fenced blobs no file row references, under a 5-minute lease', () => {
    const body = fnBody('cloud_blob_erase_claim');
    expect(body).toContain('WHERE b.purge_requested_at IS NOT NULL');
    expect(body).toContain('AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id)');
    expect(body).toContain("now() + interval '5 minutes'");
    expect(body).toContain('FOR UPDATE OF b SKIP LOCKED');
  });

  it('finish deletes a blob row only for a live run, while fenced, unreferenced and with its object gone', () => {
    const body = fnBody('cloud_blob_erase_finish');
    expect(body).toContain("IS DISTINCT FROM 'live' THEN v_ids := '{}';");
    expect(body).toContain('AND b.purge_requested_at IS NOT NULL');
    expect(body).toContain('AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_files f WHERE f.blob_id = b.id)');
    expect(body).toContain("AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'cloud-deal-files' AND o.name = b.storage_path);");
    expect(body).toContain("WHERE k ~ '^[a-z][a-z0-9_]{0,63}$' AND jsonb_typeof(v) = 'number'");
    expect(body).toContain('counts = v_counts || r.counts ||');
  });

  it('scrub: settings lock first (SKIP LOCKED), active computer and switch read after it, batch at most 1000, rows locked in id order, re-checked in the UPDATE', () => {
    const body = fnBody('cloud_blob_erase_scrub');
    expect(body).toContain('p_limit NOT BETWEEN 1 AND 1000');
    const lock = body.indexOf('FOR SHARE SKIP LOCKED;');
    const sw = body.indexOf('FROM (SELECT w.one_computer FROM public.cloud_release_switches w FOR SHARE) x), false);');
    const files = body.indexOf('FOR UPDATE OF f');
    const msgs = body.indexOf('FOR UPDATE OF m');
    const fence = body.indexOf('public._cloud_fence_unreferenced(p_owner, v_blobs)');
    expect(lock).toBeGreaterThan(0);
    expect(sw).toBeGreaterThan(lock);
    expect(files).toBeGreaterThan(sw);
    expect(msgs).toBeGreaterThan(files);
    expect(fence).toBeGreaterThan(msgs);
    expect(body).toContain('IF NOT v_on OR v_active IS NULL THEN');
    expect(count(body, 'FROM public.cloud_release_switches w FOR SHARE')).toBe(1);
    expect(count(body, 'ORDER BY f.id LIMIT p_limit FOR UPDATE OF f')).toBe(1);
    expect(count(body, 'ORDER BY m.id LIMIT p_limit - v_nf FOR UPDATE OF m')).toBe(1);
    expect(count(body, 'AND d.source_install_id IS DISTINCT FROM v_active);')).toBe(2);
    expect(body).toContain('subject = NULL, body_text = NULL, body_truncated = false, participants = NULL');
    expect(body).toContain('filename = NULL, blob_id = NULL');
    expect(body).not.toMatch(/UPDATE public\.cloud_blobs|UPDATE public\.cloud_deals\b/);
    expect(body).toContain("'rows_scrubbed', coalesce((r.counts ->> 'rows_scrubbed')::bigint, 0) + v_nf + v_nm");
  });

  it('scrub: a dry run takes no lock and writes only the run row', () => {
    const body = fnBody('cloud_blob_erase_scrub');
    const dry = body.indexOf('IF p_dry_run THEN SELECT count(*) INTO v_nf');
    const ret = body.indexOf("RETURN jsonb_build_object('state', 'dry_run'");
    expect(dry).toBeGreaterThan(0);
    expect(ret).toBeGreaterThan(dry);
    const arm = body.slice(dry, ret);
    expect(arm).not.toMatch(/FOR (UPDATE|SHARE)|_cloud_fence_unreferenced|UPDATE public\.cloud_deal/);
    expect(count(arm, 'UPDATE ')).toBe(1);
    const firstRead = body.slice(body.indexOf('IF p_dry_run THEN'), body.indexOf('ELSE SELECT true, s.active_install_id'));
    expect(firstRead).not.toMatch(/FOR (UPDATE|SHARE)/);
  });

  it('note adds only keys the run row does not hold, and only moves ok to partial', () => {
    const body = fnBody('cloud_blob_erase_note');
    expect(body).toContain('AND NOT (r.counts ? e.k);');
    expect(body).toContain("outcome = CASE WHEN p_outcome = 'partial' AND r.outcome = 'ok' THEN 'partial' ELSE r.outcome END");
    expect(body).toContain("p_outcome NOT IN ('ok', 'partial')");
    expect(body).not.toMatch(/\bDELETE\b|purge_requested_at|cloud_blobs/);
  });

  it('owners list: switch on, active computer set, oldest move first', () => {
    const body = fnBody('cloud_blob_erase_claim');
    expect(body).toContain('coalesce((SELECT bool_or(w.one_computer) FROM public.cloud_release_switches w), false)');
    expect(body).toContain('AND s.active_install_id IS NOT NULL');
    expect(body).toContain('ORDER BY s.active_since NULLS FIRST, s.user_id');
  });
});

describe('BACKLOG-4263 cloud blob erase schedule (E3)', () => {
  it('is its own file, minute 23, calling invoke, refusing without pg_cron, invoke or the URL secret', () => {
    expect(E1).not.toContain('cron.schedule');
    expect(E3).toContain("PERFORM cron.schedule('cloud-blob-erase', '23 * * * *', 'SELECT public.cloud_blob_erase_invoke()');");
    expect(E3).toContain("WHERE extname = 'pg_cron'");
    expect(E3).toContain("to_regprocedure('public.cloud_blob_erase_invoke()') IS NULL");
    expect(E3).toContain("IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'cloud_blob_erase_url') THEN");
    expect(E3).not.toContain('decrypted_secret');
  });
});

describe('BACKLOG-4263 cloud blob erase rollback files', () => {
  const RB1_RAW = read('supabase/tests/backlog-4263-sync2-erase/rollback-20261123110000.sql');
  const RB3_RAW = read('supabase/tests/backlog-4263-sync2-erase/rollback-20261123120000.sql');
  const firstStatement = (raw: string): string => statements(raw).split(';')[0];
  const between = (raw: string, a: string, b: string): string => raw.slice(raw.indexOf(a), raw.indexOf(b, raw.indexOf(a) + a.length));
  it('E3 rollback unschedules the job, then checks the job and ledger row are gone and nothing else changed', () => {
    expect(RB3).toContain("PERFORM cron.unschedule('cloud-blob-erase')");
    expect(firstStatement(RB3_RAW)).toBe("SET LOCAL lock_timeout = '3s'");
    const post = between(RB3_RAW, 'DO $postrb4263e3$', '$postrb4263e3$;');
    for (const x of ["RAISE EXCEPTION 'ROLLBACK POST-CHECK 20261123120000 FAILED, nothing changed: %'", "'cron job cloud-blob-erase still present; '",
      "'another cron job changed; '", "'a function of 20261123110000 changed; '", "'ledger row still present; '"]) expect(post).toContain(x);
    expect(RB3_RAW.trimEnd().endsWith('$postrb4263e3$;')).toBe(true);
  });
  it('E1 rollback: lock_timeout first, refuses on the job, a drifted body or run history, and post-checks', () => {
    expect(firstStatement(RB1_RAW)).toBe("SET LOCAL lock_timeout = '3s'");
    const pre = between(RB1_RAW, 'DO $rb4263e1$', '$rb4263e1$;');
    expect(pre).toContain('run rollback-20261123120000.sql first (cron job cloud-blob-erase exists)');
    // the six bodies as E1 wrote them: md5(prosrc) of each function in the migration text
    const fns = [...E1_RAW.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(cloud_blob_erase_\w+)\(([^)]*)\)[\s\S]*?\bAS\s+(\$\w*\$)([\s\S]*?)\3/g)];
    expect(fns).toHaveLength(6);
    for (const m of fns) {
      const sig = `'public.${m[1]}(${m[2].split(',').filter((a) => a.trim()).map((a) => a.trim().replace(/\s+DEFAULT\s+.*$/i, '').split(/\s+/).slice(1).join(' ')).join(',')})'`;
      expect(pre).toContain(`(${sig}, '${createHash('md5').update(m[4], 'utf8').digest('hex')}')`);
    }
    expect(pre).toContain('is not at the body 20261123110000 wrote (md5 %)');
    expect(pre).toContain("holds % rows (the erase job''s run history); keep a copy, then delete them first");
    const post = between(RB1_RAW, 'DO $postrb4263e1$', '$postrb4263e1$;');
    for (const x of ["RAISE EXCEPTION 'ROLLBACK POST-CHECK 20261123110000 FAILED, nothing changed: %'", "' still present; '", "'a table still present; '",
      "' vault row(s) of the job still present; '", "'ledger row still present; '", "'other rows or functions changed: before '"]) expect(post).toContain(x);
    expect(RB1_RAW.indexOf('DO $postrb4263e1$')).toBeGreaterThan(RB1_RAW.indexOf("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261123110000';"));
    expect(RB1_RAW).not.toMatch(/decrypted_secret|SELECT\s+secret\b|\.secret\b/i);
  });
  it('E1 rollback removes everything E1 created', () => {
    for (const s of [
      'DROP FUNCTION IF EXISTS public.cloud_blob_erase_invoke();',
      'DROP FUNCTION IF EXISTS public.cloud_blob_erase_scrub(uuid, uuid, boolean, integer);',
      'DROP FUNCTION IF EXISTS public.cloud_blob_erase_note(uuid, jsonb, text);',
      'DROP FUNCTION IF EXISTS public.cloud_blob_erase_finish(uuid, uuid[], jsonb, text);',
      'DROP FUNCTION IF EXISTS public.cloud_blob_erase_claim(boolean, integer, integer);',
      'DROP FUNCTION IF EXISTS public.cloud_blob_erase_secret();',
      'DROP TABLE IF EXISTS public.cloud_blob_erase_leases;',
      'DROP TABLE IF EXISTS public.cloud_blob_erase_runs;',
      "DELETE FROM vault.secrets WHERE name IN ('cloud_blob_erase_secret', 'cloud_blob_erase_url');",
    ]) expect(RB1).toContain(s);
  });
});

describe('config.toml', () => {
  it('pins verify_jwt = false for the function', () => {
    expect(CONFIG).toMatch(/\[functions\.cloud-blob-erase\]\nverify_jwt = false\n/);
  });
});

/**
 * Harness structure (no database, no parser library). The first harness run on the test project hit a constant in
 * GROUP BY that a read missed. This pins, for lib/helpers.sql, lib/probes.sql and the control and probe calls written in
 * harness.py: every string, comment and dollar quote is closed; parentheses balance; every pg_temp call has the argument
 * count of its definition; no non-integer constant sits in GROUP BY / ORDER BY. `harness.py check` runs the same checks
 * over the composed call and every mutated function text.
 */
describe('BACKLOG-4263 erase harness structure', () => {
  const DIR = 'supabase/tests/backlog-4263-sync2-erase';
  const HL = read(`${DIR}/lib/helpers.sql`);
  const PR = read(`${DIR}/lib/probes.sql`);
  const PY = read(`${DIR}/harness.py`);

  /** Strings -> '', comments removed; a dollar quote after AS or DO is code and scanned, any other is a literal. */
  function strip(text: string, label: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (text.startsWith('--', i)) {
        const j = text.indexOf('\n', i);
        i = j < 0 ? text.length : j;
      } else if (text.startsWith('/*', i)) {
        const j = text.indexOf('*/', i + 2);
        if (j < 0) throw new Error(`${label}: unterminated comment`);
        out += ' ';
        i = j + 2;
      } else if (c === "'") {
        let j = i + 1;
        for (;;) {
          j = text.indexOf("'", j);
          if (j < 0) throw new Error(`${label}: unterminated string literal`);
          if (text[j + 1] === "'") j += 2;
          else break;
        }
        out += "''";
        i = j + 1;
      } else if (c === '$' && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
        if (!m) {
          out += c;
          i += 1;
          continue;
        }
        const j = text.indexOf(m[0], i + m[0].length);
        if (j < 0) throw new Error(`${label}: unterminated dollar quote ${m[0]}`);
        const body = text.slice(i + m[0].length, j);
        out += /\b(AS|DO)\s*$/i.test(out.slice(-40)) ? ` ${strip(body, label)} ` : "''";
        i = j + m[0].length;
      } else {
        out += c;
        i += 1;
      }
    }
    return out;
  }
  function args(code: string, open: number): number {
    let depth = 0;
    let n = 1;
    let seen = false;
    for (let k = open; k < code.length; k++) {
      const ch = code[k];
      if (ch === '(' || ch === '[') depth += 1;
      else if (ch === ')' || ch === ']') {
        depth -= 1;
        if (depth === 0) return seen ? n : 0;
      } else if (ch === ',' && depth === 1) n += 1;
      else if (depth >= 1 && !/\s/.test(ch)) seen = true;
    }
    throw new Error(`unclosed call at ${open}`);
  }
  const code = { helpers: strip(HL, 'helpers.sql'), probes: strip(PR, 'probes.sql') };
  const defs = new Map<string, number>();
  for (const src of [code.helpers, code.probes]) {
    for (const m of src.matchAll(/CREATE\s+FUNCTION\s+pg_temp\.(\w+)\s*\(/gi)) defs.set(m[1], args(src, m.index! + m[0].length - 1));
  }

  it('finds the helpers and probes it checks', () => {
    expect(defs.size).toBeGreaterThan(30);
    expect(defs.get('scrub')).toBe(4);
    expect(defs.get('p_c6g_seq')).toBe(0);
  });

  it.each(['helpers', 'probes'] as const)('lib/%s.sql: parentheses balance', (k) => {
    let depth = 0;
    for (const ch of code[k]) {
      depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it.each(['helpers', 'probes'] as const)('lib/%s.sql: every pg_temp call matches its definition', (k) => {
    const bad: string[] = [];
    let calls = 0;
    for (const m of code[k].matchAll(/pg_temp\.(\w+)\s*\(/g)) {
      if (/FUNCTION\s+$/i.test(code[k].slice(Math.max(0, m.index! - 20), m.index!))) continue;
      calls += 1;
      const want = defs.get(m[1]);
      const got = args(code[k], m.index! + m[0].length - 1);
      if (want === undefined) bad.push(`${m[1]} not defined`);
      else if (got !== want) bad.push(`${m[1]}: ${got} argument(s), defined with ${want}`);
    }
    expect(calls).toBeGreaterThan(k === 'probes' ? 100 : 5);
    expect(bad).toEqual([]);
  });

  it.each(['helpers', 'probes'] as const)('lib/%s.sql: no non-integer constant in GROUP BY or ORDER BY', (k) => {
    expect(code[k].match(/\b(GROUP|ORDER)\s+BY\s+(TRUE|FALSE|NULL|''|\d*\.\d+)(?![\w.])/gi) ?? []).toEqual([]);
  });

  it('harness.py: every control and mutant probe call names a defined probe with its argument count', () => {
    const calls = [...PY.matchAll(/'(p_\w+)\(([^']*)\)'/g)];
    expect(calls.length).toBeGreaterThan(40);
    const bad = calls
      .map((m) => [m[1], m[2].trim() === '' ? 0 : m[2].split(',').length] as const)
      .filter(([name, n]) => defs.get(name) !== n)
      .map(([name, n]) => `${name}(${n}) vs ${defs.get(name)}`);
    expect(bad).toEqual([]);
  });
});
