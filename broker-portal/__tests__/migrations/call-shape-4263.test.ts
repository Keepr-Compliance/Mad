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

/** index just past the block comment opening at i; PostgreSQL nests block comments */
function commentEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      depth += 1;
      i += 2;
    } else if (text.startsWith('*/', i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else i += 1;
  }
  return text.length;
}

/** the words and semicolons of text, with comments, strings, quoted names and dollar-quoted texts blanked */
function codeWords(text: string): string[] {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text.startsWith('--', i)) {
      const j = text.indexOf('\n', i);
      i = j < 0 ? n : j;
      out += ' ';
      continue;
    }
    if (text.startsWith('/*', i)) {
      i = commentEnd(text, i);
      out += ' ';
      continue;
    }
    const c = text[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        j = text.indexOf(c, j);
        if (j < 0 || text[j + 1] !== c) break;
        j += 2;
      }
      i = j < 0 ? n : j + 1;
      out += ' ';
      continue;
    }
    if (c === '$' && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const j = text.indexOf(m[0], i + m[0].length);
        i = j < 0 ? n : j + m[0].length;
        out += ' ';
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out.match(/[A-Za-z_][A-Za-z0-9_]*|;/g) ?? [];
}

/** ways a DO body can end without raising (the same rule as call_shape.exit_paths) */
function exitPaths(body: string): string[] {
  const w = codeWords(body).map((x) => x.toUpperCase());
  const stack: string[] = [];
  const bad: string[] = [];
  for (let i = 0; i < w.length; i += 1) {
    const x = w[i];
    const nxt = w[i + 1] ?? '';
    const prev = i ? w[i - 1] : '';
    if (x === 'BEGIN') stack.push('B');
    else if (x === 'CASE') stack.push('C');
    else if (x === 'LOOP') stack.push('L');
    else if (x === 'END') {
      if (nxt === 'IF') i += 1;
      else if (nxt === 'LOOP' || nxt === 'CASE') {
        const k = stack.lastIndexOf(nxt[0]);
        if (k >= 0) stack.splice(k, 1);
        i += 1;
      } else stack.pop();
    } else if (x === 'RETURN') bad.push('RETURN');
    else if (x === 'EXIT' || x === 'CONTINUE') {
      if (!stack.includes('L')) bad.push(`${x} outside a loop`);
      else if (nxt !== 'WHEN' && nxt !== ';') bad.push(`${x} ${nxt} (a labelled ${x})`);
    } else if (x === 'EXCEPTION' && prev !== 'RAISE' && stack.length === 1 && stack[0] === 'B') bad.push('an EXCEPTION handler on the outermost block');
  }
  return bad;
}

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
      i = commentEnd(text, i);
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
  return /^RAISE\s+EXCEPTION\s+'[A-Z][A-Z0-9_]*\b[^']*'/i.test(last) && exitPaths(m[2]).length === 0;
}

function problems(kind: string, text: string): string[] {
  const st = statements(text);
  const bad = st.filter((s) => TXN.test(s)).map((s) => `transaction control: ${s.slice(0, 30)}`);
  if (kind === 'rolled_back') {
    const finals = st.map((s, i) => (resultBlock(s) ? i : -1)).filter((i) => i >= 0);
    if (finals.length !== 1) bad.push(`${finals.length} result blocks`);
    else if (finals[0] !== st.length - 1) bad.push(`${st.length - 1 - finals[0]} statement(s) after the result block`);
    if (st.length && !text.trimEnd().endsWith(';') && statements(text.slice(text.lastIndexOf(';') + 1)).length) bad.push('text after the last statement');
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
  'backlog-4263-sync2-erase': {
    'apply-20261123110000.sql': 'commits', 'rollback-20261123110000.sql': 'commits', 'rollback-20261123120000.sql': 'commits',
  },
};
/** the file whose check passes the same classes to call_shape.gen_check */
const CHECKER: Record<string, string> = { 'backlog-4263-sync2-erase': 'harness.py' };

const WRITE = /^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COMMENT|DO)\b|\bpublic\.__[A-Z]+_FN__\(|\bpublic\.cloud_\w+\(|pg_stat_statements_reset\(/i;
/** line of the first top-level statement that writes or may write (call_shape.first_write), or 'none' */
function firstWrite(text: string): string {
  for (const st of statements(text)) {
    if (WRITE.test(st)) {
      const k = text.indexOf(st.slice(0, 40));
      return String(text.slice(0, k).split('\n').length);
    }
  }
  return 'none';
}
const readmeClasses = (p: string): Record<string, string> =>
  Object.fromEntries([...read(p).matchAll(/^\| `([\w.-]+\.(?:sql|tpl))` \| (rolled_back|commits|fragment) \|/gm)].map((m) => [m[1], m[2]]));
/** the classes dict a folder's check passes to call_shape.gen_check, read from its source */
function checkerClasses(folder: string): Record<string, string> {
  const src = read(`${folder}/${CHECKER[folder] ?? 'gen.py'}`);
  const m = [...src.matchAll(/\.gen_check\([^{]*(\{[^}]*\})\)/g)];
  expect(m.length).toBe(1);
  return JSON.parse(m[0][1].replace(/'/g, '"'));
}



type Sites = { non_calls: string[]; helpers: string[]; producer: string; hand_built: string[]; compose_outputs: string[] };
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the same reading of a run.sh as call_shape.transport_sites: [sent file names, problems] */
function transportSites(text: string, rules: Sites): [string[], string[]] {
  const code = text.replace(/\r\n/g, '\n').split('\n').map((x) => x.replace(/(^|\s)#(\s.*)?$/, '$1').trimEnd());
  const stripped = code.map((x) => x.trim());
  const bad = new Set<string>();
  const sent: [number, string][] = [];
  let func: string | null = null;
  code.forEach((x, k) => {
    const no = k + 1;
    const m = /^\s*([A-Za-z_]\w*)\(\)\s*\{/.exec(x);
    if (m) func = m[1];
    const mentions = (x.match(/\$\{?K\}?(?![A-Za-z0-9_])/g) ?? []).length;
    const names = [...x.matchAll(/(?:^|[\s(;&|])"?\$K"?\s+"\$tmp\/([A-Za-z0-9_.$-]+)"/g)].map((y) => y[1]);
    if (mentions > names.length && !rules.non_calls.includes(x.trim())) bad.add(`run.sh:${no}: a mention of $K that is neither an invocation of a guarded file nor a pinned non-call`);
    for (const nm of names) {
      if (/^\$[1-9]$/.test(nm) && func) {
        const i = Number(nm[1]);
        const f: string = func;
        const calls = stripped.filter((c) => new RegExp(`^${esc(f)}\\s`).test(c) && c.split(/\s+/).length > i).map((c) => c.split(/\s+/)[i]);
        if (!calls.length) bad.add(`run.sh:${no}: ${nm} inside ${f}() is never given a file`);
        for (const c of calls) sent.push([no, c]);
      } else if (nm.includes('$')) bad.add(`run.sh:${no}: a sent file name that is not fixed: ${nm}`);
      else sent.push([no, nm]);
    }
    if (func && (x.trim() === '}' || (m && x.trimEnd().endsWith('}')))) func = null;
  });
  for (const want of [...rules.non_calls, ...rules.helpers, ...rules.hand_built]) if (!stripped.includes(want)) bad.add(`pinned line not in run.sh: ${want.slice(0, 90)}`);
  for (const [no, nm] of sent) {
    const e = esc(nm);
    const w = new RegExp(`>\\s*"\\$tmp/${e}"`);
    const produced = rules.compose_outputs.includes(nm)
      || stripped.some((c) => new RegExp(`${rules.producer.replace('{N}', e)}(?=[\\s;]|$)`).test(c)) || rules.hand_built.some((h) => w.test(h));
    if (!produced) bad.add(`run.sh:${no}: ${nm} is sent but built by no guarded helper`);
    for (const c of stripped) if (w.test(c) && !rules.hand_built.includes(c)) bad.add(`${nm} is written outside the guarded helpers: ${c.slice(0, 90)}`);
  }
  const uniq = [...new Set(sent.map(([, n]) => n))].sort();
  if (uniq.length < 5) bad.add(`only ${uniq.length} sent files found: the scan is not reading this run.sh`);
  return [uniq, [...bad].sort()];
}

describe('BACKLOG-4263 call shape', () => {
  for (const [folder, classes] of Object.entries(FOLDERS)) {
    it(`${folder}: every .sql file is declared, rolled-back calls end in their result RAISE, committing files do not`, () => {
      const files = readdirSync(join(T, folder)).filter((f) => f.endsWith('.sql')).sort();
      expect(files).toEqual(Object.keys(classes).sort());
      for (const [f, kind] of Object.entries(classes)) expect(`${f} ${problems(kind, read(`${folder}/${f}`)).join('; ')}`).toBe(`${f} `);
      expect(Object.values(classes).length).toBeGreaterThan(2);
    });
    it(`${folder}: the classes agree in three places (this test, the folder's check, the README table)`, () => {
      expect(readmeClasses(`${folder}/README.md`)).toEqual(classes);
      expect(checkerClasses(folder)).toEqual(classes);
    });
  }

  for (const folder of ['backlog-4263-sync2-s1/concurrency', 'backlog-4263-sync2-erase/concurrency']) {
    it(`${folder}: the README declares every file's class and first write, and each file has its class's shape`, () => {
      const rows = [...read(`${folder}/README.md`).matchAll(/^\| `([\w.-]+\.sql)` \| (rolled_back|commits|fragment) \| (none|\d+) \|/gm)];
      const table = Object.fromEntries(rows.map((m) => [m[1], m[2]]));
      const files = readdirSync(join(T, folder)).filter((f) => f.endsWith('.sql')).sort();
      expect(Object.keys(table).sort()).toEqual(files);
      for (const [f, kind] of Object.entries(table)) expect(`${f} ${problems(kind, read(`${folder}/${f}`)).join('; ')}`).toBe(`${f} `);
      for (const m of rows) if (m[2] !== 'fragment') expect(`${m[1]} first write ${firstWrite(read(`${folder}/${m[1]}`))}`).toBe(`${m[1]} first write ${m[3]}`);
      expect(Object.values(table).filter((k) => k === 'commits').length).toBeGreaterThan(3);
    });
  }

  const SITES: Record<string, Sites> = JSON.parse(read('backlog-4263-sync2-t/call_sites.json'));
  const SENT: Record<string, number> = { 'backlog-4263-sync2-s1/concurrency': 14, 'backlog-4263-sync2-erase/concurrency': 12, 'backlog-4263-sync2-n/two-session': 11 };
  for (const [folder, n] of Object.entries(SENT)) {
    it(`${folder}: every $K call in run.sh, read from the script, sends a file built guard first`, () => {
      const [names, bad] = transportSites(read(`${folder}/run.sh`), SITES[folder]);
      expect(bad).toEqual([]);
      expect(names.length).toBe(n);
    });
  }

  it('backlog-4263-sync2-n/two-session: the README classes, compose.py and call_sites.json name the same composed texts', () => {
    const table = readmeClasses('backlog-4263-sync2-n/two-session/README.md');
    const src = read('backlog-4263-sync2-n/two-session/compose.py');
    const block = src.slice(src.indexOf("    files = {'precheck.sql'"), src.indexOf('    os.makedirs(outdir'));
    const composed = [...block.matchAll(/'([\w.-]+\.(?:sql|tpl))':/g)].map((m) => m[1]).sort();
    expect(Object.keys(table).sort()).toEqual(composed);
    expect([...SITES['backlog-4263-sync2-n/two-session'].compose_outputs].sort()).toEqual(composed.filter((f) => f.endsWith('.sql')));
    expect(composed.length).toBe(11);
  });

  it('the shared cases (call_shape_cases.json) get the same verdict here as in call_shape.py selftest', () => {
    const cases: { name: string; kind: string; text: string; ok: boolean }[] = JSON.parse(read('backlog-4263-sync2-t/call_shape_cases.json'));
    expect(cases.length).toBeGreaterThan(30);
    for (const c of cases) expect(`${c.name}: ${problems(c.kind, c.text).length === 0}`).toBe(`${c.name}: ${c.ok}`);
  });

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
