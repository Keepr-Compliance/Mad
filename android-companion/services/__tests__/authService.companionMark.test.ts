/**
 * BACKLOG-2326: the companion marks its own session so the broker's single-session enforcement
 * ALWAYS spares the phone. Verifies:
 *  - markCompanionSession() calls the mark_companion_session RPC with NO arguments (the RPC derives
 *    the session id from the caller's JWT server-side — a client can only mark its own session),
 *  - it is best-effort (swallows RPC errors and throws without failing),
 *  - a successful OAuth/magic-link session establishment (extractSessionFromUrl) triggers the mark,
 *    and a FAILED session establishment does not.
 */

const mockRpc = jest.fn();
const mockSetSession = jest.fn();

jest.mock('../supabaseClient', () => ({
  supabase: {
    auth: { setSession: (...args: unknown[]) => mockSetSession(...args) },
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
}));
jest.mock('expo-linking', () => ({ createURL: () => 'keepr-companion://auth/callback' }));
jest.mock('expo-web-browser', () => ({}));
jest.mock('../authSessionState', () => ({
  clearHadSession: jest.fn(),
  markDeliberateSignOut: jest.fn(),
}));

import { markCompanionSession, extractSessionFromUrl } from '../authService';

const REDIRECT_WITH_TOKENS =
  'keepr-companion://auth/callback#access_token=AAA&refresh_token=BBB';

beforeEach(() => {
  mockRpc.mockReset();
  mockSetSession.mockReset();
});

describe('markCompanionSession', () => {
  it('calls mark_companion_session with no arguments (server derives identity from the JWT)', async () => {
    mockRpc.mockResolvedValue({ error: null });
    await markCompanionSession();
    expect(mockRpc).toHaveBeenCalledWith('mark_companion_session');
    expect(mockRpc.mock.calls[0].length).toBe(1); // no id params passed
  });

  it('is best-effort: swallows an RPC error without throwing', async () => {
    mockRpc.mockResolvedValue({ error: { message: 'denied' } });
    await expect(markCompanionSession()).resolves.toBeUndefined();
  });

  it('is best-effort: swallows a thrown/rejected RPC without throwing', async () => {
    mockRpc.mockRejectedValue(new Error('network'));
    await expect(markCompanionSession()).resolves.toBeUndefined();
  });
});

describe('extractSessionFromUrl marks the companion after a successful login', () => {
  it('marks the session when setSession succeeds', async () => {
    mockSetSession.mockResolvedValue({ error: null });
    mockRpc.mockResolvedValue({ error: null });

    const result = await extractSessionFromUrl(REDIRECT_WITH_TOKENS);

    expect(result).toBeNull(); // success
    expect(mockRpc).toHaveBeenCalledWith('mark_companion_session');
  });

  it('does NOT mark when setSession fails', async () => {
    mockSetSession.mockResolvedValue({ error: { message: 'bad token' } });

    const result = await extractSessionFromUrl(REDIRECT_WITH_TOKENS);

    expect(result).toBe('bad token');
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
