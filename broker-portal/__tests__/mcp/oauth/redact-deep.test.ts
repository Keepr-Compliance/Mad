/**
 * @jest-environment node
 *
 * BACKLOG-4238 — redactDeep: a value shared by two siblings is copied, not
 * marked as a cycle; a real cycle is still marked; breadth and total size are
 * limited, so a wide or heavily shared object finishes quickly.
 */

const mockInit = jest.fn();
jest.mock('@sentry/nextjs', () => ({ init: (...a: unknown[]) => mockInit(...a) }));

import { redactDeep } from '@/lib/mcp/sentryScrub';
import { PLANTED_KPR } from './fixtures';

type Rec = Record<string, unknown>;

describe('redactDeep', () => {
  it('a value shared by two siblings is copied into both', () => {
    const shared = { v: 'x', k: PLANTED_KPR };
    const out = redactDeep({ a: shared, b: shared, list: [shared, shared] }) as Rec;
    expect(out.a).toEqual({ v: 'x', k: '[redacted]' });
    expect(out.b).toEqual({ v: 'x', k: '[redacted]' });
    expect(out.list).toEqual([
      { v: 'x', k: '[redacted]' },
      { v: 'x', k: '[redacted]' },
    ]);
  });

  it('a reference back to an ancestor is still a cycle', () => {
    const root: Rec = { k: PLANTED_KPR };
    root.child = { up: root };
    const arr: unknown[] = ['s'];
    arr.push(arr);
    const out = redactDeep({ root, arr }) as Rec;
    expect(((out.root as Rec).child as Rec).up).toBe('[circular]');
    expect(out.arr).toEqual(['s', '[circular]']);
  });

  it('an object over 1000 keys keeps the first 1000 and records the rest', () => {
    const wide: Rec = {};
    for (let i = 0; i < 1005; i++) wide[`k${i}`] = i;
    const out = redactDeep(wide) as Rec;
    expect(Object.keys(out)).toHaveLength(1001);
    expect(out.k999).toBe(999);
    expect(out.k1000).toBeUndefined();
    expect(out['[truncated]']).toBe(5);
  });

  it('an array over 1000 entries keeps the first 1000 and a marker', () => {
    const out = redactDeep([...Array(1003).keys()]) as unknown[];
    expect(out).toHaveLength(1001);
    expect(out[999]).toBe(999);
    expect(out[1000]).toBe('[truncated]');
  });

  it('positive: exactly 1000 keys and 1000 entries are kept whole', () => {
    const wide: Rec = {};
    for (let i = 0; i < 1000; i++) wide[`k${i}`] = i;
    expect(redactDeep(wide)).toEqual(wide);
    expect(redactDeep([...Array(1000).keys()])).toEqual([...Array(1000).keys()]);
  });

  it('a heavily shared object stops at the size limit', () => {
    // each level holds the next one four times: 4^9 paths if every one were copied
    let node: Rec = { leaf: PLANTED_KPR };
    for (let i = 0; i < 9; i++) node = { a: node, b: node, c: node, d: node };
    const started = Date.now();
    const out = redactDeep(node);
    expect(Date.now() - started).toBeLessThan(2000);
    const text = JSON.stringify(out);
    expect(text).toContain('[truncated]');
    expect(text).not.toContain(PLANTED_KPR);
  });

  it('a non-MCP breadcrumb whose data shares a value is unchanged by the hook', () => {
    jest.isolateModules(() => {
      require('../../../sentry.server.config');
    });
    const hooks = mockInit.mock.calls[0][0] as { beforeBreadcrumb: (_b: Rec) => Rec | null };
    const shared = { id: 7 };
    const out = hooks.beforeBreadcrumb({ category: 'console', data: { arguments: [shared, shared] } })!;
    expect(out.data).toEqual({ arguments: [{ id: 7 }, { id: 7 }] });
  });
});
