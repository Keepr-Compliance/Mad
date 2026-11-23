/**
 * BACKLOG-4263 — statements on objects another role owns run under that role.
 *
 * supabase/tests/backlog-4263-sync2-t/roles.py follows SET [LOCAL] ROLE / RESET ROLE through every .sql file of the
 * hosted-MCP and Keepr Cloud test folders (and the dynamic SQL inside them) and checks each statement that replaces,
 * alters, grants or revokes on, comments on or drops an object against the role that created it in the migrations.
 * gen.py writes the result to roles-report.txt with the md5 of every input; `gen.py check` fails on a wrong role.
 * This test checks that the report is current and has no wrong role, and independently that every rollback file's
 * DROP of a reader function (public._mcp_r_*, created under SET ROLE mcp_reader) sits under that role.
 */

import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8').replace(/\r\n?/g, '\n');
const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');
const REPORT = read('supabase/tests/backlog-4263-sync2-t/roles-report.txt');

/** every rollback-*.sql / rollback.sql under supabase/tests/<dir> for the folders the role check covers */
function rollbacks(): string[] {
  const dirs = [...REPORT.matchAll(/^input [0-9a-f]{32} (supabase\/tests\/[^/]+)\//gm)].map((m) => m[1]);
  const out = new Set<string>();
  const walk = (d: string): void => {
    for (const f of readdirSync(join(REPO, d))) {
      const p = `${d}/${f}`;
      if (statSync(join(REPO, p)).isDirectory()) walk(p);
      else if (/^rollback[^/]*\.sql$/.test(f)) out.add(p);
    }
  };
  for (const d of new Set(dirs)) walk(d);
  return [...out].sort();
}

/** Role in force at each line, by SET [LOCAL] ROLE r / EXECUTE 'SET ROLE r' and RESET ROLE (comments skipped). */
function readerDropsOutsideRole(text: string): string[] {
  let role = 'postgres';
  const bad: string[] = [];
  text.split('\n').forEach((line, i) => {
    const l = line.replace(/--.*$/, '');
    const set = /\bSET\s+(?:LOCAL\s+)?ROLE\s+([a-z_]+)/i.exec(l);
    if (set && set[1].toLowerCase() !== 'none') role = set[1];
    if (/\bRESET\s+ROLE\b/i.test(l)) role = 'postgres';
    if (/\bDROP\s+FUNCTION\s+(IF\s+EXISTS\s+)?public\._mcp_r_\w+/i.test(l) && role !== 'mcp_reader') bad.push(`:${i + 1} ${l.trim()}`);
  });
  return bad;
}

describe('BACKLOG-4263 roles of statements on objects another role owns', () => {
  it('the role report is current: every input it read has the md5 it recorded', () => {
    const inputs = [...REPORT.matchAll(/^input ([0-9a-f]{32}) (\S+)$/gm)].map((m) => [m[1], m[2]]);
    expect(inputs.length).toBeGreaterThan(100);
    for (const p of ['supabase/tests/backlog-4263-sync2-t/rollback-20261123140000.sql', 'supabase/tests/backlog-4263-pr8/rollback-20261118150000.sql',
      'supabase/tests/backlog-4238/rollback-4238.sql', 'supabase/tests/backlog-4244/rollback-4244.sql', 'supabase/tests/backlog-4263-sync2-t/roles.py']) {
      expect(inputs.some(([, x]) => x === p)).toBe(true);
    }
    for (const [h, p] of inputs) expect(`${p} ${md5(read(p))}`).toBe(`${p} ${h}`);
  });

  it('the report has statements checked and none under the wrong role', () => {
    expect(Number(/^statements (\d+)$/m.exec(REPORT)![1])).toBeGreaterThan(100);
    expect(/^wrong_role (\d+)$/m.exec(REPORT)![1]).toBe('0');
    expect(/^migration_wrong_role (\d+)$/m.exec(REPORT)![1]).toBe('0');
    expect(REPORT).not.toMatch(/^WRONG /m);
    expect(REPORT).toMatch(/^ok supabase\/tests\/backlog-4263-sync2-t\/rollback-20261123140000\.sql:\d+ _mcp_r_get_message owner mcp_reader role mcp_reader$/m);
  });

  it('every rollback drops reader functions only under SET ROLE mcp_reader', () => {
    const files = rollbacks();
    expect(files.length).toBeGreaterThan(10);
    let drops = 0;
    for (const f of files) {
      const t = read(f);
      drops += (t.match(/\bDROP\s+FUNCTION\s+(IF\s+EXISTS\s+)?public\._mcp_r_/gi) ?? []).length;
      expect(`${f} ${readerDropsOutsideRole(t).join(' | ')}`).toBe(`${f} `);
    }
    expect(drops).toBeGreaterThan(5);
  });
});
