/**
 * BACKLOG-2326: the companion Supabase client sends a distinctive marker so the broker's
 * single-desktop enforcement can positively recognize a companion session (defense-in-depth).
 *
 * This is belt-and-suspenders — the broker spares the phone by never tracking it as a desktop
 * login — but the marker must be present and unmistakable on the outgoing requests.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  setItem: jest.fn(),
  getItem: jest.fn(),
  removeItem: jest.fn(),
}));

const mockCreateClient = jest.fn((..._args: unknown[]) => ({ auth: {} }));
jest.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

describe('companion supabase client marker (BACKLOG-2326)', () => {
  // Require lazily (not a top-level import) so the mocked createClient — which references the
  // `mockCreateClient` const above — is fully initialized before the module runs createClient().
  let COMPANION_CLIENT_HEADERS: Record<string, string>;
  beforeAll(() => {
    ({ COMPANION_CLIENT_HEADERS } = require('../supabaseClient'));
  });

  it('exports a User-Agent marker that identifies the companion', () => {
    expect(COMPANION_CLIENT_HEADERS['User-Agent']).toContain('KeeprCompanion');
    expect(COMPANION_CLIENT_HEADERS['X-Client-Info']).toBe('keepr-companion');
  });

  it('passes the marker headers to createClient global.headers', () => {
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    const config = mockCreateClient.mock.calls[0][2] as {
      global?: { headers?: Record<string, string> };
    };
    expect(config.global?.headers?.['User-Agent']).toContain('KeeprCompanion');
    expect(config.global?.headers?.['X-Client-Info']).toBe('keepr-companion');
  });
});
