/**
 * @jest-environment node
 */

/**
 * BACKLOG-3674 — supabaseService's side of the "tour dismissed" record.
 *
 * - getTourDismissedAt selects only tour_dismissed_at for one id.
 * - dismissTour only fills an EMPTY value; a 0-row update is success only when
 *   a re-read finds the value set.
 * - SR C-2: _migrateUserToAuthId carries tour_dismissed_at only when the read
 *   row had the key -- before the migration is applied, the column does not
 *   exist and naming it would fail the insert.
 * - W2: the setup record's select never names tour_dismissed_at.
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
const TS = "2026-10-07T12:00:00.000Z";

describe("supabaseService — tour-dismissed record (BACKLOG-3674)", () => {
  let svc: Svc;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseClient.from.mockReset();
    jest.resetModules();
    svc = (await import("../supabaseService")).default;
  });

  it("getTourDismissedAt: selects only the tour column for the given id", async () => {
    const q = chain({ data: { tour_dismissed_at: TS }, error: null });
    mockSupabaseClient.from.mockReturnValue(q);
    await expect(svc.getTourDismissedAt(AUTH_ID)).resolves.toEqual({ found: true, tourDismissedAt: TS });
    expect(mockSupabaseClient.from).toHaveBeenCalledWith("users");
    expect(q.select).toHaveBeenCalledWith("tour_dismissed_at");
    expect(q.eq).toHaveBeenCalledWith("id", AUTH_ID);
  });

  it("getTourDismissedAt: no row -> found:false; an error throws", async () => {
    mockSupabaseClient.from.mockReturnValue(chain({ data: null, error: null }));
    await expect(svc.getTourDismissedAt(AUTH_ID)).resolves.toEqual({ found: false, tourDismissedAt: null });
    mockSupabaseClient.from.mockReturnValue(chain({ data: null, error: { message: "boom" } }));
    await expect(svc.getTourDismissedAt(AUTH_ID)).rejects.toEqual({ message: "boom" });
  });

  it("dismissTour: sets the value only where it is still empty; 1 row -> done, no re-read", async () => {
    const q = chain({ data: [{ id: AUTH_ID }], error: null });
    mockSupabaseClient.from.mockReturnValue(q);
    await expect(svc.dismissTour(AUTH_ID)).resolves.toBeUndefined();
    expect(q.update).toHaveBeenCalledWith({ tour_dismissed_at: expect.any(String) });
    expect(q.eq).toHaveBeenCalledWith("id", AUTH_ID);
    expect(q.is).toHaveBeenCalledWith("tour_dismissed_at", null);
    expect(mockSupabaseClient.from).toHaveBeenCalledTimes(1);
  });

  it("dismissTour: 0 rows, re-read finds the value set -> success (first value kept)", async () => {
    mockSupabaseClient.from
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(chain({ data: { tour_dismissed_at: TS }, error: null }));
    await expect(svc.dismissTour(AUTH_ID)).resolves.toBeUndefined();
    expect(mockSupabaseClient.from).toHaveBeenCalledTimes(2);
  });

  it("dismissTour: 0 rows and still empty / no row -> throws", async () => {
    mockSupabaseClient.from
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(chain({ data: { tour_dismissed_at: null }, error: null }));
    await expect(svc.dismissTour(AUTH_ID)).rejects.toThrow(/still empty/);
    mockSupabaseClient.from
      .mockReturnValueOnce(chain({ data: [], error: null }))
      .mockReturnValueOnce(chain({ data: null, error: null }));
    await expect(svc.dismissTour(AUTH_ID)).rejects.toThrow(/no users row/);
  });

  it("dismissTour: an error throws (never silently succeeds)", async () => {
    mockSupabaseClient.from.mockReturnValue(chain({ data: null, error: { message: "permission denied" } }));
    await expect(svc.dismissTour(AUTH_ID)).rejects.toEqual({ message: "permission denied" });
  });

  it("W2: the setup record's select does not name tour_dismissed_at", async () => {
    const q = chain({ data: null, error: null });
    mockSupabaseClient.from.mockReturnValue(q);
    await svc.getAccountSetupRecord(AUTH_ID);
    expect(String(q.select.mock.calls[0][0])).not.toContain("tour_dismissed_at");
  });

  async function migrate(oldUser: Record<string, unknown>) {
    const insertQ = chain({ data: { id: AUTH_ID }, error: null });
    const otherQ = chain({ data: null, error: null });
    mockSupabaseClient.from.mockImplementation(() =>
      mockSupabaseClient.from.mock.calls.length === 1 ? insertQ : otherQ,
    );
    await (svc as unknown as {
      _migrateUserToAuthId: (u: unknown, id: string) => Promise<unknown>;
    })._migrateUserToAuthId(oldUser, AUTH_ID);
    expect(insertQ.insert).toHaveBeenCalledTimes(1);
    return insertQ.insert.mock.calls[0][0] as Record<string, unknown>;
  }

  const baseOldUser = {
    id: OLD_ID,
    email: "user@example.com",
    oauth_provider: "google",
    oauth_id: "oauth-1",
    subscription_tier: "free",
    subscription_status: "trial",
    created_at: TS,
  };

  it("C-2: read row without the column -> the insert has no tour_dismissed_at key", async () => {
    const payload = await migrate({ ...baseOldUser });
    expect(Object.prototype.hasOwnProperty.call(payload, "tour_dismissed_at")).toBe(false);
  });

  it("C-2: read row with the column -> carried (set and null)", async () => {
    expect(await migrate({ ...baseOldUser, tour_dismissed_at: TS })).toEqual(
      expect.objectContaining({ id: AUTH_ID, tour_dismissed_at: TS }),
    );
    mockSupabaseClient.from.mockReset();
    const payload = await migrate({ ...baseOldUser, tour_dismissed_at: null });
    expect(Object.prototype.hasOwnProperty.call(payload, "tour_dismissed_at")).toBe(true);
    expect(payload.tour_dismissed_at).toBeNull();
  });
});
export {};
