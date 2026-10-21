/** Admin middleware: a signed-in visit to /login?redirectTo=<x> stays on this origin and under /dashboard. BACKLOG-3705. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { REFUSED } from './cases';

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.single = async () => ({ data: { role_id: 'r-1' }, error: null });
      return b;
    },
    rpc: async () => ({ data: true, error: null }),
  }),
}));

import { middleware } from '@/middleware';

const ORIGIN = 'https://admin.test';
async function location(raw: string): Promise<URL> {
  const res = await middleware(new NextRequest(`${ORIGIN}/login?redirectTo=${encodeURIComponent(raw)}`));
  const to = res.headers.get('location');
  if (!to) throw new Error(`no redirect for ${raw}`);
  return new URL(to);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-fixture';
});

describe('redirectTo', () => {
  it.each(REFUSED)('%s -> /dashboard on this origin', async (raw) => {
    const to = await location(raw);
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe('/dashboard');
  });
  it.each(['/dashboard/users', '/dashboard/audit-log'])('%s is kept', async (raw) => {
    const to = await location(raw);
    expect(`${to.origin}${to.pathname}`).toBe(`${ORIGIN}${raw}`);
  });
  it('no redirectTo -> /dashboard', async () => {
    const res = await middleware(new NextRequest(`${ORIGIN}/login`));
    expect(new URL(res.headers.get('location')!).pathname).toBe('/dashboard');
  });
});
