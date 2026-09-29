/**
 * BACKLOG-3473 — control C23, the CI tripwire for the transaction-checklist
 * migrations.
 *
 * WHAT THIS CAN PROVE: what the migration files say.
 *
 * WHAT IT CANNOT: behaviour, or what a database actually runs. CI has no
 * database. The behaviour is proved by the executable controls in
 * supabase/tests/backlog-3473/, run against a real Postgres + PostgREST stack.
 * This file guards the lines a later edit is most likely to change quietly.
 *
 * The min-tier guard is checked per function BODY, not per file:
 *   For each of check_feature_access, get_org_features, broker_get_org_features
 *   and _reject_feature_override_above_tier, take the lexically LAST migration
 *   that defines it (after `--` and block comments are removed), take the text
 *   between that definition's opening and closing dollar-quote tags, and
 *   require a call to _override_above_tier( inside it. A later migration that
 *   re-creates one of these functions without the call turns this red, even
 *   when it spells the name quoted ("public"."get_org_features").
 *
 * Limits, stated:
 *   - "Lexically last" is "in force" only for files a migration runner applies
 *     in name order. Several legacy 8-digit files were applied out of order
 *     (check_feature_access, get_org_features and admin_assign_org_plan are
 *     live from files that are NOT their lexically last definition). Once the
 *     BACKLOG-3473 files land they are the last definition of all four
 *     functions, and scripts/check-migration-names.mjs forces a 14-digit stamp
 *     on every new file, so the check is sound from here on.
 *   - Name order compares character by character, and '1' < '_', so a
 *     14-digit stamp sorts BEFORE an 8-digit legacy file of the same date.
 *     Irrelevant for any date after 2026-03-16, the last legacy file.
 *   - It reads repo text only. Whether production matches the repo is the
 *     harness gate's job (supabase/tests/backlog-3473/run.sh gate).
 *   - Comment removal is line-based and quote-aware for single-quoted strings;
 *     a string literal that spans lines and contains `--` would confuse it.
 *     None of the files read here has one.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const GUARD_FILE = '20260921101756_backlog_3473_feature_reads_honour_min_tier.sql';
const SCHEMA_FILE = '20260921101757_backlog_3473_transaction_checklists.sql';
const RETIRE_FILE = '20260921101758_backlog_3473_retire_unused_org_columns.sql';

const DOCUMENT_TYPES = [
  'offer', 'inspection', 'disclosure', 'contract', 'appraisal',
  'amendment', 'addendum', 'title', 'closing', 'other',
];

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

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The K2 header pattern: optional OR REPLACE, optional (quoted) public schema, optionally quoted name. */
const headerRe = (name: string): RegExp =>
  new RegExp(
    `CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+("?public"?\\.)?"?${escapeRe(name)}"?\\s*\\(`,
    'gi'
  );

interface Definition {
  file: string;
  header: string;
  body: string;
}

/** Every definition of `name` in `sql` (already comment-stripped), in file order. */
function definitionsIn(file: string, sql: string, name: string): Definition[] {
  const out: Definition[] = [];
  const re = headerRe(name);
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const rest = sql.slice(m.index);
    const open = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (!open) throw new Error(`${file}: ${name} has no opening dollar-quote tag`);
    const bodyStart = open.index + open[0].length;
    const close = rest.indexOf(open[0], bodyStart);
    if (close === -1) throw new Error(`${file}: ${name} has no closing ${open[0]}`);
    out.push({ file, header: rest.slice(0, open.index), body: rest.slice(bodyStart, close) });
  }
  return out;
}

/** The body of the definition of `name` in the lexically last migration that defines it. */
function lastDefinition(name: string): Definition {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let last: Definition | undefined;
  for (const file of files) {
    const defs = definitionsIn(file, stripSqlComments(readMigration(file)), name);
    if (defs.length > 0) last = defs[defs.length - 1];
  }
  if (!last) throw new Error(`no migration defines ${name}`);
  return last;
}

const callsHelper = (body: string): boolean => /(^|[^A-Za-z0-9_])_override_above_tier\s*\(/.test(body);

/** Split one parenthesised VALUES tuple on top-level commas, keeping quoted strings whole. */
function splitTuple(tuple: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (const c of tuple) {
    if (c === "'") inQuote = !inQuote;
    if (c === ',' && !inQuote) {
      parts.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur.trim());
  return parts;
}

/** The column -> value map of the feature_definitions INSERT in the schema migration. */
function featureRow(sql: string): Record<string, string> {
  const stmt = sql.slice(sql.indexOf('INSERT INTO public.feature_definitions'));
  const cols = /INSERT INTO public\.feature_definitions\s*\(([^)]*)\)/.exec(stmt);
  const vals = /VALUES\s*\(([\s\S]*?)\)\s*ON CONFLICT/.exec(stmt);
  if (!cols || !vals) throw new Error('feature_definitions INSERT not found');
  const names = cols[1].split(',').map((s) => s.trim());
  const values = splitTuple(vals[1]);
  if (values.length !== names.length) {
    throw new Error(`feature_definitions INSERT: ${names.length} columns, ${values.length} values`);
  }
  return Object.fromEntries(names.map((n, i) => [n, values[i]]));
}

/** The quoted items of the first `IN ( ... )` list after `anchor` in `text`. */
function inListAfter(text: string, anchor: string): string[] {
  const at = text.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found: ${anchor}`);
  const m = /IN\s*\(([^)]*)\)/.exec(text.slice(at));
  if (!m) throw new Error(`no IN list after ${anchor}`);
  return (m[1].match(/'[^']*'/g) ?? []).map((s) => s.slice(1, -1));
}

describe('BACKLOG-3473 migrations (C23)', () => {
  const schema = stripSqlComments(readMigration(SCHEMA_FILE));

  it('ships three 14-digit migrations with no transaction control of their own', () => {
    // The harness loads each file with \i inside its own transaction; a COMMIT
    // in a file would commit fixtures to the shared test venue.
    for (const file of [GUARD_FILE, SCHEMA_FILE, RETIRE_FILE]) {
      expect(file).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
      const code = stripSqlComments(readMigration(file));
      expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    }
  });

  describe('the transaction_checklists feature row', () => {
    const row = featureRow(schema);

    it('is keyed transaction_checklists', () => {
      expect(row.key).toBe("'transaction_checklists'");
    });

    it("defaults to 'false' -- a plan-less organization reads only this value", () => {
      expect(row.value_type).toBe("'boolean'");
      expect(row.default_value).toBe("'false'");
    });

    it("carries min_tier 'team'", () => {
      expect(row.min_tier).toBe("'team'");
    });

    it('ships not built, in the access category, beside broker_submission', () => {
      expect(row.is_built).toBe('false');
      expect(row.category).toBe("'access'");
      expect(row.sort_order).toBe('135');
    });

    it('is inserted with ON CONFLICT (key) DO NOTHING', () => {
      const stmt = schema.slice(schema.indexOf('INSERT INTO public.feature_definitions'));
      expect(stmt.slice(0, stmt.indexOf(';'))).toMatch(/ON CONFLICT \(key\) DO NOTHING$/);
    });
  });

  describe('the transaction_checklists plan rows', () => {
    const start = schema.indexOf('INSERT INTO public.plan_features');
    const stmt = schema.slice(start, schema.indexOf(';', start) + 1);

    it('enables the feature on enterprise and keepr-internal only', () => {
      const list = /FROM \(VALUES([\s\S]*?)\)\s*AS v\(slug, enabled\)/.exec(stmt);
      expect(list).not.toBeNull();
      const rows = Object.fromEntries(
        [...(list as RegExpExecArray)[1].matchAll(/\(\s*'([^']+)'\s*,\s*(true|false)\s*\)/g)].map((m) => [m[1], m[2]])
      );
      expect(rows).toEqual({ individual: 'false', team: 'false', enterprise: 'true', 'keepr-internal': 'true' });
    });

    it('joins plans by slug and the feature by its key, and never overwrites an existing row', () => {
      expect(stmt).toMatch(/JOIN public\.plans p ON p\.slug = v\.slug/);
      expect(stmt).toMatch(/JOIN public\.feature_definitions fd ON fd\.key = 'transaction_checklists'/);
      expect(stmt).toMatch(/ON CONFLICT \(plan_id, feature_id\) DO NOTHING;$/);
      expect(stmt).not.toMatch(/\bCASE\b/i);
    });
  });

  describe('the min-tier guard, per function body (K2)', () => {
    it.each([
      'check_feature_access',
      'get_org_features',
      'broker_get_org_features',
      '_reject_feature_override_above_tier',
    ])('the last definition of %s calls _override_above_tier(', (name) => {
      const def = lastDefinition(name);
      expect({ file: def.file, callsHelper: callsHelper(def.body) }).toEqual({ file: def.file, callsHelper: true });
    });

    it('the last definition of _override_above_tier compares tier_rank( values', () => {
      const def = lastDefinition('_override_above_tier');
      expect(def.body).toMatch(/tier_rank\s*\(/);
    });

    it('the last definition of _override_above_tier applies to every feature, not transaction_checklists only', () => {
      const def = lastDefinition('_override_above_tier');
      expect(def.body).not.toMatch(/p_feature_key\s*=\s*'transaction_checklists'/);
    });

    it('finds a definition whose schema and name are quoted', () => {
      // A later file written by `supabase db diff` uses this form; the finder
      // must not skip it and fall back to an earlier, guarded definition.
      const sql = [
        'CREATE OR REPLACE FUNCTION "public"."get_org_features"("p_org_id" "uuid") RETURNS "jsonb"',
        '    LANGUAGE "plpgsql" STABLE SECURITY DEFINER',
        '    AS $_$ BEGIN RETURN NULL; END; $_$;',
      ].join('\n');
      const defs = definitionsIn('synthetic.sql', sql, 'get_org_features');
      expect(defs).toHaveLength(1);
      expect(callsHelper(defs[0].body)).toBe(false);
    });

    it('does not count the helper name inside a commented-out line', () => {
      const sql = [
        'CREATE OR REPLACE FUNCTION public.get_org_features(p_org_id uuid) RETURNS jsonb LANGUAGE plpgsql AS $$',
        'BEGIN',
        '  -- v_blocked := public._override_above_tier(a, b, c, d);',
        '  RETURN NULL; -- public._override_above_tier(a, b, c, d)',
        'END $$;',
      ].join('\n');
      const defs = definitionsIn('synthetic.sql', stripSqlComments(sql), 'get_org_features');
      expect(defs).toHaveLength(1);
      expect(callsHelper(defs[0].body)).toBe(false);
    });
  });

  it('validates catalogue document types against the same 10 values as the items CHECK', () => {
    const validator = definitionsIn(SCHEMA_FILE, schema, '_checklist_seed_items_valid');
    expect(validator).toHaveLength(1);
    const fromValidator = inListAfter(validator[0].body, "(e.elem ->> 'expected_document_type') NOT IN");
    const fromCheck = inListAfter(schema, 'CONSTRAINT checklist_template_items_expected_document_type_check');
    expect(fromValidator).toEqual(DOCUMENT_TYPES);
    expect(fromCheck).toEqual(DOCUMENT_TYPES);
  });
});
