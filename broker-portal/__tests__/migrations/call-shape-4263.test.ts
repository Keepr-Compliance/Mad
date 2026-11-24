/**
 * BACKLOG-4263 — a test call that must roll back ends in its result RAISE; a file that commits by design does not.
 *
 * A harness call is sent as ONE transaction and rolls back only because its last statement raises. Removing that
 * RAISE, putting a statement after it, or a COMMIT in the middle would make it commit. This test reads the committed
 * files (the same rule as supabase/tests/backlog-4263-sync2-t/call_shape.py, which each folder's gen.py check and the
 * two concurrency offline checks run):
 *   rolled_back: exactly one final result block (a DO whose body ends in an unconditional RAISE EXCEPTION '<MARKER> ...'),
 *                it is the last top-level statement, nothing after it, no top-level transaction control;
 *   commits:     no top-level transaction control, and it does not end in a result block;
 *   fragment:    no top-level transaction control.
 * The concurrency folders declare each file's class (and the line of its first write) in concurrency/README.md.
 * What this cannot see: it splits statements with its own quote/dollar/comment-aware scanner, not PostgreSQL's parser
 * (call_shape.py cross-checks that split against pglast where it is installed); and it reads files, not the calls
 * run.sh composes from them (the offline checks record those and check that the guard is the first statement of each).
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const T = join(__dirname, '../../../supabase/tests');
const read = (p: string): string => readFileSync(join(T, p), 'utf8').replace(/\r\n?/g, '\n');

/** top-level statements, comments removed, string and dollar-quoted text kept */
function statements(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text.startsWith('--', i)) {
      const j = text.indexOf('\n', i);
      i = j < 0 ? n : j;
      continue;
    }
    if (text.startsWith('/*', i)) {
      const j = text.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      cur += ' ';
      continue;
    }
    const c = text[i];
    if (c === "'") {
      let j = i + 1;
      for (;;) {
        j = text.indexOf("'", j);
        if (j < 0 || text[j + 1] !== "'") break;
        j += 2;
      }
      if (j < 0) j = n - 1;
      cur += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = text.indexOf('"', i + 1);
      if (j < 0) j = n - 1;
      cur += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$' && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        let j = text.indexOf(tag, i + tag.length);
        if (j < 0) j = n - tag.length;
        cur += text.slice(i, j + tag.length);
        i = j + tag.length;
        continue;
      }
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const TXN = /^(COMMIT|END|ROLLBACK|ABORT|BEGIN|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i;

function resultBlock(st: string): boolean {
  const m = /^DO\s+(\$[A-Za-z_0-9]*\$)([\s\S]*)\1\s*$/i.exec(st);
  if (!m) return false;
  const body = statements(m[2]);
  if (body.length < 2 || !/^END$/i.test(body[body.length - 1].trim())) return false;
  const last = body[body.length - 2].trim().replace(/^(DECLARE\b[\s\S]*?\bBEGIN|BEGIN)\s+/i, '');
  return /^RAISE\s+EXCEPTION\s+'[A-Z][A-Z0-9_]*\b[^']*'/i.test(last);
}

function problems(kind: string, text: string): string[] {
  const st = statements(text);
  const bad = st.filter((s) => TXN.test(s)).map((s) => `transaction control: ${s.slice(0, 30)}`);
  if (kind === 'rolled_back') {
    const finals = st.map((s, i) => (resultBlock(s) ? i : -1)).filter((i) => i >= 0);
    if (finals.length !== 1) bad.push(`${finals.length} result blocks`);
    else if (finals[0] !== st.length - 1) bad.push(`${st.length - 1 - finals[0]} statement(s) after the result block`);
    if (!text.trimEnd().endsWith(';') && text.slice(text.lastIndexOf(';') + 1).replace(/--[^\n]*/g, '').trim() !== '') bad.push('text after the last statement');
  }
  if (kind === 'commits' && st.length && resultBlock(st[st.length - 1])) bad.push('ends in a result RAISE');
  return bad;
}

const FOLDERS: Record<string, Record<string, string>> = {
  'backlog-4263-sync2-s1': { 'harness-s1.sql': 'rolled_back', 'apply-20261123100000.sql': 'commits', 'rollback-20261123100000.sql': 'commits' },
  'backlog-4263-sync2-s2': { 'harness-s2.sql': 'rolled_back', 'apply-20261123130000.sql': 'commits', 'rollback-20261123130000.sql': 'commits' },
  'backlog-4263-sync2-t': {
    'harness-t.sql': 'rolled_back', 'harness-t-controls.sql': 'rolled_back', 'harness-t-mutants.sql': 'rolled_back',
    'harness-t-fixtures.sql': 'rolled_back', 'harness-t-structure.sql': 'rolled_back',
    'apply-20261123140000.sql': 'commits', 'rollback-20261123140000.sql': 'commits',
  },
  'backlog-4263-sync2-n': {
    'harness-n.sql': 'rolled_back', 'harness-n-fixtures.sql': 'rolled_back', 'harness-n-structure.sql': 'rolled_back',
    'apply-20261123150000.sql': 'commits', 'rollback-20261123150000.sql': 'commits',
  },
  'backlog-4266': {
    'harness-4266.sql': 'rolled_back', 'harness-4266-fixtures.sql': 'rolled_back', 'harness-4266-structure.sql': 'rolled_back',
    'apply-20261123170000.sql': 'commits', 'rollback-20261123170000.sql': 'commits', 'dryrun-foreign-rows.sql': 'fragment',
  },
};

describe('BACKLOG-4263 call shape', () => {
  for (const [folder, classes] of Object.entries(FOLDERS)) {
    it(`${folder}: every .sql file is declared, rolled-back calls end in their result RAISE, committing files do not`, () => {
      const files = readdirSync(join(T, folder)).filter((f) => f.endsWith('.sql')).sort();
      expect(files).toEqual(Object.keys(classes).sort());
      for (const [f, kind] of Object.entries(classes)) expect(`${f} ${problems(kind, read(`${folder}/${f}`)).join('; ')}`).toBe(`${f} `);
      expect(Object.values(classes).filter((k) => k === 'rolled_back').length).toBeGreaterThan(0);
    });
  }

  for (const folder of ['backlog-4263-sync2-s1/concurrency', 'backlog-4263-sync2-erase/concurrency']) {
    it(`${folder}: the README declares every file's class, and each file has its class's shape`, () => {
      const rows = [...read(`${folder}/README.md`).matchAll(/^\| `([\w.-]+\.sql)` \| (rolled_back|commits|fragment) \| (none|\d+) \|/gm)];
      const table = Object.fromEntries(rows.map((m) => [m[1], m[2]]));
      const files = readdirSync(join(T, folder)).filter((f) => f.endsWith('.sql')).sort();
      expect(Object.keys(table).sort()).toEqual(files);
      for (const [f, kind] of Object.entries(table)) expect(`${f} ${problems(kind, read(`${folder}/${f}`)).join('; ')}`).toBe(`${f} `);
      expect(Object.values(table).filter((k) => k === 'commits').length).toBeGreaterThan(3);
    });
  }

  it('the rule sees the shapes that would commit', () => {
    const ok = "SELECT 1;\nDO $e$ BEGIN RAISE EXCEPTION 'X_RESULT %', 1; END $e$;\n";
    expect(problems('rolled_back', ok)).toEqual([]);
    expect(problems('rolled_back', ok.replace('RAISE EXCEPTION', 'RAISE NOTICE'))).not.toEqual([]);
    expect(problems('rolled_back', ok + 'SELECT 2;\n')).not.toEqual([]);
    expect(problems('rolled_back', 'COMMIT;\n' + ok)).not.toEqual([]);
    expect(problems('commits', ok)).not.toEqual([]);
    expect(problems('rolled_back', "DO $e$ BEGIN IF true THEN RAISE EXCEPTION 'X_RESULT %', 1; END IF; END $e$;")).not.toEqual([]);
  });
});
