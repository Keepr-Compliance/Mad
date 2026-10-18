/**
 * @jest-environment node
 */

/**
 * BACKLOG-3991 — sign-in fills a blank first/last name in public.users and
 * never overwrites a stored one (founder rule on BACKLOG-3851).
 *
 * The fake below holds ONE public.users row and evaluates the PostgREST
 * filter the service sends (`is.null` / `match`), so these tests check the
 * row that results, not just which methods were called. The exact filter
 * string is also pinned: that string was sent to real PostgREST (keepr-test)
 * and parsed (200 on GET; a misspelled operator gave PGRST100), and its
 * predicate `(v IS NULL OR v ~ '^\s*$')` was run in Postgres for NULL, '',
 * '  ', '\t', ' \n ' (all blank) and 'Bob', ' Bob ' (not blank).
 */

type Row = Record<string, unknown>;

let row: Row | null = null;
const updatePayloads: Row[] = [];
const orFilters: string[] = [];

function matchesOr(r: Row, filter: string): boolean {
  // Supports exactly the shapes the service emits: "<col>.is.null" and "<col>.match.<regex>".
  return filter.split(/,(?=[a-z_]+\.)/).some((term) => {
    const [col, op, ...rest] = term.split(".");
    const arg = rest.join(".");
    const v = r[col];
    if (op === "is" && arg === "null") return v === null || v === undefined;
    if (op === "match") return typeof v === "string" && new RegExp(arg).test(v);
    throw new Error(`fake: unsupported filter term ${term}`);
  });
}

function makeBuilder() {
  let payload: Row | null = null;
  let idFilter: unknown;
  let orFilter: string | null = null;
  const run = () => {
    if (payload) {
      updatePayloads.push(payload);
      if (orFilter !== null) orFilters.push(orFilter);
      if (row && row.id === idFilter && (orFilter === null || matchesOr(row, orFilter))) {
        row = { ...row, ...payload };
      }
    }
  };
  const builder: Record<string, unknown> = {
    select: () => builder,
    update: (p: Row) => {
      payload = p;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      if (col === "id") idFilter = val;
      return builder;
    },
    or: (f: string) => {
      orFilter = f;
      return builder;
    },
    single: async () => {
      run();
      if (row && row.id === idFilter) return { data: { ...row }, error: null };
      return { data: null, error: { code: "PGRST116", message: "Not found" } };
    },
    then: (resolve: (v: unknown) => unknown) => {
      run();
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return builder;
}

const mockSupabaseClient = {
  from: jest.fn(() => makeBuilder()),
  rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
  auth: {
    getSession: jest.fn().mockResolvedValue({
      data: { session: { user: { id: "auth-user-3991" } } },
      error: null,
    }),
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

const signIn = {
  email: "agent@example.com",
  first_name: "Provider",
  last_name: "Name",
  display_name: "Provider Name",
  oauth_provider: "microsoft",
  oauth_id: "ms-3991",
};

describe("BACKLOG-3991 syncUser fills blank names only", () => {
  let service: typeof import("../supabaseService").default;
  let mod: typeof import("../supabaseService");

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    updatePayloads.length = 0;
    orFilters.length = 0;
    mod = await import("../supabaseService");
    service = mod.default;
    (service as any).initialized = false;
    (service as any).client = null;
    service.initialize();
  });

  const seed = (first: unknown, last: unknown) => {
    row = { id: "auth-user-3991", email: signIn.email, first_name: first, last_name: last };
  };

  it("keeps a stored non-blank name on sign-in (admin edit sticks)", async () => {
    seed("Adminset", "Surname");
    const result = await service.syncUser(signIn);
    expect(row).toMatchObject({ first_name: "Adminset", last_name: "Surname" });
    expect(result.first_name).toBe("Adminset");
    expect(result.last_name).toBe("Surname");
  });

  it.each([
    ["NULL", null],
    ["empty", ""],
    ["spaces", "   "],
    ["tab/newline", "\t\n "],
  ])("fills a %s name from the provider", async (_label, blank) => {
    seed(blank, blank);
    const result = await service.syncUser(signIn);
    expect(row).toMatchObject({ first_name: "Provider", last_name: "Name" });
    expect(result.first_name).toBe("Provider");
  });

  it("fills only the blank column when one is set", async () => {
    seed("Adminset", null);
    await service.syncUser(signIn);
    expect(row).toMatchObject({ first_name: "Adminset", last_name: "Name" });
  });

  it("never writes a blank provider value over a stored name", async () => {
    seed("Adminset", "Surname");
    await service.syncUser({ ...signIn, first_name: "  ", last_name: undefined });
    expect(row).toMatchObject({ first_name: "Adminset", last_name: "Surname" });
  });

  it("puts the blank test in the statement, with the filter proven on real PostgREST", async () => {
    seed("Adminset", "Surname");
    await service.syncUser(signIn);
    expect(orFilters).toEqual([
      "first_name.is.null,first_name.match.^\\s*$",
      "last_name.is.null,last_name.match.^\\s*$",
    ]);
    // The unconditional sign-in update carries no first/last name.
    const unconditional = updatePayloads.filter((p) => "last_login_at" in p);
    expect(unconditional).toHaveLength(1);
    expect(unconditional[0]).not.toHaveProperty("first_name");
    expect(unconditional[0]).not.toHaveProperty("last_name");
    // Still refreshed every sign-in.
    expect(unconditional[0]).toMatchObject({ email: signIn.email, display_name: "Provider Name" });
  });

  it("a new user is still created with the provider name", async () => {
    row = null;
    let inserted: Row | null = null;
    mockSupabaseClient.from.mockImplementation(() => {
      const b = makeBuilder();
      (b as any).insert = (p: Row) => {
        inserted = p;
        row = { ...p };
        return b;
      };
      (b as any).eq = (col: string, val: unknown) => {
        // Lookups miss; the insert's .select().single() returns the new row.
        (b as any).__id = col === "id" ? val : (b as any).__id;
        return b;
      };
      (b as any).single = async () =>
        inserted && row ? { data: { ...row }, error: null } : { data: null, error: { code: "PGRST116" } };
      return b;
    });
    const result = await service.syncUser(signIn);
    expect(inserted).toMatchObject({ first_name: "Provider", last_name: "Name" });
    expect(result.first_name).toBe("Provider");
    mockSupabaseClient.from.mockImplementation(() => makeBuilder());
  });
});
