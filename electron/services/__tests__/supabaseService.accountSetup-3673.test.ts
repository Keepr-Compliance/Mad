/**
 * @jest-environment node
 */

/**
 * BACKLOG-3673 — supabaseService's side of the "setup finished" record.
 *
 * - getAccountSetupRecord selects the two columns for one id; no row -> found:false.
 * - completeAccountSetup only fills an EMPTY value (write-once on the client
 *   side; the DB trigger is the other half).
 * - SR condition 7: _migrateUserToAuthId re-inserts the user row under the auth
 *   id; it must carry onboarding_completed_at, or a migrated finished account
 *   is sent back through setup.
 */

const mockSupabaseClient = {
  from: jest.fn(),
  rpc: jest.fn(),
  auth: {
    getSession: jest.fn().mockResolvedValue({ data: { session: null }, error: null }),
    onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    signOut: jest.fn().mockResolvedValue({ error: null }),
  },
  functions: { invoke: jest.fn() },
};

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { updateSession: jest.fn(() => Promise.resolve(true)) },
}));

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

type Svc = typeof import("../supabaseService").default;

function chain(result: { data: unknown; error: unknown }) {
  const q: Record<string, jest.Mock> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "is"]) {
    q[m] = jest.fn(() => q);
  }
  q.maybeSingle = jest.fn(() => Promise.resolve(result));
  q.single = jest.fn(() => Promise.resolve(result));
  (q as unknown as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return q;
}

const AUTH_ID = "session-user-id";
const OLD_ID = "pre-migration-id";
const TS = "2026-09-30T12:00:00.000Z";

describe("supabaseService — setup-finished record (BACKLOG-3673)", () => {
  let svc: Svc;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    svc = (await import("../supabaseService")).default;
  });

  it("getAccountSetupRecord: selects both columns for the given id", async () => {
    const q = chain({
      data: { onboarding_completed_at: TS, email_onboarding_completed_at: TS },
      error: null,
    });
    mockSupabaseClient.from.mockReturnValue(q);

    await expect(svc.getAccountSetupRecord(AUTH_ID)).resolves.toEqual({
      found: true,
      onboardingCompletedAt: TS,
      emailOnboardingCompletedAt: TS,
    });
    expect(mockSupabaseClient.from).toHaveBeenCalledWith("users");
    expect(q.select).toHaveBeenCalledWith("onboarding_completed_at, email_onboarding_completed_at");
    expect(q.eq).toHaveBeenCalledWith("id", AUTH_ID);
  });

  it("getAccountSetupRecord: no row -> found:false; an error throws", async () => {
    mockSupabaseClient.from.mockReturnValue(chain({ data: null, error: null }));
    await expect(svc.getAccountSetupRecord(AUTH_ID)).resolves.toEqual({
      found: false,
      onboardingCompletedAt: null,
      emailOnboardingCompletedAt: null,
    });
    mockSupabaseClient.from.mockReturnValue(chain({ data: null, error: { message: "boom" } }));
    await expect(svc.getAccountSetupRecord(AUTH_ID)).rejects.toEqual({ message: "boom" });
  });

  it("completeAccountSetup: sets the value only where it is still empty", async () => {
    const q = chain({ data: null, error: null });
    mockSupabaseClient.from.mockReturnValue(q);

    await svc.completeAccountSetup(AUTH_ID);

    expect(q.update).toHaveBeenCalledWith({ onboarding_completed_at: expect.any(String) });
    expect(q.eq).toHaveBeenCalledWith("id", AUTH_ID);
    expect(q.is).toHaveBeenCalledWith("onboarding_completed_at", null);
  });

  it("completeAccountSetup: an error throws (never silently succeeds)", async () => {
    mockSupabaseClient.from.mockReturnValue(chain({ data: null, error: { message: "rls" } }));
    await expect(svc.completeAccountSetup(AUTH_ID)).rejects.toEqual({ message: "rls" });
  });

  it("SR condition 7: _migrateUserToAuthId carries onboarding_completed_at into the new row", async () => {
    const insertQ = chain({ data: { id: AUTH_ID }, error: null });
    const otherQ = chain({ data: null, error: null });
    mockSupabaseClient.from.mockImplementation(() => {
      // first call is the insert; every later call (child tables, delete) is otherQ
      return mockSupabaseClient.from.mock.calls.length === 1 ? insertQ : otherQ;
    });

    const oldUser = {
      id: OLD_ID,
      email: "user@example.com",
      oauth_provider: "google",
      oauth_id: "oauth-1",
      subscription_tier: "free",
      subscription_status: "trial",
      email_onboarding_completed_at: TS,
      onboarding_completed_at: TS,
      created_at: TS,
    };
    await (svc as unknown as {
      _migrateUserToAuthId: (u: unknown, id: string) => Promise<unknown>;
    })._migrateUserToAuthId(oldUser, AUTH_ID);

    expect(insertQ.insert).toHaveBeenCalledTimes(1);
    expect(insertQ.insert.mock.calls[0][0]).toEqual(
      expect.objectContaining({ id: AUTH_ID, onboarding_completed_at: TS }),
    );
  });
});
