/** Admin /auth/callback: ?next= stays on this origin and under /dashboard. BACKLOG-3705. */
import { describe, expect, it, vi } from 'vitest';
import { REFUSED } from './cases';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: null }),
      getUser: async () => ({ data: { user: { id: 'u-1', email: '', app_metadata: { provider: 'azure' } } } }),
    },
    rpc: async () => ({ data: null, error: null }),
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.single = async () => ({ data: { role_id: 'r-1' }, error: null });
      return b;
    },
  }),
  createServiceClient: () => ({}),
}));

import { GET } from '@/app/auth/callback/route';

const ORIGIN = 'https://admin.test';
async function location(next: string | null): Promise<string> {
  const qs = next === null ? '' : `&next=${encodeURIComponent(next)}`;
  const res = await GET(new Request(`${ORIGIN}/auth/callback?code=fixture-code${qs}`));
  return res.headers.get('location') ?? '';
}

describe('next', () => {
  it.each(REFUSED)('%s -> /dashboard on this origin', async (raw) => {
    expect(await location(raw)).toBe(`${ORIGIN}/dashboard`);
  });
  it.each(['/dashboard/users', '/dashboard/audit-log?page=2'])('%s is kept', async (raw) => {
    expect(await location(raw)).toBe(`${ORIGIN}${raw}`);
  });
  it('no next -> /dashboard', async () => {
    expect(await location(null)).toBe(`${ORIGIN}/dashboard`);
  });
});
