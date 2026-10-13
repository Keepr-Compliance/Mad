/**
 * BACKLOG-3849 — an in-memory stand-in for the service Supabase client on
 * `billing_outbox`, for the drain's jest controls.
 *
 * Transcribed, not invented:
 *  - Columns: `billing_outbox` in
 *    supabase/migrations/20261011230913_backlog_3845_billing_foundation.sql
 *    (id, stripe_mode, kind, user_id, organization_id, dedupe_key, run_after,
 *    payload, attempts, last_error, claimed_until, created_at, processed_at).
 *  - `billing_outbox_claim(p_mode, p_limit)`: the same file — rows of p_mode,
 *    processed_at NULL, run_after <= now, lease NULL or past, ordered by
 *    (run_after, created_at), limited; each claimed row gets
 *    claimed_until = now + 5 min and attempts + 1, and the updated rows are
 *    returned. Row locking is not modelled here; the NAS harness
 *    (supabase/tests/backlog-3849) measures it on Postgres.
 *  - `run_after = 'infinity'`: PostgREST returns the string "infinity"; it
 *    sorts after every date and never satisfies `<= now`.
 *
 * Every filter is APPLIED and RECORDED: a write that drops its `attempts` guard
 * changes a row it no longer owns here, exactly as it would in Postgres.
 */

import type { OutboxRow } from '@/lib/billing/outboxKinds';

export interface Clock {
  now: Date;
}

type Filter =
  | { op: 'eq' | 'neq' | 'lt'; column: string; value: unknown }
  | { op: 'is'; column: string; value: null }
  | { op: 'or'; expression: string };

export interface OutboxCall {
  op: 'select' | 'update';
  filters: Filter[];
  patch?: Record<string, unknown>;
}

export interface RpcResult {
  data: unknown;
  error: { code: string; message: string } | null;
}

/** Comparable value of a timestamptz as PostgREST returns it. */
export function ts(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (v === 'infinity') return Number.POSITIVE_INFINITY;
  if (v === '-infinity') return Number.NEGATIVE_INFINITY;
  return new Date(String(v)).getTime();
}

let seq = 0;
export function outboxRow(over: Partial<OutboxRow> = {}): OutboxRow {
  seq += 1;
  const id = over.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    id,
    stripe_mode: 'test',
    kind: 'fake_kind',
    user_id: null,
    organization_id: 'ORG-3849',
    dedupe_key: `dedupe-${id}`,
    run_after: new Date(Date.UTC(2026, 9, 13, 12, 0, 0) - 60_000).toISOString(),
    payload: {},
    attempts: 0,
    last_error: null,
    claimed_until: null,
    created_at: new Date(Date.UTC(2026, 9, 13, 11, 0, 0)).toISOString(),
    processed_at: null,
    ...over,
  };
}

function matches(row: Record<string, unknown>, f: Filter): boolean {
  if (f.op === 'or') {
    return f.expression.split(',').some((cond) => {
      const [column, op, ...rest] = cond.split('.');
      const raw = rest.join('.');
      const v = row[column];
      if (op === 'is' && raw === 'null') return v === null || v === undefined;
      if (v === null || v === undefined) return false;
      if (op === 'lt') return ts(v) < ts(raw);
      throw new Error(`OutboxDb: unsupported or-condition ${cond}`);
    });
  }
  const v = row[f.column];
  switch (f.op) {
    case 'is':
      return v === null || v === undefined;
    case 'eq':
      return v === f.value;
    case 'neq':
      return v !== null && v !== undefined && String(v) !== String(f.value);
    case 'lt':
      if (v === null || v === undefined) return false;
      return f.column === 'attempts' ? (v as number) < (f.value as number) : ts(v) < ts(f.value);
  }
}

export class OutboxDb {
  rows: OutboxRow[];
  calls: OutboxCall[] = [];
  rpcCalls: { fn: string; args: unknown }[] = [];
  /** Answer of `billing_drain_secret()`. */
  secret: RpcResult = { data: null, error: null };
  claimError: RpcResult['error'] = null;

  constructor(private clock: Clock, rows: OutboxRow[] = []) {
    this.rows = rows.map((r) => ({ ...r }));
  }

  row(id: string): OutboxRow {
    const r = this.rows.find((x) => x.id === id);
    if (!r) throw new Error(`OutboxDb: no row ${id}`);
    return r;
  }

  rpc = async (fn: string, args?: Record<string, unknown>): Promise<RpcResult> => {
    this.rpcCalls.push({ fn, args });
    if (fn === 'billing_drain_secret') return this.secret;
    if (fn === 'billing_outbox_claim') {
      if (this.claimError) return { data: null, error: this.claimError };
      return { data: this.claim(String(args?.p_mode), Number(args?.p_limit)), error: null };
    }
    throw new Error(`OutboxDb: unexpected rpc ${fn}`);
  };

  claim(mode: string, limit: number): OutboxRow[] {
    const now = this.clock.now.getTime();
    const due = this.rows
      .filter(
        (b) =>
          b.stripe_mode === mode &&
          b.processed_at === null &&
          ts(b.run_after) <= now &&
          (b.claimed_until === null || ts(b.claimed_until) < now)
      )
      .sort((a, b) => ts(a.run_after) - ts(b.run_after) || ts(a.created_at) - ts(b.created_at))
      .slice(0, limit);
    for (const r of due) {
      r.claimed_until = new Date(now + 5 * 60_000).toISOString();
      r.attempts += 1;
    }
    return due.map((r) => ({ ...r }));
  }

  from = (table: string) => {
    if (table !== 'billing_outbox') throw new Error(`OutboxDb: unexpected table ${table}`);
    return new OutboxQuery(this);
  };

  updates(): OutboxCall[] {
    return this.calls.filter((c) => c.op === 'update');
  }
}

class OutboxQuery implements PromiseLike<{ data: unknown; error: null; count: number | null }> {
  private call: OutboxCall = { op: 'select', filters: [] };
  private wantCount = false;
  private sortBy: { column: string; ascending: boolean } | null = null;
  private limitN: number | null = null;

  constructor(private db: OutboxDb) {
    db.calls.push(this.call);
  }

  update(patch: Record<string, unknown>) {
    this.call.op = 'update';
    this.call.patch = patch;
    return this;
  }
  select(_columns = '*', opts?: { count?: 'exact' }) {
    if (opts?.count) this.wantCount = true;
    return this;
  }
  eq(column: string, value: unknown) {
    this.call.filters.push({ op: 'eq', column, value });
    return this;
  }
  neq(column: string, value: unknown) {
    this.call.filters.push({ op: 'neq', column, value });
    return this;
  }
  lt(column: string, value: unknown) {
    this.call.filters.push({ op: 'lt', column, value });
    return this;
  }
  is(column: string, value: null) {
    this.call.filters.push({ op: 'is', column, value });
    return this;
  }
  or(expression: string) {
    this.call.filters.push({ op: 'or', expression });
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.sortBy = { column, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  then<A = { data: unknown; error: null; count: number | null }, B = never>(
    onFulfilled?: ((v: { data: unknown; error: null; count: number | null }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve(this.execute()).then(onFulfilled, onRejected);
  }

  private execute(): { data: unknown; error: null; count: number | null } {
    const hit = this.db.rows.filter((r) =>
      this.call.filters.every((f) => matches(r as unknown as Record<string, unknown>, f))
    );
    if (this.call.op === 'update') {
      for (const r of hit) Object.assign(r, this.call.patch);
      return { data: hit.map((r) => ({ id: r.id })), error: null, count: null };
    }
    let out = [...hit];
    if (this.sortBy) {
      const { column, ascending } = this.sortBy;
      out.sort((a, b) => {
        const d =
          ts((a as unknown as Record<string, unknown>)[column]) - ts((b as unknown as Record<string, unknown>)[column]);
        return ascending ? d : -d;
      });
    }
    const count = this.wantCount ? out.length : null;
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return { data: out.map((r) => ({ ...r })), error: null, count };
  }
}
