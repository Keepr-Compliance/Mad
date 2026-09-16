/**
 * @jest-environment node
 */

/**
 * BACKLOG-3388 — the auth cache must follow the signed-in user.
 *
 * `supabaseService` keeps a private `authSession` cache, and `getAuthSession()`
 * returns it on a fast path without re-validating it. Sixteen call sites read
 * that cache to decide WHICH USER they are acting for. If it drifts away from
 * the account the SDK is signed in as, those callers ask the database about one
 * identity while presenting another identity's JWT — which RLS answers with
 * zero rows and no error.
 *
 * That is what happened in production: a sign-out and a sign-in as a second
 * account inside one running process left the cache holding the first
 * account's id, and submit reported "User is not a member of any organization".
 *
 * WHY THESE TESTS DRIVE THE REAL SDK
 * ----------------------------------
 * The whole defect lives in WHICH EVENT the SDK emits on a login. A hand-written
 * fake would let us assert against an event sequence we invented, and the repo
 * has been burned by exactly that (fixtures describing states the producer
 * cannot emit). So these tests construct a real `GoTrueClient` from the shipped
 * `@supabase/auth-js` and give it a fake HTTP layer instead of a fake SDK. The
 * events are produced by the library, not by us:
 *
 *   - `setSession()` with an unexpired token  -> SIGNED_IN      (GoTrueClient.js:3018)
 *   - `refreshSession()`                      -> TOKEN_REFRESHED (GoTrueClient.js:4183)
 *   - `signOut()`                             -> SIGNED_OUT     (GoTrueClient.js:4335)
 *
 * The production login path is `client.auth.setSession(...)` — `main.ts` on the
 * deep-link callback, `sessionHandlers.ts` on restore — so the first of those
 * is the event a login really delivers.
 */

import { GoTrueClient } from "@supabase/auth-js";

// Two accounts. Deliberately NOT uuids: this is a public repo and the real ids
// belong in the backlog item, not in a fixture.
const USER_A = "user-alpha-3388";
const USER_B = "user-bravo-3388";

const AUTH_URL = "https://test.supabase.co/auth/v1";

/** base64url, no padding — what `decodeJWT` requires (helpers.js `decodeJWT`). */
const b64url = (value: string): string =>
  Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/**
 * A structurally valid, unexpired JWT for `userId`.
 *
 * The expiry matters: `_setSession` only takes the SIGNED_IN branch when the
 * token has NOT expired (`GoTrueClient.js` `_setSession`, `hasExpired` check).
 * An expired one would be refreshed instead and emit TOKEN_REFRESHED — the
 * event the shipped code already handled, i.e. not the bug.
 */
let jwtCounter = 0;
const jwtFor = (userId: string, secondsFromNow = 3600): string => {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  // `jti` only exists so two tokens minted in the same second are different
  // strings. Without it a "rotated" token is byte-identical to the original and
  // the rotation assertion below cannot distinguish pass from fail.
  jwtCounter += 1;
  return [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify({ sub: userId, exp, aud: "authenticated", jti: `t${jwtCounter}` })),
    b64url("signature"),
  ].join(".");
};

const refreshTokenFor = (userId: string): string => `refresh-token-for-${userId}`;

/** Tracks which access token the SDK presented, so tests can assert rotation. */
let issuedAccessTokens: Record<string, string> = {};

/**
 * The fake HTTP layer. It answers the three GoTrue endpoints the SDK calls on
 * these paths and nothing else — an unexpected URL fails the test loudly rather
 * than returning a plausible blank.
 */
const fakeFetch = jest.fn(async (input: unknown, init: Record<string, unknown> = {}) => {
  const url = String(input);
  const headers = (init.headers ?? {}) as Record<string, string>;

  // GET /user — GoTrue resolves the bearer token to its owner. We do the same:
  // the user id comes from the token's `sub`, so presenting B's token can only
  // ever produce B.
  if (url.startsWith(`${AUTH_URL}/user`)) {
    const bearer = (headers.Authorization ?? "").replace(/^Bearer\s+/, "");
    const payload = JSON.parse(
      Buffer.from(bearer.split(".")[1], "base64").toString("utf8"),
    ) as { sub: string };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: payload.sub, aud: "authenticated", role: "authenticated" }),
    };
  }

  // POST /token?grant_type=refresh_token — a rotation. Issues a NEW access
  // token for the owner of the refresh token.
  if (url.startsWith(`${AUTH_URL}/token`)) {
    const body = JSON.parse(String(init.body ?? "{}")) as { refresh_token?: string };
    const userId = String(body.refresh_token ?? "").replace("refresh-token-for-", "");
    const rotated = jwtFor(userId);
    issuedAccessTokens[userId] = rotated;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: rotated,
        refresh_token: refreshTokenFor(userId),
        token_type: "bearer",
        expires_in: 3600,
        user: { id: userId, aud: "authenticated", role: "authenticated" },
      }),
    };
  }

  // POST /logout — 204, and the SDK reads no body from it (noResolveJson).
  if (url.startsWith(`${AUTH_URL}/logout`)) {
    return { ok: true, status: 204, json: async () => ({}) };
  }

  throw new Error(`fakeFetch: unexpected request to ${url}`);
});

let goTrue: GoTrueClient;

const mockUpdateSession = jest.fn((..._args: unknown[]) => Promise.resolve(true));

jest.mock("@supabase/supabase-js", () => ({
  createClient: (
    _url: string,
    _key: string,
    options: { auth?: { storage?: unknown } } = {},
  ) => {
    // A real GoTrueClient, wired to the same in-memory storage adapter the
    // service hands the SDK, with the fake HTTP layer in place of the network.
    goTrue = new GoTrueClient({
      url: "https://test.supabase.co/auth/v1",
      // Off in tests only: the real client sets it true, but a live refresh
      // timer would outlive the test and keep the worker alive.
      autoRefreshToken: false,
      persistSession: false,
      storage: options.auth?.storage as never,
      fetch: fakeFetch as never,
    });
    return {
      auth: goTrue,
      from: jest.fn(),
      rpc: jest.fn(),
      functions: { invoke: jest.fn() },
    };
  },
}));

jest.mock("dotenv", () => ({ config: jest.fn() }));

jest.mock("../sessionService", () => ({
  __esModule: true,
  default: { updateSession: (...args: unknown[]) => mockUpdateSession(...args) },
}));

process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_ANON_KEY = "test-anon-key";

describe("BACKLOG-3388: auth cache follows the signed-in user", () => {
  let supabaseService: typeof import("../supabaseService").default;

  /** Signs in through the real `setSession` path a login uses. */
  const signIn = async (userId: string): Promise<void> => {
    const accessToken = jwtFor(userId);
    issuedAccessTokens[userId] = accessToken;
    const { error } = await goTrue.setSession({
      access_token: accessToken,
      refresh_token: refreshTokenFor(userId),
    });
    if (error) throw error;
  };

  const cachedUserId = (): string | null =>
    (supabaseService as unknown as { authSession: { userId: string } | null })
      .authSession?.userId ?? null;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();
    issuedAccessTokens = {};

    const module = await import("../supabaseService");
    supabaseService = module.default;

    const internals = supabaseService as unknown as {
      initialized: boolean;
      client: unknown;
      authSubscription: unknown;
      authSession: unknown;
    };
    internals.initialized = false;
    internals.client = null;
    internals.authSubscription = null;
    internals.authSession = null;

    supabaseService.initialize();
  });

  afterEach(() => {
    supabaseService.destroy();
  });

  /**
   * THE LOAD-BEARING CONTROL.
   *
   * This is the production sequence, with nothing added: one process, one
   * client, the cache pinned to A by the hourly rotation that ran for two days,
   * then a login as B. No restart, and — this part is faithful, not convenient —
   * no SDK sign-out in between. The production log shows `SIGNED_OUT` was never
   * emitted (the app's logout path never reached `client.auth.signOut()`), and
   * that absence is exactly what left the stale value in place to be read.
   *
   * Deleting the SIGNED_IN handling must turn this red.
   */
  it("keeps the cache on the new user after an in-process account switch", async () => {
    await signIn(USER_A);
    // The hourly rotation that pinned the cache to A in production.
    const { error: refreshError } = await goTrue.refreshSession();
    expect(refreshError).toBeNull();
    expect(cachedUserId()).toBe(USER_A);

    // The login. `setSession` with an unexpired token emits SIGNED_IN.
    await signIn(USER_B);

    // ...and the login must NOT write back to session.json.
    //
    // The listener mirrors every session-carrying event into the in-memory
    // cache, but persists to session.json on TOKEN_REFRESHED alone. That is a
    // deliberate choice and this is the control for it: `updateSession` MERGES
    // into the record already on disk — `sessionService.ts:449-453` builds
    // `{ ...currentSession, ...updates, savedAt: Date.now() }` over whatever
    // `loadSession()` returned, and `updates` here carries only
    // `supabaseTokens`. So a write-back on a login would stamp B's tokens into
    // a record whose `user` block is still A's — manufacturing the
    // mismatched session file the whole item is about, one layer up. The other
    // session-carrying events are not rotations: their tokens came from the
    // caller that already owns persisting them (main.ts / sessionHandlers.ts).
    //
    // Exactly one call, and it is the ROTATION's tokens — A's, post-rotation.
    // Count alone would not be enough: it can stay at 1 for an innocuous
    // reason while the one call is the dangerous one, so the identity of the
    // persisted pair is asserted too.
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
    expect(mockUpdateSession).toHaveBeenCalledWith({
      supabaseTokens: {
        access_token: issuedAccessTokens[USER_A],
        refresh_token: refreshTokenFor(USER_A),
      },
    });
    expect(mockUpdateSession).not.toHaveBeenCalledWith({
      supabaseTokens: {
        access_token: issuedAccessTokens[USER_B],
        refresh_token: refreshTokenFor(USER_B),
      },
    });

    // The synchronous reader (sessionHandlers, syncHandlers) — no SDK fallback,
    // so it sees the cache and nothing else.
    expect(supabaseService.getAuthUserId()).toBe(USER_B);

    // The async reader that the submit path uses. Its fast path returns the
    // cache unconditionally, so a stale cache is returned verbatim.
    const session = await supabaseService.getAuthSession();
    expect(session?.userId).toBe(USER_B);
    // ...and the tokens must move together with the id. Handing out B's id with
    // A's access token would be a different, quieter version of the same bug.
    expect(session?.accessToken).toBe(issuedAccessTokens[USER_B]);
  });

  /**
   * The same switch with an explicit SDK sign-out in the middle — the sequence
   * as a user describes it ("I logged out and logged in as someone else").
   *
   * Note what discriminates here: SIGNED_OUT already cleared the cache, so the
   * stale-id assertion cannot fail. What fails without the fix is that the cache
   * is never REPOPULATED — `getAuthUserId()` returns null, and every caller that
   * has no SDK fallback behaves as if nobody is signed in.
   */
  it("repopulates the cache after a sign-out and a sign-in as another user", async () => {
    await signIn(USER_A);
    await goTrue.refreshSession();
    expect(cachedUserId()).toBe(USER_A);

    const { error: signOutError } = await goTrue.signOut();
    expect(signOutError).toBeNull();
    expect(cachedUserId()).toBeNull();

    await signIn(USER_B);

    expect(supabaseService.getAuthUserId()).toBe(USER_B);
    expect((await supabaseService.getAuthSession())?.userId).toBe(USER_B);
  });

  /**
   * Sign-out clears the cache.
   *
   * Driven through `client.auth.signOut()`, NOT `supabaseService.signOut()`.
   * The service method nulls the cache itself, which would make this test pass
   * with the listener's SIGNED_OUT branch deleted. Going through the SDK leaves
   * the listener as the only thing that can clear it — and it matches
   * `signOutGlobal()`, which never touches the cache directly.
   */
  it("clears the cache when the SDK signs out", async () => {
    await signIn(USER_A);
    await goTrue.refreshSession();
    expect(cachedUserId()).toBe(USER_A);

    await goTrue.signOut();

    expect(supabaseService.getAuthUserId()).toBeNull();
    expect(cachedUserId()).toBeNull();
  });

  /**
   * The behaviour that already existed must survive: a rotation still updates
   * the cached tokens, and still persists them to session.json (BACKLOG-2332).
   * A "mirror every event" rewrite that dropped either would trade this bug for
   * a forced re-login an hour after every restart.
   */
  it("still updates the cache and persists tokens on a token refresh", async () => {
    await signIn(USER_A);
    const originalAccessToken = issuedAccessTokens[USER_A];

    await goTrue.refreshSession();

    const rotated = issuedAccessTokens[USER_A];
    expect(rotated).not.toBe(originalAccessToken);

    const session = await supabaseService.getAuthSession();
    expect(session?.userId).toBe(USER_A);
    expect(session?.accessToken).toBe(rotated);
    expect(session?.expiresAt).toBeInstanceOf(Date);

    expect(mockUpdateSession).toHaveBeenCalledWith({
      supabaseTokens: {
        access_token: rotated,
        refresh_token: refreshTokenFor(USER_A),
      },
    });
  });

  /**
   * The events are the SDK's, not ours. If a future upgrade stops emitting
   * SIGNED_IN from `setSession`, this test says so directly instead of leaving
   * the tests above to fail for a reason nobody can read.
   */
  it("observes SIGNED_IN from the shipped SDK on setSession with an unexpired token", async () => {
    const events: string[] = [];
    const { data } = goTrue.onAuthStateChange((event) => {
      events.push(event);
    });

    await signIn(USER_A);
    data.subscription.unsubscribe();

    expect(events).toContain("SIGNED_IN");
    expect(events).not.toContain("TOKEN_REFRESHED");
  });
});
