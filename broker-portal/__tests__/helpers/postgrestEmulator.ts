/**
 * A PostgREST-shaped Supabase stub for the BACKLOG-3364 portal suites.
 *
 * ---------------------------------------------------------------------------
 * Why this exists rather than another hand-rolled chain.
 * ---------------------------------------------------------------------------
 * The portal's existing chains (`__tests__/app/auth/setup/callback/route.test.ts`
 * before this change; `__tests__/fixtures/orgFeatures.ts`) IGNORE every argument
 * and resolve a fixed value. Against that, a query that named
 * `organizations.personal_owner_user_id` in its select, order or filter would
 * pass — and on a production database that has not had BACKLOG-3364's migration
 * applied, the same query returns HTTP 400 / code 42703 with `data: null` and
 * NO throw, which every reader here would read as "this user has no
 * membership". Every real brokerage member would be silently demoted. A control
 * that cannot tell those two apart is not a control (3e27deee ruling 3, N2).
 *
 * So this stub answers 42703 whenever ANY part of the query names the column
 * and the fixture is in its pre-migration state, and it applies `eq` / `in` /
 * `is` as real filters so a guard that narrows by role in SQL (`jit-access.ts`
 * does exactly that) is measured rather than assumed.
 *
 * ---------------------------------------------------------------------------
 * The fixtures are TRANSCRIBED, never invented.
 * ---------------------------------------------------------------------------
 * `supabase/tests/backlog-3364/fixtures/postgrest-{pre,post}-migration.json`
 * were captured by PR 1 from a real PostgREST with the real
 * `@supabase/supabase-js`, on a Postgres 17.6 stack gated against production's
 * catalog (pm_comments db56b706). They are read here at module load rather than
 * retyped, so a fixture and the response it stands for cannot drift apart.
 *
 * Key shapes taken from them:
 *   - case A error      -> ABSENT_COLUMN_ERROR
 *   - case B embed      -> BROKERAGE_ORG_PRE (24 keys, no personal column)
 *                          BROKERAGE_ORG_POST (25 keys, column null)
 *   - R7-solo-after-ensure embed -> PERSONAL_ORG (column set)
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(__dirname, '../../../supabase/tests/backlog-3364/fixtures');

interface FixtureCase {
  label: string;
  status: number;
  threw: boolean;
  error: { code: string; details: string | null; hint: string | null; message: string } | null;
  data: unknown;
}

function loadFixture(phase: 'pre' | 'post'): FixtureCase[] {
  const raw = readFileSync(join(FIXTURE_DIR, `postgrest-${phase}-migration.json`), 'utf8');
  return (JSON.parse(raw) as { cases: FixtureCase[] }).cases;
}

export const PRE_MIGRATION_CASES = loadFixture('pre');
export const POST_MIGRATION_CASES = loadFixture('post');

function caseByLabel(cases: FixtureCase[], label: string): FixtureCase {
  const found = cases.find((c) => c.label === label);
  if (!found) throw new Error(`postgrestEmulator: fixture case "${label}" not found`);
  return found;
}

function embeddedOrg(cases: FixtureCase[], label: string): Record<string, unknown> {
  const rows = caseByLabel(cases, label).data as
    | { organizations: Record<string, unknown> }[]
    | null;
  if (!rows || rows.length === 0) {
    throw new Error(`postgrestEmulator: fixture case "${label}" has no rows`);
  }
  return rows[0].organizations;
}

/** The exact error a pre-migration database returns. Case A, verbatim. */
export const ABSENT_COLUMN_ERROR = caseByLabel(PRE_MIGRATION_CASES, 'A').error!;

/** The column this whole emulator is about. */
export const PERSONAL_COLUMN = 'personal_owner_user_id';

/** Embedded brokerage organization BEFORE the migration — no personal key. */
export const BROKERAGE_ORG_PRE = embeddedOrg(PRE_MIGRATION_CASES, 'B');

/** Embedded brokerage organization AFTER the migration — personal key null. */
export const BROKERAGE_ORG_POST = embeddedOrg(POST_MIGRATION_CASES, 'B');

/** Embedded PERSONAL organization, as `ensure_personal_organization()` made it. */
export const PERSONAL_ORG = embeddedOrg(POST_MIGRATION_CASES, 'R7-solo-after-ensure');

// ---------------------------------------------------------------------------
// The emulator
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export interface EmulatorState {
  /**
   * Has BACKLOG-3364's migration been applied to the fixture database?
   *
   * `false` is the state a deployed portal meets before the founder applies
   * migration 1, and the state in which naming the column is fatal.
   */
  columnPresent: boolean;
  /** Rows per table. A table with no entry is empty, as an empty table is. */
  rows: Record<string, Row[]>;
  /** Every write attempted, in order, for assertions. */
  writes: { table: string; op: 'insert' | 'update' | 'upsert' | 'delete'; values: unknown }[];
  /** Every select string issued, per table, for assertions. */
  selects: { table: string; columns: string }[];
  /**
   * Every `.order()` call issued, per table, in the order they were chained.
   *
   * `options` is recorded verbatim, not just the column name, because the wrong
   * implementation a column-name-only assertion cannot see is
   * `.order('created_at', { referencedTable: 'organizations' })`: it names no
   * new column, `organizations.created_at` exists on both sides of the
   * migration, and it sorts on the EMBED rather than on `organization_members`
   * — which 3e27deee ruling 3 forbids, and which `pickBrokerageMembership`
   * would then consume in an order the caller never asked for.
   */
  orders: { table: string; column: string; options: unknown }[];
}

const PGRST116 = {
  code: 'PGRST116',
  details: 'The result contains 0 rows',
  hint: null,
  message: 'JSON object requested, multiple (or no) rows returned',
};

/** Does any argument of a chain call name the personal column? */
function namesPersonalColumn(args: unknown[]): boolean {
  return args.some((arg) => {
    if (typeof arg === 'string') return arg.includes(PERSONAL_COLUMN);
    if (arg && typeof arg === 'object') {
      return Object.values(arg as Record<string, unknown>).some(
        (v) => typeof v === 'string' && v.includes(PERSONAL_COLUMN)
      );
    }
    return false;
  });
}

type Filter = (rows: Row[]) => Row[];

interface ChainResult {
  data: unknown;
  error: unknown;
  status: number;
}

/**
 * One query builder. Thenable, so `await supabase.from(t).select(c).eq(...)`
 * resolves without `.single()` — which is exactly the shape BACKLOG-3364 moves
 * the three portal readers to.
 */
function buildChain(table: string, state: EmulatorState) {
  const filters: Filter[] = [];
  let limit: number | null = null;
  let columnNamed = false;
  let shape: 'many' | 'single' | 'maybeSingle' = 'many';
  let write: 'insert' | 'update' | 'upsert' | 'delete' | null = null;

  function note(...args: unknown[]): void {
    if (namesPersonalColumn(args)) columnNamed = true;
  }

  function resolve(): ChainResult {
    // A pre-migration database cannot answer a query that names the column.
    if (columnNamed && !state.columnPresent) {
      return { data: null, error: { ...ABSENT_COLUMN_ERROR }, status: 400 };
    }
    if (write) return { data: null, error: null, status: 200 };

    let rows = [...(state.rows[table] ?? [])];
    for (const f of filters) rows = f(rows);
    if (limit !== null) rows = rows.slice(0, limit);

    if (shape === 'many') return { data: rows, error: null, status: 200 };
    if (rows.length === 1) return { data: rows[0], error: null, status: 200 };
    if (shape === 'maybeSingle' && rows.length === 0) {
      return { data: null, error: null, status: 200 };
    }
    return { data: null, error: { ...PGRST116 }, status: 406 };
  }

  const chain = {
    select(columns?: string, ..._rest: unknown[]) {
      note(columns);
      if (typeof columns === 'string') state.selects.push({ table, columns });
      return chain;
    },
    eq(column: string, value: unknown) {
      note(column);
      filters.push((rows) => rows.filter((r) => r[column] === value));
      return chain;
    },
    in(column: string, values: unknown[]) {
      note(column);
      filters.push((rows) => rows.filter((r) => values.includes(r[column])));
      return chain;
    },
    is(column: string, value: unknown) {
      note(column);
      filters.push((rows) =>
        rows.filter((r) => (value === null ? r[column] == null : r[column] === value))
      );
      return chain;
    },
    not(column: string, ...rest: unknown[]) {
      note(column, ...rest);
      return chain;
    },
    filter(column: string, ...rest: unknown[]) {
      note(column, ...rest);
      return chain;
    },
    or(expression: string, options?: unknown) {
      note(expression, options);
      return chain;
    },
    order(column: string, options?: unknown) {
      note(column, options);
      // Ordering is not APPLIED: fixtures are written in the order the query
      // would return them, which is what pickBrokerageMembership consumes.
      //
      // The call is RECORDED, because the deterministic order is a requirement
      // (3e27deee rulings 3 and 7 — `created_at` then `id`, both base columns
      // of organization_members) and until this line existed it had no guard:
      // deleting both `.order()` calls from all three readers reddened 0 of
      // 1171 tests (SR review bd8347f1 §2d, change R3).
      state.orders.push({ table, column, options });
      return chain;
    },
    limit(n: number) {
      limit = n;
      return chain;
    },
    insert(values: unknown) {
      write = 'insert';
      state.writes.push({ table, op: 'insert', values });
      return chain;
    },
    update(values: unknown) {
      write = 'update';
      state.writes.push({ table, op: 'update', values });
      return chain;
    },
    upsert(values: unknown, _options?: unknown) {
      write = 'upsert';
      state.writes.push({ table, op: 'upsert', values });
      return chain;
    },
    delete() {
      write = 'delete';
      state.writes.push({ table, op: 'delete', values: null });
      return chain;
    },
    single() {
      shape = 'single';
      return chain;
    },
    maybeSingle() {
      shape = 'maybeSingle';
      return chain;
    },
    then(onFulfilled: (r: ChainResult) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(resolve()).then(onFulfilled, onRejected);
    },
  };

  return chain;
}

export interface Emulator {
  state: EmulatorState;
  from: (table: string) => ReturnType<typeof buildChain>;
  /** Replace part of the fixture between cases. */
  set: (next: Partial<Pick<EmulatorState, 'columnPresent' | 'rows'>>) => void;
  reset: () => void;
}

export function createPostgrestEmulator(
  initial: Partial<Pick<EmulatorState, 'columnPresent' | 'rows'>> = {}
): Emulator {
  const state: EmulatorState = {
    columnPresent: initial.columnPresent ?? true,
    rows: initial.rows ?? {},
    writes: [],
    selects: [],
    orders: [],
  };
  return {
    state,
    from: (table: string) => buildChain(table, state),
    set(next) {
      if (next.columnPresent !== undefined) state.columnPresent = next.columnPresent;
      if (next.rows !== undefined) state.rows = next.rows;
    },
    reset() {
      state.columnPresent = true;
      state.rows = {};
      state.writes = [];
      state.selects = [];
      state.orders = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Row builders — every identifier invented, none from any live row
// ---------------------------------------------------------------------------

export const FIXTURE_USER_ID = '00000000-0000-4000-8000-000000336402'; // pii-allow-uuid: invented fixture id
export const FIXTURE_BROKERAGE_ORG_ID = '00000000-0000-4000-8000-0000003364b0'; // pii-allow-uuid: invented fixture id
export const FIXTURE_PERSONAL_ORG_ID = '00000000-0000-4000-8000-0000003364e0'; // pii-allow-uuid: invented fixture id
export const FIXTURE_INVITE_ID = '00000000-0000-4000-8000-0000003364a1'; // pii-allow-uuid: invented fixture id

/** A membership in someone else's brokerage. `phase` picks the embed shape. */
export function brokerageMembership(
  role: string,
  phase: 'pre' | 'post' = 'post',
  userId: string = FIXTURE_USER_ID
): Row {
  return {
    id: `${FIXTURE_BROKERAGE_ORG_ID}-${role}`,
    user_id: userId,
    role,
    organization_id: FIXTURE_BROKERAGE_ORG_ID,
    license_status: 'active',
    organizations: {
      ...(phase === 'pre' ? BROKERAGE_ORG_PRE : BROKERAGE_ORG_POST),
      id: FIXTURE_BROKERAGE_ORG_ID,
    },
  };
}

/**
 * The row BACKLOG-3364 creates: the user's own organization, role `agent`.
 * Only ever exists in a database that HAS the column, by construction.
 */
export function personalMembership(userId: string = FIXTURE_USER_ID): Row {
  return {
    id: `${FIXTURE_PERSONAL_ORG_ID}-agent`,
    user_id: userId,
    role: 'agent',
    organization_id: FIXTURE_PERSONAL_ORG_ID,
    license_status: 'active',
    organizations: {
      ...PERSONAL_ORG,
      id: FIXTURE_PERSONAL_ORG_ID,
      personal_owner_user_id: userId,
    },
  };
}

/** An unclaimed brokerage invite waiting on an email address. */
export function pendingInvite(email: string, role = 'agent'): Row {
  return {
    id: FIXTURE_INVITE_ID,
    user_id: null,
    invited_email: email,
    role,
    organization_id: FIXTURE_BROKERAGE_ORG_ID,
    license_status: 'pending',
  };
}
