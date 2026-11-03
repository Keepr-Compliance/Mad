/**
 * A multi-table PostgREST stub for report query tests (BACKLOG-3723, SR R1)
 *
 * It behaves like the server, so a wrong query fails on BEHAVIOUR, not only on
 * its call shape:
 *   (i)   `.select(cols)` PROJECTS each row to those columns and parses
 *         `alias:col` (`id:user_id` returns the row's user_id as `id`);
 *   (ii)  `.eq` / `.is` / `.gte` / `.in` FILTER (strict equality: a NULL
 *         `is_active` does not match `eq(true)`);
 *   (iii) `.order()` sorts; rows still tied after every supplied order come
 *         back in a DIFFERENT arbitrary order on every request, as on the
 *         server, so a non-total order is not stable across pages;
 *   (iv)  `.range(from, to)` slices;
 *   (v)   with NO `.range()` only the first `maxRows` (1000) rows come back —
 *         the server's max_rows cap that a single unpaged read silently hits.
 *   `select(cols, { count: 'exact', head: true })` returns `{ data: null, count }`.
 *
 * Not a test file (no `.test.`), so vitest does not collect it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type StubRow = Record<string, unknown>;

export interface StubCall {
  table: string;
  method: string;
  args: unknown[];
}

export interface StubOptions {
  /** Tables whose every read returns an error. */
  failTables?: string[];
  /** Fail only reads that satisfy this (table + recorded calls of that request). */
  failWhen?: (table: string, calls: StubCall[]) => boolean;
  /** Server max_rows; default 1000. */
  maxRows?: number;
  /** Called before each request resolves (e.g. to bump a row between pages). */
  beforeRequest?: (table: string, request: number) => void;
}

/** FNV-1a: a deterministic per-request shuffle key. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1; // NULLS LAST for ascending
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : 1;
}

export function stubClient(tables: Record<string, StubRow[]>, opts: StubOptions = {}) {
  const calls: StubCall[] = [];
  const maxRows = opts.maxRows ?? 1000;
  let request = 0;
  const client = {
    from(table: string) {
      const filters: ((r: StubRow) => boolean)[] = [];
      const orders: { col: string; asc: boolean }[] = [];
      const mine: StubCall[] = [];
      let columns: { out: string; src: string }[] | null = null;
      let head = false;
      let range: [number, number] | null = null;
      const builder: Record<string, unknown> = {
        then(resolve: (value: unknown) => unknown, reject?: (e: unknown) => unknown) {
          const req = request;
          request += 1;
          opts.beforeRequest?.(table, req);
          if (opts.failTables?.includes(table) || opts.failWhen?.(table, mine)) {
            return Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(resolve, reject);
          }
          const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (head) return Promise.resolve({ data: null, count: rows.length, error: null }).then(resolve, reject);
          const sorted = [...rows].sort((a, b) => {
            for (const o of orders) {
              const c = compare(a[o.col], b[o.col]);
              if (c !== 0) return c * (o.asc ? 1 : -1);
            }
            return hash(`${req}:${JSON.stringify(a)}`) - hash(`${req}:${JSON.stringify(b)}`);
          });
          const page = range ? sorted.slice(range[0], range[1] + 1) : sorted.slice(0, maxRows);
          const projected = columns
            ? page.map((r) => Object.fromEntries(columns!.filter((c) => c.src in r).map((c) => [c.out, r[c.src]])))
            : page;
          return Promise.resolve({ data: projected, count: null, error: null }).then(resolve, reject);
        },
      };
      const record = (method: string, fn: (...args: unknown[]) => void) => {
        builder[method] = (...args: unknown[]) => {
          const call = { table, method, args };
          calls.push(call);
          mine.push(call);
          fn(...args);
          return builder;
        };
      };
      record('select', (cols, o) => {
        columns = String(cols)
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
          .map((c) => {
            const [out, src] = c.includes(':') ? c.split(':').map((s) => s.trim()) : [c, c];
            return { out, src };
          });
        head = Boolean((o as { head?: boolean } | undefined)?.head);
      });
      record('eq', (col, v) => filters.push((r) => r[col as string] === v));
      record('is', (col, v) => filters.push((r) => (r[col as string] ?? null) === v));
      record('gte', (col, v) =>
        filters.push((r) => r[col as string] !== null && r[col as string] !== undefined && compare(r[col as string], v) >= 0)
      );
      record('in', (col, values) => filters.push((r) => (values as unknown[]).includes(r[col as string])));
      record('order', (col, o) =>
        orders.push({ col: col as string, asc: (o as { ascending?: boolean } | undefined)?.ascending !== false })
      );
      record('range', (from, to) => {
        range = [from as number, to as number];
      });
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

/** The args of every call to `method` on `table`. */
export const argsOn = (calls: StubCall[], table: string, method: string) =>
  calls.filter((c) => c.table === table && c.method === method).map((c) => c.args);

export const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
