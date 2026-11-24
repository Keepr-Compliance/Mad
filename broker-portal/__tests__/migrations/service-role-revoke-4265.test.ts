/**
 * BACKLOG-4265 — migration 20261123160000 revokes all privileges of role service_role on 18 tables and 1 sequence.
 * CI has no database: this checks file text only.
 *
 * 1. The migration: lock_timeout first; exactly four REVOKE ALL statements naming the 19 relations FROM service_role;
 *    no other change; its pre-check and post-check.
 * 2. The rollback file: grants back exactly the measured prior privileges, nothing more.
 * 3. The prod post-check of 20261123160000 pins service_role holding nothing on each of the 19 relations (MUST HOLD).
 * 4. Relations created from version 20261123000000 on (see `created`): each one, and each sequence of a serial or
 *    identity column, is named in a REVOKE ALL ... FROM ... service_role of the same or a later migration (under its
 *    name or a later name), or is in EXEMPT. A CREATE TABLE the parser cannot read is red.
 * 5. In migrations after 20261123160000, no statement (see `regrants`): grants service_role (directly, through PUBLIC,
 *    through a role membership or through default privileges) a privilege on the 19 relations; grants EXECUTE on a
 *    function whose body writes one of them (functions in SERVICE_ROLE_FUNCTIONS excepted); changes the owner of one of
 *    them or of a function in SERVICE_ROLE_FUNCTIONS; or builds a grant to service_role by concatenation in a dollar body.
 *    It cannot see a role name assembled from pieces, or SQL read from a table at run time.
 * 6. In migrations after 20261123160000, every new SECURITY DEFINER function whose body names one of the 19 relations is
 *    revoked in the same migration from PUBLIC and from service_role (from PUBLIC only for SERVICE_ROLE_FUNCTIONS), and
 *    every new view or materialized view over them is revoked from service_role: views over these tables must carry the
 *    same revoke.
 * 7. The result-detail rule over backlog-4265's own SQL (R1, R2a and R2b of backlog-4263-sync2-t/result_detail.py).
 * 4 to 7 are checked against a corpus of shapes first, each required red or green.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGDIR = join(REPO, 'supabase/migrations');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8').replace(/\r\n?/g, '\n');
const VERSION = '20261123160000';
const MIG_PATH = `supabase/migrations/${VERSION}_backlog_4265_api_role_table_privileges.sql`;
const MIG = read(MIG_PATH);
const ROLLBACK = read(`supabase/tests/backlog-4265/rollback-${VERSION}.sql`);
const POSTCHECK = read(`supabase/tests/backlog-4263-prod/postcheck-${VERSION}.sql`);

const BLOCK_A = ['cloud_deal_messages', 'cloud_deal_files', 'cloud_blobs'];
const BLOCK_B = ['mcp_settings', 'mcp_redirect_allowlist', 'mcp_oauth_clients', 'mcp_authorization_requests', 'mcp_connections',
  'mcp_authorization_codes', 'mcp_tokens', 'mcp_rate_counters', 'mcp_call_log'];
const BLOCK_C = ['cloud_deals', 'cloud_deal_parties', 'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_autosave_settings',
  'member_addons'];
const SEQ = 'mcp_call_log_id_seq';
const RELS = [...BLOCK_A, ...BLOCK_B, ...BLOCK_C, SEQ];
const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const SEQ_PRIVS = ['USAGE', 'SELECT', 'UPDATE'];
/** functions granted EXECUTE to service_role by 20261123160000; a later migration may restate their grants */
const SERVICE_ROLE_FUNCTIONS = ['cloud_blob_erase_secret', 'cloud_blob_erase_claim', 'cloud_blob_erase_finish', 'cloud_blob_erase_note',
  'cloud_blob_erase_scrub', 'ai_app_notice_claim', 'ai_app_notice_done', 'cloud_computer_move_notice_claim',
  'cloud_computer_move_notice_done', 'assign_member_addon'];
/** tables (or identity sequences) created from 20261123000000 on that need no service_role revoke: name -> reason */
const EXEMPT: Record<string, string> = {};

/** top-level statements: `code` has comments removed and literals / dollar bodies kept; `bodies` holds the dollar bodies */
export function statements(sql: string): { code: string; bodies: string[] }[] {
  const out: { code: string; bodies: string[] }[] = [];
  let code = '';
  let bodies: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? sql.length : j;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 0;
      while (i < sql.length) {
        if (sql.startsWith('/*', i)) { depth += 1; i += 2; } else if (sql.startsWith('*/', i)) { depth -= 1; i += 2; if (depth === 0) break; } else i += 1;
      }
      code += ' ';
      continue;
    }
    const c = sql[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        j = sql.indexOf(c, j);
        if (j < 0) { j = sql.length - 1; break; }
        if (sql[j + 1] === c) { j += 2; continue; }
        break;
      }
      code += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const d = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
    if (d) {
      const end = sql.indexOf(d[0], i + d[0].length);
      const stop = end < 0 ? sql.length : end + d[0].length;
      bodies.push(sql.slice(i + d[0].length, end < 0 ? sql.length : end));
      code += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === ';') {
      if (code.trim()) out.push({ code: code.trim(), bodies });
      code = '';
      bodies = [];
      i += 1;
      continue;
    }
    code += c;
    i += 1;
  }
  if (code.trim()) out.push({ code: code.trim(), bodies });
  return out;
}

/** lower case, identifiers unquoted, whitespace collapsed, "public." removed */
const norm = (s: string): string =>
  s.replace(/"([^"]*)"/g, '$1').toLowerCase().replace(/\s+/g, ' ').replace(/\bpublic\./g, '').trim();

/** split on top-level commas (not inside parentheses) */
function commas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const SENSITIVE = new Set(RELS);
const REACHES_SERVICE_ROLE = new Set(['service_role', 'public']);

/** functions whose body writes one of the 19 relations, over the given migration texts (name only) */
export function writers(texts: string[]): Set<string> {
  const out = new Set<string>();
  const w = new RegExp(`\\b(insert\\s+into|update|delete\\s+from|truncate(\\s+table)?)\\s+(only\\s+)?(public\\.)?(${RELS.join('|')})\\b`, 'i');
  for (const t of texts) {
    for (const st of statements(t)) {
      const m = /^create\s+(or\s+replace\s+)?function\s+(public\.)?("?)(\w+)\3\s*\(/i.exec(st.code);
      if (m && st.bodies.some((b) => w.test(b))) out.add(m[4].toLowerCase());
    }
  }
  return out;
}

/** findings for statements that give service_role something on the 19 relations or EXECUTE on a writer of them,
 * change the owner of one of them or of a function in SERVICE_ROLE_FUNCTIONS, or build a grant to service_role by
 * concatenation inside a dollar-quoted body */
export function regrants(text: string, writerSet: Set<string>): string[] {
  const bad: string[] = [];
  for (const st of statements(text)) {
    const s = norm(st.code);
    const grantees = (g: string) => g.replace(/\s+with\s+(grant|admin|inherit|set)\s+.*$/, '').replace(/\s+granted\s+by\s+\w+$/, '').split(',').map((x) => x.trim());
    const hitsRole = (g: string) => grantees(g).some((x) => REACHES_SERVICE_ROLE.has(x));
    let m = /^grant\s+(.+?)\s+on\s+(table\s+|sequence\s+|function\s+|all\s+tables\s+in\s+schema\s+|all\s+sequences\s+in\s+schema\s+|all\s+functions\s+in\s+schema\s+)?(.+?)\s+to\s+(.+)$/.exec(s);
    if (m) {
      const kind = (m[2] ?? '').trim();
      if (hitsRole(m[4])) {
        if (kind.startsWith('all tables') || kind.startsWith('all sequences')) bad.push(s);
        else if (kind === 'function' || kind.startsWith('all functions')) {
          const names = kind.startsWith('all functions') ? ['*'] : commas(m[3]).map((f) => f.replace(/\(.*$/, '').trim());
          if (names.some((n) => n === '*' || (writerSet.has(n) && !SERVICE_ROLE_FUNCTIONS.includes(n)))) bad.push(s);
        } else if (commas(m[3]).some((o) => SENSITIVE.has(o.trim()))) bad.push(s);
      }
      continue;
    }
    m = /^alter\s+default\s+privileges\b.*\bgrant\s+.+?\s+on\s+(tables|sequences|functions|routines)\s+to\s+(.+)$/.exec(s);
    if (m) {
      if (hitsRole(m[2])) bad.push(s);
      continue;
    }
    m = /^alter\s+(table|sequence|view|materialized\s+view|function|routine)\s+(if\s+exists\s+)?(only\s+)?([\w.]+)\s*(\([^)]*\))?\s+owner\s+to\s+(\w+)$/.exec(s);
    if (m) {
      const name = m[4].split('.').pop()!;
      if (SENSITIVE.has(name) || SERVICE_ROLE_FUNCTIONS.includes(name)) bad.push(s);
      continue;
    }
    m = /^grant\s+([\w, ]+?)\s+to\s+(.+)$/.exec(s);
    if (m && !/\son\s/.test(` ${m[1]} `)) {
      if (grantees(m[2]).includes('service_role')) bad.push(s);
      continue;
    }
    for (const b of st.bodies) {
      const nb = norm(b);
      const dyn = /\bgrant\b[^;]{0,400}?\bto\b[^;]{0,200}?\b(service_role|public)\b/g;
      for (const x of nb.matchAll(dyn)) {
        if (RELS.some((r) => new RegExp(`\\b${r}\\b`).test(x[0])) || /\ball tables\b/.test(x[0])) bad.push(`dynamic: ${x[0].slice(0, 160)}`);
      }
      // a grant assembled by concatenation or format(): red whenever service_role is in the assembled text
      const cat = /\bgrant\b[^;]{0,400}?\bservice_role\b/g;
      for (const x of nb.matchAll(cat)) {
        const around = nb.slice(Math.max(0, x.index! - 40), x.index! + x[0].length);
        if (/\|\||\bformat\s*\(/.test(around)) bad.push(`concatenated: ${x[0].slice(0, 160)}`);
      }
    }
  }
  return [...new Set(bad)];
}

/** names (function name, view name) whose REVOKE in this text includes every role in `need` */
function revokedNames(text: string, kind: 'function' | 'relation'): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const st of statements(text)) {
    const s = norm(st.code);
    const m = kind === 'function'
      ? /^revoke\s+(all(\s+privileges)?|execute)\s+on\s+(function|routine)\s+(.+?)\s+from\s+(.+?)(\s+(cascade|restrict))?$/.exec(s)
      : /^revoke\s+all(\s+privileges)?\s+on\s+(table\s+)?(.+?)\s+from\s+(.+?)(\s+(cascade|restrict))?$/.exec(s);
    if (!m) continue;
    const objs = kind === 'function' ? commas(m[4]).map((f) => f.replace(/\(.*$/, '').trim()) : commas(m[3]).map((o) => o.trim());
    const roles = (kind === 'function' ? m[5] : m[4]).split(',').map((x) => x.trim());
    for (const o of objs) {
      const cur = out.get(o) ?? new Set<string>();
      roles.forEach((r) => cur.add(r));
      out.set(o, cur);
    }
  }
  return out;
}

/** SECURITY DEFINER functions and views over the 19 relations in one migration, without the revoke they need */
export function definersAndViews(text: string): string[] {
  const bad: string[] = [];
  const fnRevoked = revokedNames(text, 'function');
  const relRevoked = revokedNames(text, 'relation');
  const names = new RegExp(`\\b(${RELS.join('|')})\\b`, 'i');
  for (const st of statements(text)) {
    const f = /^create\s+(or\s+replace\s+)?function\s+(public\.)?("?)(\w+)\3\s*\(/i.exec(st.code);
    if (f) {
      const outside = st.code.replace(/\$([A-Za-z_][A-Za-z_0-9]*)?\$[\s\S]*?\$\1\$/g, ' ');
      if (/\bsecurity\s+definer\b/i.test(outside) && st.bodies.some((b) => names.test(b))) {
        const name = f[4].toLowerCase();
        const roles = fnRevoked.get(name) ?? new Set<string>();
        const need = SERVICE_ROLE_FUNCTIONS.includes(name) ? ['public'] : ['public', 'service_role'];
        const miss = need.filter((r) => !roles.has(r));
        if (miss.length) bad.push(`function ${name}: no revoke from ${miss.join(', ')}`);
      }
      continue;
    }
    const v = /^create\s+(or\s+replace\s+)?(materialized\s+)?view\s+(if\s+not\s+exists\s+)?(public\.)?("?)(\w+)\5\b/i.exec(st.code);
    if (v && names.test(st.code.slice(v[0].length))) {
      const name = v[6].toLowerCase();
      if (!(relRevoked.get(name) ?? new Set<string>()).has('service_role')) bad.push(`view ${name}: no revoke from service_role`);
    }
  }
  return bad;
}

/** relations created in one migration: tables (also AS, PARTITION OF, UNLOGGED, SELECT INTO, inside a DO body),
 * materialized views, sequences, and the sequences of serial and identity columns (also added by ALTER TABLE);
 * temporary tables are left out; a CREATE TABLE this cannot parse is returned as 'unparsed: ...' */
export function created(text: string): string[] {
  const out: string[] = [];
  const name = (n: string) => n.replace(/"/g, '').split('.').pop()!.toLowerCase();
  const tableStmt = (code: string) => {
    const head = /^create\s+(global\s+|local\s+)?(temp|temporary|unlogged)?\s*table\s+(if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)\s*/i.exec(code);
    if (!head) return;
    if (head[2] && /^temp/i.test(head[2])) return;
    const t = name(head[4]);
    const rest = code.slice(head[0].length);
    if (/^\(/.test(rest)) {
      out.push(t);
      for (const col of commas(rest.slice(1, rest.lastIndexOf(')')))) {
        const c = /^("?)(\w+)\1\s+(\w+)([\s\S]*)$/i.exec(col.trim());
        if (!c) continue;
        if (/^(small|big)?serial$/i.test(c[3])) out.push(`${t}_${c[2].toLowerCase()}_seq`);
        else if (/\bgenerated\s+(always|by\s+default)\s+as\s+identity\b/i.test(c[4])) out.push(`${t}_${c[2].toLowerCase()}_seq`);
      }
    } else if (/^(partition\s+of\b|as\b|of\b|\(\s*like\b)/i.test(rest) || /^with\b/i.test(rest)) out.push(t);
    else out.push(`unparsed: ${code.slice(0, 80)}`);
  };
  const scan = (code: string) => {
    if (/^create\s+(global\s+|local\s+)?(temp|temporary|unlogged)?\s*table\b/i.test(code)) tableStmt(code);
    const mv = /^create\s+materialized\s+view\s+(if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)/i.exec(code);
    if (mv) out.push(name(mv[2]));
    const q = /^create\s+(temp\s+|temporary\s+)?sequence\s+(if\s+not\s+exists\s+)?((?:"?\w+"?\.)?"?\w+"?)/i.exec(code);
    if (q && !q[1]) out.push(name(q[3]));
    const si = /^select\b[\s\S]*?\binto\s+(unlogged\s+|temp\s+|temporary\s+)?(table\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+from\b/i.exec(code);
    if (si && !/^temp/i.test((si[1] ?? '').trim())) out.push(name(si[3]));
    const alt = /^alter\s+table\s+(if\s+exists\s+)?(only\s+)?((?:"?\w+"?\.)?"?\w+"?)\s+([\s\S]*)$/i.exec(code);
    if (alt) {
      const t = name(alt[3]);
      for (const part of commas(alt[4])) {
        const add = /^add\s+(column\s+)?(if\s+not\s+exists\s+)?("?)(\w+)\3\s+(\w+)([\s\S]*)$/i.exec(part.trim());
        if (add && (/^(small|big)?serial$/i.test(add[5]) || /\bgenerated\s+(always|by\s+default)\s+as\s+identity\b/i.test(add[6]))) {
          out.push(`${t}_${add[4].toLowerCase()}_seq`);
        }
        const gen = /^alter\s+(column\s+)?("?)(\w+)\2\s+add\s+generated\s+(always|by\s+default)\s+as\s+identity\b/i.exec(part.trim());
        if (gen) out.push(`${t}_${gen[3].toLowerCase()}_seq`);
      }
    }
  };
  for (const st of statements(text)) {
    scan(st.code);
    if (/^do\b/i.test(st.code)) {
      // a table created by dynamic SQL in a DO body: its text, with the quotes of string literals removed
      for (const b of st.bodies) for (const inner of statements(b.replace(/''/g, "'").replace(/'/g, ' '))) {
        const k = inner.code.search(/\bcreate\s+((global|local)\s+)?((temp|temporary|unlogged)\s+)?table\b/i);
        if (k >= 0) scan(inner.code.slice(k));
      }
    }
  }
  return out;
}

/** relations named in a REVOKE ALL ... FROM ... service_role, and the renames in one migration (old -> new) */
function revokedFromServiceRole(text: string): Set<string> {
  const out = new Set<string>();
  for (const st of statements(text)) {
    const m = /^revoke\s+all(\s+privileges)?\s+on\s+(table\s+|sequence\s+|materialized\s+view\s+)?(.+?)\s+from\s+(.+?)(\s+(cascade|restrict))?$/.exec(norm(st.code));
    if (m && m[4].split(',').map((x) => x.trim()).includes('service_role')) for (const o of commas(m[3])) out.add(o.trim());
  }
  return out;
}
function renames(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const st of statements(text)) {
    const m = /^alter\s+(table|sequence|materialized\s+view)\s+(if\s+exists\s+)?(\w+)\s+rename\s+to\s+(\w+)$/.exec(norm(st.code));
    if (m) out.push([m[3], m[4]]);
  }
  return out;
}

/** future-table guard over ordered [version, text] pairs; returns the uncovered relations. A relation renamed later
 * keeps its cover: a revoke under any of its names, in the same or a later migration, covers it. */
export function uncovered(files: [string, string][], exempt: Record<string, string>): string[] {
  const bad: string[] = [];
  files.forEach(([v, text], idx) => {
    if (v < '20261123000000') return;
    for (const t of created(text)) {
      if (t.startsWith('unparsed: ')) { bad.push(`${v} ${t}`); continue; }
      if (t in exempt) continue;
      const names = new Set([t]);
      for (const [, later] of files.slice(idx)) for (const [o, n] of renames(later)) if (names.has(o)) names.add(n);
      const covered = files.slice(idx).some(([, later]) => [...revokedFromServiceRole(later)].some((r) => names.has(r)));
      if (!covered) bad.push(`${v} ${t}`);
    }
  });
  return bad;
}

/** the result-detail rule (R1, R2a, R2b of supabase/tests/backlog-4263-sync2-t/result_detail.py), for one SQL text */
export function detailFindings(sql: string): string[] {
  const t = sql.replace(/--[^\n]*/g, (x) => ' '.repeat(x.length)).replace(/'(?:[^']|'')*'/g, (x) => `'${' '.repeat(x.length - 2)}'`);
  const bad: string[] = [];
  for (const m of t.matchAll(/\bSQLERRM\b/gi)) {
    if (!/^\s*(=|<>|!=|(NOT\s+)?I?LIKE)\s*'/i.test(t.slice(m.index! + m[0].length))) bad.push(`R1 at ${m.index}`);
  }
  for (const body of t.split(/\$[A-Za-z_][A-Za-z_0-9]*\$/)) {
    const rows = new Set<string>();
    for (const d of body.matchAll(/\bDECLARE\b([\s\S]*?)\bBEGIN\b/gi)) {
      for (const item of d[1].split(';')) {
        const v = /^\s*([a-z_]\w*)\s+(jsonb|json|record|\w+%rowtype)\b/i.exec(item);
        if (v) rows.add(v[1].toLowerCase());
      }
    }
    for (const call of body.matchAll(/pg_temp\.(pass|rec)\s*\(|RETURN\s+'\s*/gi)) {
      const seg = body.slice(call.index!, call.index! + 600).split(';')[0];
      for (const c of seg.matchAll(/\b([a-z_]\w*)\s*::\s*text\b/gi)) {
        if (rows.has(c[1].toLowerCase()) && seg[c.index! - 1] !== '.') bad.push(`R2a ${c[0]}`);
      }
      for (const c of seg.matchAll(/(\w*)\s*\(([^()]*)\)\s*::\s*text\b/gi)) {
        if (!/^(jsonb_build_object|json_build_object|count|cardinality|length|jsonb_array_length|jsonb_typeof|md5|has_\w+_privilege)$/i.test(c[1])) bad.push(`R2b ${c[0].slice(0, 60)}`);
      }
    }
  }
  return bad;
}

const LANE_FILES: [string, string][] = readdirSync(MIGDIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => [f.slice(0, 14), readFileSync(join(MIGDIR, f), 'utf8').replace(/\r\n?/g, '\n')]);

describe('BACKLOG-4265 migration 20261123160000', () => {
  const st = statements(MIG);

  it('sets lock_timeout first and revokes ALL from service_role on exactly the 19 relations, in four statements', () => {
    expect(norm(st[0].code)).toBe("set local lock_timeout = '3s'");
    const revokes = st.map((x) => norm(x.code)).filter((s) => s.startsWith('revoke'));
    expect(revokes).toHaveLength(4);
    const named: string[] = [];
    for (const r of revokes) {
      const m = /^revoke all on (table|sequence) (.+) from service_role$/.exec(r);
      expect(m).not.toBeNull();
      named.push(...commas(m![2]));
    }
    expect([...named].sort()).toEqual([...RELS].sort());
    expect(new Set(named).size).toBe(19);
  });

  it('changes nothing else: every other top-level statement is a DO block that only reads and checks', () => {
    const other = st.slice(1).filter((x) => !/^revoke\b/i.test(x.code));
    expect(other.map((x) => /^do (\$\w+\$)/.exec(norm(x.code))?.[1])).toEqual(['$pre4265$', '$post4265$']);
    for (const x of other) {
      expect(x.bodies.join('\n')).not.toMatch(/\b(GRANT|REVOKE|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|POLICY|EXECUTE)\s/);
    }
  });

  it('pre-check: postgres only, every relation present with its kind and owner, grantor of every service_role entry = owner, fingerprint of other roles', () => {
    const pre = st.find((x) => /^DO \$pre4265\$/.test(x.code))!.bodies[0];
    expect(pre).toContain("IF current_user IS DISTINCT FROM 'postgres' THEN");
    expect(pre).toContain("a.grantee = 'service_role'::regrole AND a.grantor IS DISTINCT FROM c.relowner");
    expect(pre).toContain("r.owner IS DISTINCT FROM 'postgres'");
    expect(pre).toContain("pg_catalog.pg_get_serial_sequence('public.mcp_call_log', 'id') IS DISTINCT FROM 'public.mcp_call_log_id_seq'");
    expect(pre).toContain("set_config('keepr.m4265_other_acl', v_fp, true)");
    for (const r of RELS) expect(pre).toContain(`'${r}'`);
  });

  it('post-check: every privilege type (MAINTAIN on 17+), column privileges, sequence privileges, no ACL entry, other roles unchanged', () => {
    const post = st.find((x) => /^DO \$post4265\$/.test(x.code))!.bodies[0];
    expect(post).toContain("ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']");
    expect(post).toContain("current_setting('server_version_num')::int >= 170000 THEN ARRAY['MAINTAIN']");
    expect(post).toContain("has_any_column_privilege('service_role', r.oid, 'SELECT, INSERT, UPDATE, REFERENCES')");
    expect(post).toContain("ARRAY['USAGE', 'SELECT', 'UPDATE']");
    expect(post).toContain("current_setting('keepr.m4265_other_acl', true)");
    for (const r of RELS) expect(post).toContain(`'${r}'`);
  });
});

describe('BACKLOG-4265 rollback file', () => {
  it('sets lock_timeout first, refuses a non-postgres caller, and grants back exactly the measured privileges', () => {
    const st = statements(ROLLBACK);
    expect(norm(st[0].code)).toBe("set local lock_timeout = '3s'");
    expect(st[1].bodies[0]).toContain("IF current_user IS DISTINCT FROM 'postgres' THEN");
    const grants = st.map((x) => norm(x.code)).filter((s) => s.startsWith('grant'));
    expect(grants).toHaveLength(4);
    const named: string[] = [];
    for (const g of grants) {
      const m = /^grant (.+) on (table|sequence) (.+) to service_role$/.exec(g);
      expect(m).not.toBeNull();
      const privs = m![1].split(',').map((p) => p.trim().toUpperCase()).sort();
      expect(privs).toEqual([...(m![2] === 'sequence' ? SEQ_PRIVS : TABLE_PRIVS)].sort());
      named.push(...commas(m![3]));
    }
    expect([...named].sort()).toEqual([...RELS].sort());
    expect(st.map((x) => norm(x.code)).filter((s) => /^(revoke|create|alter|drop|insert|update)\b/.test(s))).toEqual([]);
    expect(st.map((x) => norm(x.code)).filter((s) => s.startsWith('delete'))).toEqual([
      `delete from supabase_migrations.schema_migrations where version = '${VERSION}'`,
    ]);
  });
});

describe('BACKLOG-4265 production post-check of 20261123160000', () => {
  it('pins service_role holding nothing on each of the 19 relations, MUST HOLD', () => {
    const rows = [...POSTCHECK.matchAll(/^\s+\('(\w+)', 'table', 'service_role', '([^']*)', '([^']+)'\)/gm)].map((m) => [m[1], m[2], m[3]]);
    expect(rows.map((r) => r[0]).sort()).toEqual([...RELS].sort());
    for (const r of rows) expect(r.slice(1)).toEqual(['', 'pre-lane table grants api role']);
    expect(POSTCHECK).toMatch(/\('pre-lane table grants api role', true\)/);
  });
});

describe('BACKLOG-4265 future-table guard', () => {
  const corpus: [string, [string, string][], string[]][] = [
    ['created and revoked in the same file', [['20261124000000', 'CREATE TABLE public.t1 (id uuid);\nREVOKE ALL ON TABLE public.t1 FROM PUBLIC, anon, authenticated, service_role;']], []],
    ['created, revoked in a later file', [['20261124000000', 'CREATE TABLE IF NOT EXISTS public.t1 (id uuid);'], ['20261124000001', 'REVOKE ALL ON TABLE public.t0, public.t1 FROM service_role;']], []],
    ['created, never revoked', [['20261124000000', 'CREATE TABLE public.t1 (id uuid);']], ['20261124000000 t1']],
    ['revoked from the client roles only', [['20261124000000', 'CREATE TABLE public.t1 (id uuid);\nREVOKE ALL ON TABLE public.t1 FROM PUBLIC, anon, authenticated;']], ['20261124000000 t1']],
    ['only SELECT revoked', [['20261124000000', 'CREATE TABLE public.t1 (id uuid);\nREVOKE SELECT ON TABLE public.t1 FROM service_role;']], ['20261124000000 t1']],
    ['revoked in an earlier file than the create', [['20261124000000', 'REVOKE ALL ON TABLE public.t1 FROM service_role;'], ['20261124000001', 'CREATE TABLE public.t1 (id uuid);']], ['20261124000001 t1']],
    ['identity column without its sequence', [['20261124000000', 'CREATE TABLE public.t1 (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, x text);\nREVOKE ALL ON TABLE public.t1 FROM service_role;']], ['20261124000000 t1_id_seq']],
    ['identity column with its sequence', [['20261124000000', 'CREATE TABLE public.t1 (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);\nREVOKE ALL ON TABLE public.t1 FROM service_role;\nREVOKE ALL ON SEQUENCE public.t1_id_seq FROM service_role;']], []],
    ['a sequence never revoked', [['20261124000000', 'CREATE SEQUENCE IF NOT EXISTS public.s1 AS bigint;']], ['20261124000000 s1']],
    ['a quoted, unqualified name', [['20261124000000', 'CREATE TABLE "t1" (id uuid);\nREVOKE ALL ON TABLE "t1" FROM "service_role";']], []],
    ['before 20261123000000 is out of scope', [['20261122000000', 'CREATE TABLE public.t1 (id uuid);']], []],
    ['CREATE TABLE AS', [['20261124000000', 'CREATE TABLE public.t1 AS SELECT 1 AS x;']], ['20261124000000 t1']],
    ['PARTITION OF', [['20261124000000', "CREATE TABLE public.t1_p PARTITION OF public.t1 FOR VALUES IN ('a');"]], ['20261124000000 t1_p']],
    ['UNLOGGED', [['20261124000000', 'CREATE UNLOGGED TABLE public.t1 (id uuid);']], ['20261124000000 t1']],
    ['a temporary table is left out', [['20261124000000', 'CREATE TEMP TABLE t1 (id uuid);\nCREATE TEMPORARY TABLE t2 AS SELECT 1;']], []],
    ['SELECT INTO', [['20261124000000', 'SELECT 1 AS x INTO public.t1 FROM public.t0;']], ['20261124000000 t1']],
    ['inside a DO body', [['20261124000000', "DO $x$ BEGIN EXECUTE 'CREATE TABLE public.t1 (id uuid)'; END $x$;"]], ['20261124000000 t1']],
    ['a serial column', [['20261124000000', 'CREATE TABLE public.t1 (id bigserial PRIMARY KEY);\nREVOKE ALL ON TABLE public.t1 FROM service_role;']], ['20261124000000 t1_id_seq']],
    ['identity added by ALTER ... ADD COLUMN', [['20261124000000', 'ALTER TABLE public.t9 ADD COLUMN n bigint GENERATED BY DEFAULT AS IDENTITY;']], ['20261124000000 t9_n_seq']],
    ['identity added by ALTER COLUMN ... ADD GENERATED', [['20261124000000', 'ALTER TABLE public.t9 ALTER COLUMN n ADD GENERATED ALWAYS AS IDENTITY;']], ['20261124000000 t9_n_seq']],
    ['a materialized view', [['20261124000000', 'CREATE MATERIALIZED VIEW public.v1 AS SELECT 1;']], ['20261124000000 v1']],
    ['renamed, revoked under the new name', [['20261124000000', 'CREATE TABLE public.t1 (id uuid);'], ['20261124000001', 'ALTER TABLE public.t1 RENAME TO t2;\nREVOKE ALL ON TABLE public.t2 FROM service_role;']], []],
    ['renamed, revoked under the old name first', [['20261124000000', 'CREATE TABLE public.t1 (id uuid);\nREVOKE ALL ON TABLE public.t1 FROM service_role;\nALTER TABLE public.t1 RENAME TO t2;']], []],
    ['a CREATE TABLE the parser cannot read', [['20261124000000', 'CREATE TABLE public.t1 OF some_type;']], ['20261124000000 t1']],
  ];
  it.each(corpus)('corpus: %s', (_name, files, want) => {
    expect(uncovered(files, {})).toEqual(want);
  });

  it('every table and sequence created from 20261123000000 on is revoked from service_role, or exempt with a reason', () => {
    expect(uncovered(LANE_FILES, EXEMPT)).toEqual([]);
    for (const [k, why] of Object.entries(EXEMPT)) expect(`${k}: ${why}`.length).toBeGreaterThan(k.length + 10);
    // the guard sees the lane's tables (positive control)
    const seen = LANE_FILES.filter(([v]) => v >= '20261123000000').flatMap(([, t]) => created(t));
    expect(seen).toEqual(expect.arrayContaining(['cloud_release_switches', 'cloud_computer_moves', 'cloud_computer_move_notices',
      'cloud_blob_erase_runs', 'cloud_blob_erase_leases', 'mcp_message_reads']));
  });
});

describe('BACKLOG-4265 no later privilege on the 19 relations for service_role', () => {
  const W = writers(LANE_FILES.map(([, t]) => t));
  const red: [string, string][] = [
    ['no TABLE keyword', 'GRANT SELECT ON public.mcp_tokens TO service_role;'],
    ['unqualified name', 'GRANT SELECT ON TABLE mcp_tokens TO service_role;'],
    ['the relation second in the list', 'GRANT SELECT ON TABLE public.other_x, public.mcp_tokens TO service_role;'],
    ['quoted identifiers', 'GRANT SELECT ON TABLE public."mcp_tokens" TO "service_role";'],
    ['lower case', 'grant select on table public.cloud_deals to service_role;'],
    ['through PUBLIC', 'GRANT SELECT ON TABLE public.cloud_blobs TO PUBLIC;'],
    ['the sequence', 'GRANT USAGE ON SEQUENCE public.mcp_call_log_id_seq TO service_role;'],
    ['every table of the schema', 'GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;'],
    ['default privileges', 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;'],
    ['a role membership', 'GRANT authenticated TO service_role;'],
    ['EXECUTE on a function that writes one of them', 'GRANT EXECUTE ON FUNCTION public._mcp_bump(text, interval, integer) TO service_role;'],
    ['dynamic SQL in a DO block', "DO $x$ BEGIN EXECUTE 'GRANT SELECT ON public.cloud_deals TO service_role'; END $x$;"],
    ['OWNER TO on one of them', 'ALTER TABLE public.cloud_blobs OWNER TO service_role;'],
    ['OWNER TO on a service_role function', 'ALTER FUNCTION public.cloud_blob_erase_scrub(uuid, uuid, boolean, integer) OWNER TO someone;'],
    ['a grant built by concatenation', "DO $x$ DECLARE t text := 'x'; BEGIN EXECUTE 'GRANT SELECT ON public.' || t || ' TO service_role'; END $x$;"],
    ['a grant built by format()', "DO $x$ BEGIN EXECUTE format('GRANT SELECT ON %I TO service_role', 'x'); END $x$;"],
  ];
  const green: [string, string][] = [
    ['migration 20261123160000 itself', MIG],
    ['a grant to authenticated', 'GRANT SELECT ON TABLE public.cloud_deals TO authenticated;'],
    ['a revoke', 'REVOKE ALL ON TABLE public.mcp_tokens, public.cloud_deals FROM service_role;'],
    ['a function already granted to service_role', 'GRANT EXECUTE ON FUNCTION public.cloud_blob_erase_scrub(uuid, uuid, boolean, integer) TO service_role;'],
    ['another table', 'GRANT ALL ON TABLE public.unrelated TO service_role;'],
    ['a comment', '-- GRANT SELECT ON mcp_tokens TO service_role\nSELECT 1;'],
    ['a string literal', "SELECT 'GRANT SELECT ON mcp_tokens TO service_role';"],
  ];
  it('the writer set holds a known writer (positive control) and the functions already granted to service_role', () => {
    expect(W.has('_mcp_bump')).toBe(true);
    expect(W.has('cloud_upsert_messages')).toBe(true);
    expect(W.has('cloud_blob_erase_scrub')).toBe(true);
  });
  it.each(red)('red: %s', (_n, sql) => expect(regrants(sql, W)).toHaveLength(1));
  it.each(green)('green: %s', (_n, sql) => expect(regrants(sql, W)).toEqual([]));
  it('OWNER TO on an unrelated table stays green', () => expect(regrants('ALTER TABLE public.unrelated OWNER TO postgres;', W)).toEqual([]));
  it('no migration after 20261123160000 has such a statement', () => {
    const later = LANE_FILES.filter(([v]) => v > VERSION);
    expect(later.length).toBeGreaterThan(0);
    expect(later.flatMap(([v, t]) => regrants(t, W).map((x) => `${v}: ${x}`))).toEqual([]);
  });
});

describe('BACKLOG-4265 SECURITY DEFINER functions and views over the 19 relations', () => {
  const fn = (opts: string, body: string, after = '') =>
    `CREATE OR REPLACE FUNCTION public.f1() RETURNS bigint LANGUAGE sql ${opts} SET search_path = '' AS $f$ ${body} $f$;\n${after}`;
  const corpus: [string, string, number][] = [
    ['definer reading a content table, no revoke', fn('SECURITY DEFINER', 'SELECT count(*) FROM public.cloud_deal_messages'), 1],
    ['definer revoked from PUBLIC only', fn('SECURITY DEFINER', 'SELECT count(*) FROM public.mcp_tokens', 'REVOKE ALL ON FUNCTION public.f1() FROM PUBLIC;'), 1],
    ['definer revoked from PUBLIC and service_role', fn('SECURITY DEFINER', 'SELECT count(*) FROM public.mcp_tokens', 'REVOKE ALL ON FUNCTION public.f1() FROM PUBLIC, anon, authenticated, service_role;'), 0],
    ['definer revoked with REVOKE EXECUTE', fn('SECURITY DEFINER', 'SELECT count(*) FROM public.cloud_deals', 'REVOKE EXECUTE ON FUNCTION public.f1() FROM PUBLIC, service_role;'), 0],
    ['invoker reading a content table', fn('SECURITY INVOKER', 'SELECT count(*) FROM public.cloud_deal_messages'), 0],
    ['definer naming no relation of the 19', fn('SECURITY DEFINER', 'SELECT count(*) FROM public.other_table'), 0],
    ['a function service_role runs, revoked from PUBLIC', `CREATE OR REPLACE FUNCTION public.cloud_blob_erase_scrub(p uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $f$ BEGIN UPDATE public.cloud_deal_files SET removed_at = now(); RETURN '{}'; END $f$;
REVOKE ALL ON FUNCTION public.cloud_blob_erase_scrub(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cloud_blob_erase_scrub(uuid) TO service_role;`, 0],
    ['a view over a content table, no revoke', 'CREATE VIEW public.v1 AS SELECT id FROM public.cloud_deal_messages;', 1],
    ['a materialized view over one of them, no revoke', 'CREATE MATERIALIZED VIEW public.v1 AS SELECT id FROM public.mcp_tokens;', 1],
    ['a view with its revoke', 'CREATE OR REPLACE VIEW public.v1 AS SELECT id FROM public.cloud_deals;\nREVOKE ALL ON TABLE public.v1 FROM PUBLIC, anon, authenticated, service_role;', 0],
    ['a view over another table', 'CREATE VIEW public.v1 AS SELECT 1 FROM public.other_table;', 0],
  ];
  it.each(corpus)('corpus: %s', (_n, sql, want) => expect(definersAndViews(sql)).toHaveLength(want));
  it('no migration after 20261123160000 has one (and 20261123170000, a definer over mcp tables, is seen and revoked)', () => {
    const later = LANE_FILES.filter(([v]) => v > VERSION);
    expect(later.flatMap(([v, t]) => definersAndViews(t).map((x) => `${v}: ${x}`))).toEqual([]);
    const cn = later.find(([v]) => v === '20261123170000')![1];
    expect(definersAndViews(cn.replace(/REVOKE ALL ON FUNCTION public\.mcp_exchange_code\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/, ''))).toHaveLength(1);
  });
});

describe('BACKLOG-4265 result-detail rule on backlog-4265', () => {
  const DIR = 'supabase/tests/backlog-4265';
  const composed = ['supabase/tests/backlog-4263-sync2-t/lib/helpers.sql', 'supabase/tests/backlog-4263-sync2-t/lib/fixtures.sql'].map(read);
  const own = (p: string) => composed.reduce((t, c) => t.split(c).join(''), read(p));
  it.each(['lib/controls.sql', 'lib/helpers.sql', 'harness-4265.sql', 'harness-4265-structure.sql', 'harness-4265-fixtures.sql',
    `rollback-${VERSION}.sql`])('%s: no finding', (f) => expect(detailFindings(own(`${DIR}/${f}`))).toEqual([]));
  it('the rule is switched on for backlog-4265 only in the shared checker', () => {
    const rd = read('supabase/tests/backlog-4263-sync2-t/result_detail.py');
    expect(rd).toContain("'backlog-4265': True,");
    expect((rd.match(/^ {4}'backlog-[\w-]+': (True|False),$/gm) ?? []).filter((l) => l.endsWith('True,'))).toEqual(["    'backlog-4265': True,"]);
    expect(read('supabase/tests/backlog-4263-sync2-t/call_shape.py')).toContain('probs += result_detail.check(here)');
  });
  const red: [string, string][] = [
    ['a JSON variable cast to text', "CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ DECLARE cl jsonb; BEGIN RETURN pg_temp.pass(true, jsonb_build_object('claim', left(cl::text, 200))::text); END $c$;"],
    ['SQLERRM recorded', "DO $x$ BEGIN NULL; EXCEPTION WHEN OTHERS THEN res := 'E ' || SQLERRM; END $x$;"],
    ['a function result cast to text', "CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ BEGIN RETURN pg_temp.pass(true, public.answer()::text); END $c$;"],
  ];
  const green: [string, string][] = [
    ['type and keys only', "CREATE FUNCTION pg_temp.c() RETURNS text LANGUAGE plpgsql AS $c$ DECLARE cl jsonb; BEGIN RETURN pg_temp.pass(true, jsonb_build_object('type', jsonb_typeof(cl))::text); END $c$;"],
    ['SQLERRM compared', "DO $x$ BEGIN NULL; EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'undo' THEN res := SQLSTATE; END IF; END $x$;"],
  ];
  it.each(red)('red: %s', (_n, sql) => expect(detailFindings(sql).length).toBeGreaterThan(0));
  it.each(green)('green: %s', (_n, sql) => expect(detailFindings(sql)).toEqual([]));
});
