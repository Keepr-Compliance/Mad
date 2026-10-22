/**
 * BACKLOG-4036: createServiceClient({ actorId }) sends the x-keepr-actor header, which the
 * database records as the actor of a service-role write in the organization activity log.
 */
const mockCreateClient = jest.fn((..._args: unknown[]) => ({}));
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

import { createServiceClient } from '@/lib/supabase/service';

describe('broker createServiceClient actor header (BACKLOG-4036)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    mockCreateClient.mockClear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.example.test';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  });
  afterAll(() => {
    process.env = env;
  });

  it('sends x-keepr-actor when an actor is given', () => {
    createServiceClient({ actorId: '00000000-0000-0000-0000-000000000000' });
    const options = mockCreateClient.mock.calls[0][2] as { global?: unknown };
    expect(options.global).toEqual({ headers: { 'x-keepr-actor': '00000000-0000-0000-0000-000000000000' } });
  });

  it('sends no actor header without one', () => {
    createServiceClient();
    const options = mockCreateClient.mock.calls[0][2] as { global?: unknown };
    expect(options.global).toBeUndefined();
  });
});
