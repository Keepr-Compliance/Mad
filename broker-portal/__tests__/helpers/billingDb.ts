/**
 * BACKLOG-3845 — an in-memory, argument-recording stand-in for the service
 * Supabase client on the billing tables.
 *
 * The suites it replaced mocked every chain as `eq: () => …`: the filter
 * arguments were thrown away, so a query that dropped `.eq('stripe_mode', …)`
 * passed exactly like one that kept it. Here every filter is APPLIED to the
 * rows and RECORDED, so a missing mode filter shows up the way it would in
 * production: a read sees the other mode's row (and `maybeSingle()` errors on
 * two rows), a write changes the other mode's row.
 *
 * Shapes (transcribed, not invented):
 *   - stripe_customers columns: production information_schema.columns
 *     (user_id, stripe_customer_id, default_payment_method_id, created_at,
 *     updated_at) + stripe_mode from 20261011230913; PK (user_id, stripe_mode).
 *   - payment_intents columns: production information_schema.columns + stripe_mode.
 *   - maybeSingle() over more than one row: supabase-js / PostgREST answer
 *     { data: null, error: { code: 'PGRST116', ... } } (postgrest-js
 *     PostgrestBuilder, "Results contain N rows").
 *   - unique violation: Postgres SQLSTATE 23505 as PostgREST relays it; the
 *     message names the constraint, as Postgres writes it ("duplicate key value
 *     violates unique constraint \"<name>\"").
 *   - billing_subscriptions (BACKLOG-3846): columns, UNIQUE
 *     billing_subscriptions_stripe_subscription_id_key and the partial unique
 *     index billing_subscriptions_one_open_per_user_mode (user_id, stripe_mode)
 *     WHERE status IN (active, trialing, past_due, incomplete), from
 *     20261011230913_backlog_3845_billing_foundation.sql.
 *   - `.or('col.is.null,col.lt.N')`: PostgREST logic tree; `is.null` matches SQL
 *     NULL only (a NULL never satisfies `eq`/`lt`), so a column the code leaves
 *     NULL behaves here as it does in Postgres.
 * Ids are synthetic.
 */

export type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'in' | 'lt' | 'not' | 'or' | 'is'; column: string; value: unknown };

export interface DbCall {
  table: string;
  op: 'select' | 'insert' | 'update' | null;
  filters: Filter[];
  payload?: Row | Row[];
  columns?: string;
}

export interface DbError {
  code: string;
  message: string;
}

const PRIMARY_KEYS: Record<string, string[]> = {
  stripe_customers: ['user_id', 'stripe_mode'],
  payment_intents: ['id'],
};

interface UniqueIndex {
  name: string;
  columns: string[];
  where?: (row: Row) => boolean;
}
const OPEN_SUB_STATUSES = ['active', 'trialing', 'past_due', 'incomplete'];
const UNIQUE_INDEXES: Record<string, UniqueIndex[]> = {
  // BACKLOG-3848: billing_outbox.dedupe_key UNIQUE (20261011230913, constraint billing_outbox_dedupe_key_key).
  billing_outbox: [{ name: 'billing_outbox_dedupe_key_key', columns: ['dedupe_key'] }],
  billing_subscriptions: [
    { name: 'billing_subscriptions_stripe_subscription_id_key', columns: ['stripe_subscription_id'] },
    {
      name: 'billing_subscriptions_one_open_per_user_mode',
      columns: ['user_id', 'stripe_mode'],
      where: (r) => OPEN_SUB_STATUSES.includes(r.status as string),
    },
  ],
};

function uniqueViolation(table: string, rows: Row[], candidate: Row, self?: Row): DbError | null {
  for (const ix of UNIQUE_INDEXES[table] ?? []) {
    if (ix.where && !ix.where(candidate)) continue;
    const clash = rows.some(
      (e) => e !== self && (!ix.where || ix.where(e)) && ix.columns.every((c) => e[c] === candidate[c])
    );
    if (clash) {
      return { code: '23505', message: `duplicate key value violates unique constraint "${ix.name}"` };
    }
  }
  return null;
}

export class BillingDb {
  tables: Record<string, Row[]> = {};
  calls: DbCall[] = [];
  /** Force an error for the next op on a table: key `${table}.${op}`. */
  failNext: Record<string, DbError> = {};

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }));
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  callsTo(table: string, op?: DbCall['op']): DbCall[] {
    return this.calls.filter((c) => c.table === table && (op === undefined || c.op === op));
  }

  /** The `.from` function to hand to the mocked service client. */
  from = (table: string) => new Query(this, table);
}

/** One PostgREST condition `col.op.value` (the operators the billing code uses). */
function matchesCondition(row: Row, cond: string): boolean {
  const [column, op, ...rest] = cond.split('.');
  const raw = rest.join('.');
  const v = row[column];
  if (op === 'is' && raw === 'null') return v === null || v === undefined;
  if (v === null || v === undefined) return false;
  if (op === 'lt') return (v as number) < Number(raw);
  if (op === 'eq') return String(v) === raw;
  throw new Error(`BillingDb: unsupported or-condition ${cond}`);
}

/** A column, or a PostgREST JSON text path `col->>key` (BACKLOG-3848: email_delivery_log.metadata). */
function columnValue(row: Row, column: string): unknown {
  const m = /^(\w+)->>(\w+)$/.exec(column);
  if (!m) return row[column];
  const obj = row[m[1]] as Record<string, unknown> | null | undefined;
  const v = obj?.[m[2]];
  return v === undefined || v === null ? null : String(v);
}

function matches(row: Row, f: Filter): boolean {
  const v = columnValue(row, f.column);
  switch (f.op) {
    case 'or':
      return (f.value as string).split(',').some((c) => matchesCondition(row, c));
    case 'eq':
      return v === f.value;
    case 'is':
      // BACKLOG-3849: `.is(col, null)` matches SQL NULL only.
      return f.value === null ? v === null || v === undefined : v === f.value;
    case 'in':
      return (f.value as unknown[]).includes(v);
    case 'lt':
      return typeof v === 'string' && typeof f.value === 'string' ? v < f.value : (v as number) < (f.value as number);
    case 'not': {
      const [op, val] = f.value as [string, unknown];
      if (op === 'eq') return v !== val;
      // BACKLOG-3934: `.not(col, 'is', null)` = IS NOT NULL.
      if (op === 'is' && val === null) return v !== null && v !== undefined;
      return true;
    }
  }
}

class Query implements PromiseLike<{ data: unknown; error: DbError | null }> {
  private call: DbCall;
  private terminal: 'many' | 'maybeSingle' = 'many';
  private limitN: number | null = null;
  private orderBy: { column: string; ascending: boolean }[] = [];
  private wantReturn = false;

  constructor(private db: BillingDb, table: string) {
    this.call = { table, op: null, filters: [] };
    db.calls.push(this.call);
  }

  select(columns = '*') {
    if (this.call.op === null) this.call.op = 'select';
    else this.wantReturn = true;
    this.call.columns = columns;
    return this;
  }
  insert(payload: Row | Row[]) {
    this.call.op = 'insert';
    this.call.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.call.op = 'update';
    this.call.payload = payload;
    return this;
  }
  eq(column: string, value: unknown) {
    this.call.filters.push({ op: 'eq', column, value });
    return this;
  }
  is(column: string, value: null | boolean) {
    this.call.filters.push({ op: 'is', column, value });
    return this;
  }
  in(column: string, value: unknown[]) {
    this.call.filters.push({ op: 'in', column, value });
    return this;
  }
  lt(column: string, value: unknown) {
    this.call.filters.push({ op: 'lt', column, value });
    return this;
  }
  or(expression: string) {
    this.call.filters.push({ op: 'or', column: '', value: expression });
    return this;
  }
  not(column: string, op: string, value: unknown) {
    this.call.filters.push({ op: 'not', column, value: [op, value] });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  /** BACKLOG-3878: PostgREST ordering, applied before limit (string / ISO-date compare). */
  order(column: string, opts: { ascending?: boolean } = {}) {
    this.orderBy.push({ column, ascending: opts.ascending !== false });
    return this;
  }
  maybeSingle() {
    this.terminal = 'maybeSingle';
    return Promise.resolve(this.execute());
  }

  then<A = { data: unknown; error: DbError | null }, B = never>(
    onFulfilled?: ((v: { data: unknown; error: DbError | null }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private execute(): { data: unknown; error: DbError | null } {
    const { table, op, filters } = this.call;
    const forced = this.db.failNext[`${table}.${op}`];
    if (forced) {
      delete this.db.failNext[`${table}.${op}`];
      return { data: null, error: forced };
    }
    const rows = this.db.rows(table);
    const hit = rows.filter((r) => filters.every((f) => matches(r, f)));

    if (op === 'insert') {
      const incoming = Array.isArray(this.call.payload) ? this.call.payload : [this.call.payload as Row];
      const pk = PRIMARY_KEYS[table];
      for (const r of incoming) {
        if (pk && rows.some((e) => pk.every((k) => e[k] === r[k]))) {
          return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${table}_pkey"` } };
        }
      }
      for (const r of incoming) {
        const dup = uniqueViolation(table, rows, r);
        if (dup) return { data: null, error: dup };
      }
      for (const r of incoming) rows.push({ ...r });
      return { data: this.wantReturn ? incoming : null, error: null };
    }
    if (op === 'update') {
      for (const r of hit) {
        const dup = uniqueViolation(table, rows, { ...r, ...(this.call.payload as Row) }, r);
        if (dup) return { data: null, error: dup };
      }
      for (const r of hit) Object.assign(r, this.call.payload);
      return { data: this.wantReturn ? hit : null, error: null };
    }
    const sorted = this.orderBy.length === 0 ? hit : [...hit].sort((a, b) => {
      for (const o of this.orderBy) {
        const x = String(a[o.column] ?? '');
        const y = String(b[o.column] ?? '');
        if (x !== y) return (x < y ? -1 : 1) * (o.ascending ? 1 : -1);
      }
      return 0;
    });
    const out = this.limitN === null ? sorted : sorted.slice(0, this.limitN);
    if (this.terminal === 'maybeSingle') {
      if (out.length > 1) {
        return {
          data: null,
          error: { code: 'PGRST116', message: `JSON object requested, multiple (or no) rows returned. Results contain ${out.length} rows` },
        };
      }
      return { data: out[0] ?? null, error: null };
    }
    return { data: out, error: null };
  }
}

/** Value of the first `eq` filter on `column` in a recorded call. */
export function eqValue(call: DbCall, column: string): unknown {
  return call.filters.find((f) => f.op === 'eq' && f.column === column)?.value;
}
