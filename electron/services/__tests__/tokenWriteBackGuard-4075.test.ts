/**
 * @jest-environment node
 */

/**
 * BACKLOG-4075: the TOKEN_REFRESHED write-back writes rotated tokens only into
 * the SAME account's session.json. The guard is the `proceed` callback that
 * supabaseService hands to sessionService.updateSession, which runs it inside
 * the lock against the file on disk (sessionService.updateGuard-4075 proves
 * the lock half). Here: the rule the callback applies.
 *
 * W1 is the BACKLOG-2332 trap: a pre-1507G file keeps its legacy local id, so a
 * bare id compare would skip every rotation for that user.
 */

let capturedAuthStateCallback: ((event: string, session: unknown) => void) | null = null;
const mockUpdateSession = jest.fn((..._args: unknown[]) => Promise.resolve(true));
const mockWarn = jest.fn();

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(),
    rpc: jest.fn(),
    functions: { invoke: jest.fn() },
    auth: {
      getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: jest.fn((cb: (event: string, session: unknown) => void) => {
        capturedAuthStateCallback = cb;
        return { data: { subscription: { unsubscribe: jest.fn() } } };
      }),
      signOut: jest.fn().mockResolvedValue({ error: null }),
    },
  })),
}));
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { updateSession: (...args: unknown[]) => mockUpdateSession(...args) },
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: mockWarn, error: jest.fn() },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

// Invented ids and addresses.
const A = "40750000-0000-4000-8000-0000000000a1"; // pii-allow-uuid: invented fixture id
const B = "40750000-0000-4000-8000-0000000000b1"; // pii-allow-uuid: invented fixture id
const LEGACY = "40750000-0000-4000-8000-0000000000c9"; // pii-allow-uuid: invented fixture id (pre-1507G local id)
const A_EMAIL = "agent-a-4075@example.test";
const B_EMAIL = "agent-b-4075@example.test";

type Proceed = (current: { user: Record<string, unknown> }) => boolean;

describe("BACKLOG-4075: token write-back same-account guard", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sentry = require("@sentry/electron/main") as { captureMessage: jest.Mock; setUser: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const svc = require("../supabaseService").default as { initialize: () => void };
      svc.initialize();
    });
  });

  /** Fires a rotation for `user` and returns the guard handed to updateSession. */
  function rotate(user: Record<string, unknown>): Proceed {
    capturedAuthStateCallback!("TOKEN_REFRESHED", {
      user,
      access_token: "rot-at",
      refresh_token: "rot-rt",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
    const [updates, opts] = mockUpdateSession.mock.calls[0] as [unknown, { proceed?: Proceed } | undefined];
    expect(updates).toEqual({ supabaseTokens: { access_token: "rot-at", refresh_token: "rot-rt" } });
    expect(typeof opts?.proceed).toBe("function");
    return opts!.proceed!;
  }

  it("W1 file has the pre-1507G legacy id, same email: written (BACKLOG-2332)", () => {
    const proceed = rotate({ id: A, email: A_EMAIL });
    expect(proceed({ user: { id: LEGACY, email: A_EMAIL } })).toBe(true);
    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });

  it("W2 file belongs to another account: not written; WARN 8-char ids, Sentry level + tags only", () => {
    const proceed = rotate({ id: A, email: A_EMAIL });
    expect(proceed({ user: { id: B, email: B_EMAIL } })).toBe(false);
    const warns = mockWarn.mock.calls.filter((c) => /different account/.test(String(c[0])));
    expect(warns).toHaveLength(1);
    for (const v of Object.values(warns[0][2] as Record<string, unknown>)) expect(v).toMatch(/^[0-9a-f]{8}\.\.\.$/);
    const msgs = sentry.captureMessage.mock.calls;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toHaveLength(2);
    expect(Object.keys(msgs[0][1] as object).sort()).toEqual(["level", "tags"]);
    for (const text of [JSON.stringify(warns), JSON.stringify(msgs)]) {
      for (const id of [A, B]) expect(text).not.toContain(id);
      expect(text).not.toContain("example.test");
      expect(text).not.toContain("rot-");
    }
    expect(sentry.setUser).not.toHaveBeenCalled();
  });

  it("W3 same id, the account's email changed since the file was written: written", () => {
    const proceed = rotate({ id: A, email: "renamed-4075@example.test" });
    expect(proceed({ user: { id: A, email: A_EMAIL } })).toBe(true);
  });

  it("W4 Microsoft: email only in user_metadata, legacy-id file: written", () => {
    const proceed = rotate({ id: A, email: "", user_metadata: { email: A_EMAIL } });
    expect(proceed({ user: { id: LEGACY, email: A_EMAIL } })).toBe(true);
  });
});
