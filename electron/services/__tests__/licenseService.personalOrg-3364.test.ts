/**
 * @jest-environment node
 */

/**
 * BACKLOG-3364 — provisioning the personal organization a solo user's plan
 * is recorded against.
 *
 * Two things this suite holds that nothing else does.
 *
 * **The write is not attempted unless we positively know it is owed.** The
 * database function short-circuits on an existing membership anyway, so the
 * skip is not what makes the operation safe — but it is what keeps every
 * brokerage member's launch from carrying a pointless round trip, and it is
 * what keeps `none` and `error` load-bearing OUTSIDE the outcome method's own
 * suite. An `error` from the membership lookup means "I could not find out",
 * which is not "they have none": collapsing the two here would make this the
 * one place in the desktop that writes on the strength of a failed read.
 *
 * **It never throws.** Sign-in and licence validation both await it. A user who
 * cannot be given a personal organization must be left exactly as they were
 * before personal organizations existed, not blocked at the door.
 */

import {
  createPostgrestEmulator,
  FIXTURE_USER_ID,
  type Emulator,
} from "./helpers/postgrestEmulator";

let emulator: Emulator;

/** Survives `jest.resetModules()`, so the assertions below see real calls. */
const mockCaptureException = jest.fn();
jest.mock("@sentry/electron/main", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
  setTag: jest.fn(),
  addBreadcrumb: jest.fn(),
  withScope: jest.fn(),
}));

const mockGetOutcome = jest.fn();
jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: {
    getActiveOrganizationMembershipOutcome: (...args: unknown[]) =>
      mockGetOutcome(...args),
    getClient: () => ({
      from: (table: string) => emulator.from(table),
      rpc: (fn: string, args?: unknown) => emulator.rpc(fn, args),
    }),
  },
}));

const mockInvalidateCache = jest.fn();
jest.mock("../featureGateService", () => ({
  __esModule: true,
  default: {
    invalidateCache: (...args: unknown[]) => mockInvalidateCache(...args),
    checkFeature: jest.fn(),
    getAllFeatures: jest.fn(),
  },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ensurePersonalOrganization } from "../licenseService";

const ensureCalls = (): number =>
  emulator.state.rpcs.filter((c) => c.fn === "ensure_personal_organization").length;

describe("BACKLOG-3364 — ensurePersonalOrganization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emulator = createPostgrestEmulator();
  });

  // -------------------------------------------------------------------------
  // When it does NOT write
  // -------------------------------------------------------------------------

  it("does not call the function for a user who already has a brokerage membership", async () => {
    mockGetOutcome.mockResolvedValue({
      status: "member",
      organization_id: "org-brokerage",
      is_personal: false,
    });

    const result = await ensurePersonalOrganization(FIXTURE_USER_ID);

    expect(ensureCalls()).toBe(0);
    expect(result).toEqual({ called: false, reason: "has_membership" });
  });

  it("does not call the function for a user who already has a personal organization", async () => {
    mockGetOutcome.mockResolvedValue({
      status: "member",
      organization_id: "org-personal",
      is_personal: true,
    });

    const result = await ensurePersonalOrganization(FIXTURE_USER_ID);

    expect(ensureCalls()).toBe(0);
    expect(result).toEqual({ called: false, reason: "has_membership" });
  });

  it("does not call the function when the membership lookup ERRORED", async () => {
    // The distinction that makes `none` vs `error` load-bearing outside the
    // outcome method. Collapsing them makes this write on a failed read.
    mockGetOutcome.mockResolvedValue({ status: "error" });

    const result = await ensurePersonalOrganization(FIXTURE_USER_ID);

    expect(ensureCalls()).toBe(0);
    expect(result).toEqual({ called: false, reason: "membership_unknown" });
  });

  // -------------------------------------------------------------------------
  // When it does
  // -------------------------------------------------------------------------

  it("calls the function, with no arguments, for a user in no organization", async () => {
    mockGetOutcome.mockResolvedValue({ status: "none" });

    const result = await ensurePersonalOrganization(FIXTURE_USER_ID);

    expect(ensureCalls()).toBe(1);
    // The remote function takes no arguments and resolves the caller from the
    // session, so it can never be aimed at another account.
    expect(emulator.state.rpcs[0]).toEqual({
      fn: "ensure_personal_organization",
      args: undefined,
    });
    expect(result).toEqual({ called: true, status: "created" });
  });

  it("drops the feature-gate cache when an organization was created", async () => {
    // The cache was populated while this user had no organization at all, so
    // every feature answer in it predates the plan they now have.
    mockGetOutcome.mockResolvedValue({ status: "none" });

    await ensurePersonalOrganization(FIXTURE_USER_ID);

    expect(mockInvalidateCache).toHaveBeenCalledTimes(1);
  });

  it("does not drop the cache when the organization already existed", async () => {
    mockGetOutcome.mockResolvedValue({ status: "none" });
    await ensurePersonalOrganization(FIXTURE_USER_ID); // created
    mockInvalidateCache.mockClear();

    const result = await ensurePersonalOrganization(FIXTURE_USER_ID); // exists

    expect(result).toEqual({ called: true, status: "exists" });
    expect(mockInvalidateCache).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Failure is survivable
  // -------------------------------------------------------------------------

  it("does not report a database that simply has not had the migration applied", async () => {
    // PGRST202 verbatim from PR 1's pre-migration capture. A build running
    // ahead of the migration is an expected state, not an incident — reporting
    // it would fill Sentry with one event per launch per user.
    emulator.set({ columnPresent: false });
    mockGetOutcome.mockResolvedValue({ status: "none" });

    const result = await ensurePersonalOrganization(FIXTURE_USER_ID);

    expect(result).toEqual({ called: true, status: "rpc_error" });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockInvalidateCache).not.toHaveBeenCalled();
  });

  it("reports any OTHER function error", async () => {
    mockGetOutcome.mockResolvedValue({ status: "none" });
    emulator.rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: "42501", message: "permission denied for function", details: null, hint: null },
      status: 403,
    });

    const result = await ensurePersonalOrganization(FIXTURE_USER_ID);

    expect(result).toEqual({ called: true, status: "rpc_error" });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { service: "license-service", operation: "ensurePersonalOrganization" },
    });
  });

  it("never throws when the client throws", async () => {
    mockGetOutcome.mockRejectedValue(new Error("client exploded"));

    await expect(ensurePersonalOrganization(FIXTURE_USER_ID)).resolves.toEqual({
      called: false,
      reason: "membership_unknown",
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("never throws when the function returns an unreadable body", async () => {
    mockGetOutcome.mockResolvedValue({ status: "none" });
    emulator.rpc = jest.fn().mockResolvedValue({ data: null, error: null, status: 200 });

    await expect(ensurePersonalOrganization(FIXTURE_USER_ID)).resolves.toEqual({
      called: true,
      status: "unknown",
    });
    expect(mockInvalidateCache).not.toHaveBeenCalled();
  });
});
