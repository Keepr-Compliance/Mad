/**
 * BACKLOG-3535 items 2 and 4 — text tripwire for *_backlog_3535_solo_checklists.sql.
 *
 * The database behaviour is proven on a real Postgres by the 3473 harness
 * (supabase/tests/backlog-3473, controls C41 and C42, mutants m71-m77). This
 * file runs in CI and pins what the harness cannot see, or what a later edit is
 * most likely to change quietly:
 *
 *   - the owner clause sits INSIDE the membership EXISTS. Moved outside, the
 *     rule is equivalent on every database input today (check_feature_access
 *     refuses a non-member first), so no harness control can go red for it —
 *     this test is its only control (SR ruling on the plan);
 *   - the role list is exactly broker / admin / it_admin; no tier literal;
 *     the feature is still decided by check_feature_access;
 *   - the seed floor reads feature_definitions.min_tier, compared with `<`;
 *   - the file only replaces the two functions: no GRANT, REVOKE, trigger,
 *     DROP or data change (CREATE OR REPLACE keeps each function's ACL);
 *   - it is the last definer of both functions;
 *   - the header carries the rollback bodies and the backfill query, and the
 *     backfill no longer excludes personal organizations.
 *
 * WHAT THIS CAN PROVE: what the migration file says. Not that it is applied.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../../../supabase/migrations');
const SUFFIX = '_backlog_3535_solo_checklists.sql';

/** Read a migration with CRLF normalised (Windows CI checks out with CRLF). */
const readMigration = (file: string): string =>
  readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/\r\n?/g, '\n');

/** Remove block comments, then `--` comments (whole-line and trailing) outside single quotes. */
function stripSqlComments(sql: string): string {
  const noBlocks = sql.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks
    .split('\n')
    .map((line) => {
      let inQuote = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'") inQuote = !inQuote;
        else if (!inQuote && c === '-' && line[i + 1] === '-') return line.slice(0, i).replace(/\s+$/, '');
      }
      return line;
    })
    .join('\n');
}

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const MATCHES = MIGRATION_FILES.filter((f) => f.endsWith(SUFFIX));
const FILE = MATCHES[0] ?? '';
const RAW = FILE ? readMigration(FILE) : '';
const CODE = stripSqlComments(RAW);

const definerRe = (name: string): RegExp =>
  new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+("?public"?\\.)?"?${name}"?\\s*\\(`, 'i');

/** Header (up to AS $$) and body (between $$ ... $$) of `name` in comment-stripped `sql`. */
function definition(sql: string, name: string): { header: string; body: string } {
  const m = definerRe(name).exec(sql);
  if (!m) throw new Error(`${name} not defined`);
  const rest = sql.slice(m.index);
  const open = rest.indexOf('$$');
  const close = rest.indexOf('$$', open + 2);
  if (open === -1 || close === -1) throw new Error(`${name}: no $$ body`);
  return { header: rest.slice(0, open), body: rest.slice(open + 2, close) };
}

/** The text inside the parentheses that open at `openIdx` (which must be '('). */
function parenBlock(text: string, openIdx: number): string {
  if (text[openIdx] !== '(') throw new Error('parenBlock: not an opening parenthesis');
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  throw new Error('parenBlock: unbalanced');
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const TIER_LITERALS = ["'individual'", "'team'", "'enterprise'", "'custom'", "'keepr-internal'"];

describe(`BACKLOG-3535 *${SUFFIX}`, () => {
  it('exists exactly once, with a stamp after every file it builds on', () => {
    expect(MATCHES).toHaveLength(1);
    expect(FILE).toMatch(/^\d{14}_backlog_3535_solo_checklists\.sql$/);
    // min_tier individual (item 1), the 3474 save + audit files, and the
    // highest stamp on any branch when this was written.
    for (const earlier of [
      '20260924183422_backlog_3535_checklists_min_tier_individual.sql',
      '20260924224113_backlog_3474_template_audit_fields.sql',
      '20260924234221',
    ]) {
      expect(FILE > earlier).toBe(true);
    }
  });

  it.each(['can_edit_checklist_templates', '_seed_checklists_on_plan_write'])(
    'is the last migration that defines %s',
    (name) => {
      const definers = MIGRATION_FILES.filter((f) => definerRe(name).test(stripSqlComments(readMigration(f))));
      expect(definers[definers.length - 1]).toBe(FILE);
    }
  );

  it('only replaces the two functions: no grant, revoke, trigger, drop, data change or transaction control', () => {
    const creates = CODE.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+public\.\w+/gi) ?? [];
    expect(creates.map(squash)).toEqual([
      'CREATE OR REPLACE FUNCTION public.can_edit_checklist_templates',
      'CREATE OR REPLACE FUNCTION public._seed_checklists_on_plan_write',
    ]);
    for (const forbidden of [
      /\bGRANT\b/i,
      /\bREVOKE\b/i,
      /\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i,
      /\bDROP\b/i,
      /\bALTER\b/i,
      /\bINSERT\s+INTO\b/i,
      /\bDELETE\s+FROM\b/i,
      /^\s*UPDATE\b/im,
      /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im,
    ]) {
      expect(CODE).not.toMatch(forbidden);
    }
  });

  describe('can_edit_checklist_templates', () => {
    const { header, body } = definition(CODE, 'can_edit_checklist_templates');

    it('keeps its runtime properties: sql, STABLE, SECURITY DEFINER, search_path public', () => {
      const h = squash(header);
      expect(h).toContain('RETURNS boolean');
      expect(h).toContain('LANGUAGE sql');
      expect(h).toContain('STABLE');
      expect(h).toContain('SECURITY DEFINER');
      expect(h).toContain('SET search_path = public');
    });

    it('puts the owner clause INSIDE the membership EXISTS, on the member being tested', () => {
      const existsAt = body.search(/EXISTS\s*\(/i);
      expect(existsAt).toBeGreaterThan(-1);
      const inner = squash(parenBlock(body, body.indexOf('(', existsAt)));
      expect(inner).toContain('m.organization_id = p_org_id');
      expect(inner).toContain('m.user_id = (SELECT auth.uid())');
      expect(inner).toContain(
        "AND (m.role IN ('broker', 'admin', 'it_admin') OR o.personal_owner_user_id = m.user_id)"
      );
      expect(inner).toMatch(/JOIN public\.organizations o ON o\.id = m\.organization_id/);
      // Exactly one reference to the owner marker in the whole body: none outside.
      expect(body.match(/personal_owner_user_id/g) ?? []).toHaveLength(1);
    });

    it('names exactly broker, admin and it_admin, and no tier', () => {
      expect(body.match(/m\.role IN \(([^)]*)\)/g)).toEqual(["m.role IN ('broker', 'admin', 'it_admin')"]);
      expect(body).not.toContain("'agent'");
      for (const tier of TIER_LITERALS) expect(body).not.toContain(tier);
      expect(body).not.toMatch(/tier_rank/i);
    });

    it('still decides the feature through check_feature_access, ANDed after the membership test', () => {
      expect(squash(body)).toMatch(
        /\) AND COALESCE\(\(public\.check_feature_access\(p_org_id, 'transaction_checklists'\) ->> 'allowed'\)::boolean, false\);?$/
      );
    });
  });

  describe('_seed_checklists_on_plan_write', () => {
    const { header, body } = definition(CODE, '_seed_checklists_on_plan_write');

    it('keeps its runtime properties: trigger, plpgsql, SECURITY DEFINER, search_path public', () => {
      const h = squash(header);
      expect(h).toContain('RETURNS trigger');
      expect(h).toContain('LANGUAGE plpgsql');
      expect(h).toContain('SECURITY DEFINER');
      expect(h).toContain('SET search_path = public');
    });

    it("floors on the feature's min_tier with `<`, before seeding, and names no tier", () => {
      const b = squash(body);
      const floor =
        "IF public.tier_rank((SELECT p.tier FROM public.plans p WHERE p.id = NEW.plan_id)) < public.tier_rank((SELECT fd.min_tier FROM public.feature_definitions fd WHERE fd.key = 'transaction_checklists')) THEN RETURN NULL; END IF;";
      expect(b).toContain(floor);
      expect(b.indexOf(floor)).toBeLessThan(b.indexOf('PERFORM public._seed_org_checklist_templates(NEW.organization_id);'));
      expect(b).not.toContain('<=');
      for (const tier of TIER_LITERALS) expect(body).not.toContain(tier);
    });
  });

  describe('header', () => {
    const comments = RAW.split('\n')
      .filter((l) => /^\s*--/.test(l))
      .join('\n');

    it('carries the rollback bodies of both functions', () => {
      expect(comments).toMatch(/ROLLBACK/);
      expect(comments).toContain("--                 AND m.role IN ('broker', 'admin', 'it_admin')");
      expect(comments).toContain("--        < public.tier_rank('team') THEN");
    });

    it('labels the backfill, keyed on min_tier, without the personal-organization exclusion', () => {
      expect(comments).toMatch(/BACKFILL -- run after catalogue content lands/);
      const at = comments.indexOf('SELECT public._seed_org_checklist_templates(op.organization_id)');
      expect(at).toBeGreaterThan(-1);
      const query = comments.slice(at, comments.indexOf(';', at));
      expect(query).toContain("(SELECT min_tier FROM public.feature_definitions WHERE key = 'transaction_checklists')");
      expect(query).not.toContain('personal_owner_user_id');
    });

    it('explains why the floor follows min_tier: no trigger on plan_features', () => {
      expect(comments).toContain('There is NO trigger on plan_features');
    });
  });
});
