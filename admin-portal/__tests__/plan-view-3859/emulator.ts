/**
 * A tiny PostgREST-shaped client over in-memory tables, for BACKLOG-3859.
 *
 * Supports exactly what lib/planLines.ts uses: from().select().in().eq().order(),
 * awaited. `.in` / `.eq` filter, `.order` sorts (so a reversed order changes the
 * answer), and every from()/rpc() call is counted so N+1 shows up as a count.
 */

import type { Row } from './fixtures';

export interface CallLog {
  from: string[];
  rpc: string[];
}

type Filter = (r: Row) => boolean;

export function makeClient(
  tables: Record<string, Row[]>,
  opts: { rpc?: (name: string, args: unknown) => { data: unknown; error: unknown }; failTable?: string } = {}
) {
  const log: CallLog = { from: [], rpc: [] };
  const client = {
    from(table: string) {
      log.from.push(table);
      const filters: Filter[] = [];
      const orders: { col: string; asc: boolean }[] = [];
      const builder = {
        select() {
          return builder;
        },
        in(col: string, values: unknown[]) {
          filters.push((r) => values.includes(r[col]));
          return builder;
        },
        eq(col: string, value: unknown) {
          filters.push((r) => r[col] === value);
          return builder;
        },
        order(col: string, o?: { ascending?: boolean }) {
          orders.push({ col, asc: o?.ascending !== false });
          return builder;
        },
        then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
          if (opts.failTable === table) {
            return Promise.resolve({ data: null, error: { message: 'emulated failure' } }).then(resolve, reject);
          }
          let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (orders.length) {
            rows = [...rows].sort((a, b) => {
              for (const { col, asc } of orders) {
                const x = String(a[col]);
                const y = String(b[col]);
                if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
              }
              return 0;
            });
          }
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name: string, args: unknown) {
      log.rpc.push(name);
      return Promise.resolve(opts.rpc ? opts.rpc(name, args) : { data: null, error: { message: 'no rpc' } });
    },
  };
  return { client, log };
}
