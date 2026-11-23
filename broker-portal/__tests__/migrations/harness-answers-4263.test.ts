/**
 * BACKLOG-4263 (sync 2.49) — the T-S harness compares product answers only with values the product functions emit.
 *
 * supabase/tests/backlog-4263-sync2-t/answers.py derives, from the migration texts, the literals each product function
 * can emit and checks every compare the harness's lib/*.sql files make on an answer. gen.py writes the result to
 * answers-report.txt with the md5 of every input it read, and `gen.py check` fails on a finding. This test (CI has no
 * Python step for these folders) checks that the report is current for the files at HEAD and has no finding, and pins
 * the fixtures-only call's shape.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const DIR = 'supabase/tests/backlog-4263-sync2-t';
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const REPORT = read(`${DIR}/answers-report.txt`);

describe('BACKLOG-4263 T-S harness answers', () => {
  it('the answer report is current: every input it read has the md5 it recorded', () => {
    const inputs = [...REPORT.matchAll(/^input ([0-9a-f]{32}) (\S+)$/gm)].map((m) => [m[1], m[2]]);
    expect(inputs.length).toBeGreaterThan(20);
    for (const p of [`${DIR}/lib/helpers.sql`, `${DIR}/lib/fixtures.sql`, `${DIR}/lib/controls.sql`, `${DIR}/answers.py`,
      'supabase/migrations/20261123130000_backlog_4263_messages_up_server.sql',
      'supabase/migrations/20261123140000_backlog_4263_mcp_message_tools.sql']) {
      expect(inputs.some(([, x]) => x === p)).toBe(true);
    }
    for (const [h, p] of inputs) expect(`${p} ${md5(read(p))}`).toBe(`${p} ${h}`);
  });

  it('the report has compares checked and no finding', () => {
    expect(Number(/^checked (\d+)$/m.exec(REPORT)![1])).toBeGreaterThan(50);
    expect(/^findings (\d+)$/m.exec(REPORT)![1]).toBe('0');
    expect(REPORT).not.toMatch(/^finding /m);
  });

  it('the fixture expects the status cloud_tombstone emits for a removed row', () => {
    const fx = read(`${DIR}/lib/fixtures.sql`);
    expect(fx.match(/->> 'status' IS DISTINCT FROM 'removed' THEN RAISE EXCEPTION 'FIXTURE tombstone (message|file) failed/g)).toHaveLength(2);
    expect(fx).not.toMatch(/tomb\([^;]*;\s*IF r -> 'results' -> 0 ->> 'status' IS DISTINCT FROM 'applied'/);
    const s2 = read('supabase/migrations/20261123130000_backlog_4263_messages_up_server.sql');
    expect(s2).toContain("out := out || jsonb_build_object('cloud_id', v_id, 'status', 'removed', 'version', v_row_version);");
  });

  it('the fixtures-only call: guard, timeouts, applied check, helpers and fixtures as in the full call, then RAISE; nothing else', () => {
    const f = read(`${DIR}/harness-t-fixtures.sql`);
    const full = read(`${DIR}/harness-t.sql`);
    expect(f.split('\n')[1]).toContain('must never be run on production');
    expect(f.indexOf('DO $guard4263t$')).toBeLessThan(f.indexOf("SET LOCAL lock_timeout = '3s';"));
    expect(f).toContain(read(`${DIR}/lib/helpers.sql`));
    expect(f).toContain(read(`${DIR}/lib/fixtures.sql`));
    expect(full).toContain(read(`${DIR}/lib/fixtures.sql`));
    expect(f).not.toContain('CREATE FUNCTION pg_temp.c_');
    expect(f).not.toContain("pg_temp.rec('mutant:");
    expect(f).not.toContain('$rbq$');
    expect(f).not.toContain('generate_series(1, 100001)');
    expect(f.trimEnd().endsWith("FROM public.cloud_release_switches w WHERE w.id));\nEND\n$fxend4263t$;")).toBe(true);
    expect(f).toContain("RAISE EXCEPTION 'T4263_FIXTURES_OK %'");
  });
});
