/**
 * A PostgREST-shaped Supabase stub for the BACKLOG-3364 desktop suites.
 *
 * ---------------------------------------------------------------------------
 * Why this exists rather than another hand-rolled chain.
 * ---------------------------------------------------------------------------
 * The existing desktop mocks (`supabaseService.test.ts` — `from: jest.fn()`)
 * IGNORE every argument and resolve a fixed value. Against that, a query naming
 * `organizations.personal_owner_user_id` in its select, order or filter would
 * pass — while a production database that has not had BACKLOG-3364's migration
 * applied answers HTTP 400 / code 42703 with `data: null` and NO throw. Every
 * reader here would read that as "this user has no membership", and every real
 * brokerage member would silently lose their team licence and their ability to
 * submit. A control that cannot tell those two apart is not a control
 * (SR delta pm_comments 3e27deee ruling 3, N2).
 *
 * So this stub answers 42703 whenever ANY part of a query names the column and
 * the fixture is in its pre-migration state; applies `eq` as a real filter; and
 * RECORDS every select string, every `.order()` call with its options, and
 * every `rpc()` call, so the requirements that have no other guard are measured
 * rather than assumed.
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
 * This file deliberately imports nothing from `broker-portal/`. PR 2 has an
 * equivalent helper under `broker-portal/__tests__/helpers/`; the two read the
 * SAME committed fixture files, which is what keeps them honest. Sharing one
 * module across the two jest projects would mean editing portal code from a
 * desktop PR, and the portal build is Edge-constrained.
 */

import { readFileSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(__dirname, "../../../../supabase/tests/backlog-3364/fixtures");

interface FixtureCase {
  label: string;
  status: number;
  threw: boolean;
  error: { code: string; details: string | null; hint: string | null; message: string } | null;
  data: unknown;
}

function loadFixture(phase: "pre" | "post"): FixtureCase[] {
  const raw = readFileSync(join(FIXTURE_DIR, `postgrest-${phase}-migration.json`), "utf8");
  return (JSON.parse(raw) as { cases: FixtureCase[] }).cases;
}

export const PRE_MIGRATION_CASES = loadFixture("pre");
export const POST_MIGRATION_CASES = loadFixture("post");

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
export const ABSENT_COLUMN_ERROR = caseByLabel(PRE_MIGRATION_CASES, "A").error!;

/** The exact error a pre-migration database returns for the ensure call. */
export const ABSENT_FUNCTION_ERROR = caseByLabel(PRE_MIGRATION_CASES, "RPC-ensure").error!;

/**
 * BACKLOG-3519 — the exact PostgREST error `split_agreement_in_force` answers
 * with today (BACKLOG-3503 applied nowhere). TRANSCRIBED, not invented:
 * captured via `curl -X POST .../rest/v1/rpc/split_agreement_in_force` against
 * the real project on 2026-09-25, read-only, no side effects (the table and
 * function genuinely do not exist there). Not loaded from a JSON fixture file
 * like the BACKLOG-3364 cases above -- one literal object, transcribed
 * verbatim, is proportionate here; a whole fixture-file mechanism is not.
 */
export const ABSENT_SPLIT_FUNCTION_ERROR = {
  code: "PGRST202",
  details:
    "Searched for the function public.split_agreement_in_force with parameters " +
    "p_agent_user_id, p_on_date, p_organization_id or with a single unnamed " +
    "json/jsonb parameter, but no matches were found in the schema cache.",
  hint: "Perhaps you meant to call the function public.support_agent_analytics",
  message:
    "Could not find the function public.split_agreement_in_force" +
    "(p_agent_user_id, p_on_date, p_organization_id) in the schema cache",
};

/** The column this whole emulator is about. */
export const PERSONAL_COLUMN = "personal_owner_user_id";

/** Embedded brokerage organization BEFORE the migration — no personal key. */
export const BROKERAGE_ORG_PRE = embeddedOrg(PRE_MIGRATION_CASES, "B");

/** Embedded brokerage organization AFTER the migration — personal key null. */
export const BROKERAGE_ORG_POST = embeddedOrg(POST_MIGRATION_CASES, "B");

/** Embedded PERSONAL organization, as `ensure_personal_organization()` made it. */
export const PERSONAL_ORG = embeddedOrg(POST_MIGRATION_CASES, "R7-solo-after-ensure");

/** What the ensure function returns the first time, verbatim. */
export const ENSURE_CREATED = caseByLabel(POST_MIGRATION_CASES, "RPC-ensure").data;

/** What it returns on every call after that, verbatim. */
export const ENSURE_EXISTS = caseByLabel(POST_MIGRATION_CASES, "RPC-ensure-again").data;

// ---------------------------------------------------------------------------
// The emulator
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export interface RpcCall {
  fn: string;
  args: unknown;
}

export interface EmulatorState {
  /**
   * Has BACKLOG-3364's migration been applied to the fixture database?
   *
   * `false` is the state a shipped desktop build meets before the founder
   * applies migration 1, and the state in which naming the column is fatal.
   */
  columnPresent: boolean;
  /**
   * BACKLOG-3519 — has BACKLOG-3503's migration (agent_split_agreements +
   * split_agreement_in_force()) been applied? `false` is the state every
   * environment is actually in as of 2026-09-25 -- see
   * ABSENT_SPLIT_FUNCTION_ERROR's comment. Defaults to `true` so existing
   * BACKLOG-3364 tests, which never mention this, are unaffected.
   */
  splitFunctionPresent: boolean;
  /** Rows per table. A table with no entry is empty, as an empty table is. */
  rows: Record<string, Row[]>;
  /** Every select string issued, per table, for assertions. */
  selects: { table: string; columns: string }[];
  /**
   * Every `.order()` call issued, per table, in the order they were chained.
   *
   * `options` is recorded verbatim, not just the column name, because the wrong
   * implementation a column-name-only assertion cannot see is
   * `.order("created_at", { referencedTable: "organizations" })`: it names no
   * new column, `organizations.created_at` exists on both sides of the
   * migration, and it sorts on the EMBED rather than on `organization_members`
   * — which 3e27deee rulings 3 and 7 forbid.
   *
   * Recorded because deleting both `.order()` calls from the portal's three
   * readers reddened 0 of 1171 tests until PR 2 added this (SR bd8347f1 R3).
   */
  orders: { table: string; column: string; options: unknown }[];
  /** Every `rpc()` call, in order. */
  rpcs: RpcCall[];
  /** Every write attempted, in order. */
  writes: { table: string; op: "insert" | "update" | "upsert" | "delete"; values: unknown }[];
}

const PGRST116 = {
  code: "PGRST116",
  details: "The result contains 0 rows",
  hint: null,
  message: "JSON object requested, multiple (or no) rows returned",
};

/** Does any argument of a chain call name the personal column? */
function namesPersonalColumn(args: unknown[]): boolean {
  return args.some((arg) => {
    if (typeof arg === "string") return arg.includes(PERSONAL_COLUMN);
    if (arg && typeof arg === "object") {
      return Object.values(arg as Record<string, unknown>).some(
        (v) => typeof v === "string" && v.includes(PERSONAL_COLUMN)
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
 * One query builder. Thenable, so `await client.from(t).select(c).eq(...)`
 * resolves without `.single()` — the shape BACKLOG-3364 moves both desktop
 * readers to.
 */
function buildChain(table: string, state: EmulatorState) {
  const filters: Filter[] = [];
  let limit: number | null = null;
  let columnNamed = false;
  let shape: "many" | "single" | "maybeSingle" = "many";
  let write: "insert" | "update" | "upsert" | "delete" | null = null;

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

    if (shape === "many") return { data: rows, error: null, status: 200 };
    if (rows.length === 1) return { data: rows[0], error: null, status: 200 };
    if (shape === "maybeSingle" && rows.length === 0) {
      return { data: null, error: null, status: 200 };
    }
    return { data: null, error: { ...PGRST116 }, status: 406 };
  }

  const chain = {
    select(columns?: string, ..._rest: unknown[]) {
      note(columns);
      if (typeof columns === "string") state.selects.push({ table, columns });
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
      // would return them, which is what the readers consume. The CALL is
      // recorded — see EmulatorState.orders.
      state.orders.push({ table, column, options });
      return chain;
    },
    limit(n: number) {
      limit = n;
      return chain;
    },
    insert(values: unknown) {
      write = "insert";
      state.writes.push({ table, op: "insert", values });
      return chain;
    },
    update(values: unknown) {
      write = "update";
      state.writes.push({ table, op: "update", values });
      return chain;
    },
    upsert(values: unknown, _options?: unknown) {
      write = "upsert";
      state.writes.push({ table, op: "upsert", values });
      return chain;
    },
    delete() {
      write = "delete";
      state.writes.push({ table, op: "delete", values: null });
      return chain;
    },
    single() {
      shape = "single";
      return chain;
    },
    maybeSingle() {
      shape = "maybeSingle";
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
  rpc: (fn: string, args?: unknown) => Promise<ChainResult>;
  /** Replace part of the fixture between cases. */
  set: (
    next: Partial<Pick<EmulatorState, "columnPresent" | "splitFunctionPresent" | "rows">>
  ) => void;
  reset: () => void;
}

export function createPostgrestEmulator(
  initial: Partial<Pick<EmulatorState, "columnPresent" | "splitFunctionPresent" | "rows">> = {}
): Emulator {
  const state: EmulatorState = {
    columnPresent: initial.columnPresent ?? true,
    splitFunctionPresent: initial.splitFunctionPresent ?? true,
    rows: initial.rows ?? {},
    selects: [],
    orders: [],
    rpcs: [],
    writes: [],
  };

  return {
    state,
    from: (table: string) => buildChain(table, state),
    /**
     * `ensure_personal_organization` answers from PR 1's captured responses: a
     * pre-migration database returns 404 / PGRST202 ("no such function"), and a
     * post-migration one returns `created` the first time and `exists` after.
     *
     * `split_agreement_in_force` (BACKLOG-3519) answers PGRST202 when
     * `!state.splitFunctionPresent`, matching `ABSENT_SPLIT_FUNCTION_ERROR`'s
     * measured shape, or filters `state.rows.agent_split_agreements` by
     * organization/agent/effective_from and returns the row this repo's real
     * function would (`effective_from DESC, seq DESC`, `LIMIT 1`, as an array
     * -- `RETURNS SETOF` -- never an error for "no row matched"; that is a
     * legitimate empty result, not a failure).
     *
     * Any other function name is an unmocked call and says so loudly, rather
     * than resolving something plausible.
     */
    async rpc(fn: string, args?: unknown) {
      state.rpcs.push({ fn, args });

      if (fn === "ensure_personal_organization") {
        if (!state.columnPresent) {
          return { data: null, error: { ...ABSENT_FUNCTION_ERROR }, status: 404 };
        }
        const first =
          state.rpcs.filter((c) => c.fn === "ensure_personal_organization").length === 1;
        return { data: first ? ENSURE_CREATED : ENSURE_EXISTS, error: null, status: 200 };
      }

      if (fn === "split_agreement_in_force") {
        if (!state.splitFunctionPresent) {
          return { data: null, error: { ...ABSENT_SPLIT_FUNCTION_ERROR }, status: 404 };
        }
        const { p_organization_id, p_agent_user_id, p_on_date } = (args ?? {}) as {
          p_organization_id?: string;
          p_agent_user_id?: string;
          p_on_date?: string;
        };
        const rows = (state.rows.agent_split_agreements ?? [])
          .filter(
            (r) =>
              r.organization_id === p_organization_id &&
              r.agent_user_id === p_agent_user_id &&
              typeof r.effective_from === "string" &&
              p_on_date !== undefined &&
              r.effective_from <= p_on_date
          )
          .sort((a, b) => {
            const byDate = String(b.effective_from).localeCompare(String(a.effective_from));
            if (byDate !== 0) return byDate;
            return Number(b.seq ?? 0) - Number(a.seq ?? 0);
          })
          .slice(0, 1);
        return { data: rows, error: null, status: 200 };
      }

      throw new Error(`postgrestEmulator: unmocked rpc("${fn}")`);
    },
    set(next) {
      if (next.columnPresent !== undefined) state.columnPresent = next.columnPresent;
      if (next.splitFunctionPresent !== undefined) {
        state.splitFunctionPresent = next.splitFunctionPresent;
      }
      if (next.rows !== undefined) state.rows = next.rows;
    },
    reset() {
      state.columnPresent = true;
      state.splitFunctionPresent = true;
      state.rows = {};
      state.selects = [];
      state.orders = [];
      state.rpcs = [];
      state.writes = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Row builders — every identifier invented, none from any live row
// ---------------------------------------------------------------------------

export const FIXTURE_USER_ID = "00000000-0000-4000-8000-000000336403"; // pii-allow-uuid: invented fixture id
export const FIXTURE_BROKERAGE_ORG_ID = "00000000-0000-4000-8000-0000003364c0"; // pii-allow-uuid: invented fixture id
export const FIXTURE_BROKERAGE_ORG_ID_2 = "00000000-0000-4000-8000-0000003364c1"; // pii-allow-uuid: invented fixture id
export const FIXTURE_PERSONAL_ORG_ID = "00000000-0000-4000-8000-0000003364f0"; // pii-allow-uuid: invented fixture id

/**
 * How the embed arrives.
 *
 * `"object"` is what PostgREST actually sends for this many-to-one embed and
 * what the captured fixtures contain. `"array"` is what supabase-js's types say
 * it is, because the client is built without a generated `Database` type — and
 * a reader that handles only the object shape would read `undefined` from an
 * array and call every organization non-personal. Both are exercised.
 */
export type EmbedShape = "object" | "array";

function shaped(org: Record<string, unknown>, shape: EmbedShape): unknown {
  return shape === "array" ? [org] : org;
}

/** A membership in someone else's brokerage. `phase` picks the embed shape. */
export function brokerageMembership(
  options: {
    phase?: "pre" | "post";
    shape?: EmbedShape;
    userId?: string;
    orgId?: string;
    createdAt?: string;
    licenseStatus?: string;
  } = {}
): Row {
  const {
    phase = "post",
    shape = "object",
    userId = FIXTURE_USER_ID,
    orgId = FIXTURE_BROKERAGE_ORG_ID,
    createdAt = "2026-01-02T00:00:00.000Z",
    licenseStatus = "active",
  } = options;
  return {
    id: `${orgId}-member`,
    user_id: userId,
    organization_id: orgId,
    license_status: licenseStatus,
    created_at: createdAt,
    organizations: shaped(
      {
        ...(phase === "pre" ? BROKERAGE_ORG_PRE : BROKERAGE_ORG_POST),
        id: orgId,
        name: "Fixture Brokerage 3364",
      },
      shape
    ),
  };
}

/**
 * The row BACKLOG-3364 creates: the user's own organization, role `agent`.
 * Only ever exists in a database that HAS the column, by construction.
 */
export function personalMembership(
  options: {
    shape?: EmbedShape;
    userId?: string;
    createdAt?: string;
    licenseStatus?: string;
  } = {}
): Row {
  const {
    shape = "object",
    userId = FIXTURE_USER_ID,
    createdAt = "2026-01-01T00:00:00.000Z",
    licenseStatus = "active",
  } = options;
  return {
    id: `${FIXTURE_PERSONAL_ORG_ID}-agent`,
    user_id: userId,
    organization_id: FIXTURE_PERSONAL_ORG_ID,
    license_status: licenseStatus,
    created_at: createdAt,
    organizations: shaped(
      {
        ...PERSONAL_ORG,
        id: FIXTURE_PERSONAL_ORG_ID,
        personal_owner_user_id: userId,
      },
      shape
    ),
  };
}
