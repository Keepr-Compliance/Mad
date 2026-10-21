/**
 * BACKLOG-4036: createServiceClient({ actorId }) sends the x-keepr-actor header, which the
 * database records as the actor of a service-role write in the organization activity log.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: Array<{ url: string; key: string; options: Record<string, unknown> }> = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: (url: string, key: string, options: Record<string, unknown>) => {
    created.push({ url, key, options });
    return {};
  },
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({}) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));

import { createServiceClient } from '@/lib/supabase/server';

beforeEach(() => {
  created.length = 0;
});

describe('admin createServiceClient actor header (BACKLOG-4036)', () => {
  it('sends x-keepr-actor when an actor is given', () => {
    createServiceClient({ actorId: '00000000-0000-0000-0000-000000000000' });
    expect(created[0].options.global).toEqual({ headers: { 'x-keepr-actor': '00000000-0000-0000-0000-000000000000' } });
  });

  it('sends no actor header without one', () => {
    createServiceClient();
    expect(created[0].options.global).toBeUndefined();
  });
});
