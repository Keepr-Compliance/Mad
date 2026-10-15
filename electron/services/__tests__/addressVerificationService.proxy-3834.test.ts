/**
 * @jest-environment node
 *
 * BACKLOG-3834: address lookups go through the maps-proxy Edge Function with
 * the user's session; the app holds no Google key. Signed out, offline, rate
 * limited → degraded (no suggestions), never a crash.
 */

const mockInvoke = jest.fn();
const mockGetSession = jest.fn();
const mockGetClient = jest.fn();

jest.mock("../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => mockGetClient() },
}));
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import addressVerificationService, {
  AddressLookupUnavailableError,
  MAPS_PROXY_FUNCTION,
} from "../addressVerificationService";
import logService from "../logService";

const SESSION = { data: { session: { access_token: "user-at" } }, error: null };

function httpError(status: number) {
  return { name: "FunctionsHttpError", message: "non-2xx", context: { status } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetClient.mockReturnValue({ auth: { getSession: mockGetSession }, functions: { invoke: mockInvoke } });
  mockGetSession.mockResolvedValue(SESSION);
});

describe("addressVerificationService via maps-proxy", () => {
  it("P1 sends autocomplete to maps-proxy with only op/input/sessiontoken", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        status: "OK",
        predictions: [
          {
            place_id: "ChIJabcdefghij",
            description: "1 Main St, Springfield, IL, USA",
            structured_formatting: { main_text: "1 Main St", secondary_text: "Springfield, IL, USA" },
          },
        ],
      },
      error: null,
    });

    const out = await addressVerificationService.getAddressSuggestions("1 Main", "session_1");

    expect(mockInvoke).toHaveBeenCalledWith(MAPS_PROXY_FUNCTION, {
      body: { op: "autocomplete", input: "1 Main", sessiontoken: "session_1" },
    });
    expect(out).toEqual([
      {
        place_id: "ChIJabcdefghij",
        formatted_address: "1 Main St, Springfield, IL, USA",
        main_text: "1 Main St",
        secondary_text: "Springfield, IL, USA",
      },
    ]);
  });

  it("P2 parses details from the trimmed proxy result", async () => {
    mockInvoke.mockResolvedValue({
      data: {
        status: "OK",
        result: {
          formatted_address: "1 Main St, Springfield, IL 62701, USA",
          address_components: [
            { long_name: "1", short_name: "1", types: ["street_number"] },
            { long_name: "Main Street", short_name: "Main St", types: ["route"] },
            { long_name: "Springfield", short_name: "Springfield", types: ["locality"] },
            { long_name: "Illinois", short_name: "IL", types: ["administrative_area_level_1"] },
            { long_name: "62701", short_name: "62701", types: ["postal_code"] },
          ],
          geometry: { location: { lat: 39.8, lng: -89.6 } },
        },
      },
      error: null,
    });

    const d = await addressVerificationService.getAddressDetails("ChIJabcdefghij");

    expect(mockInvoke).toHaveBeenCalledWith(MAPS_PROXY_FUNCTION, {
      body: { op: "details", place_id: "ChIJabcdefghij" },
    });
    expect(d).toMatchObject({
      street: "1 Main Street",
      city: "Springfield",
      state_short: "IL",
      zip: "62701",
      coordinates: { lat: 39.8, lng: -89.6 },
      place_id: "ChIJabcdefghij",
    });
  });

  it("P3 signed out: no proxy call, no suggestions", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(addressVerificationService.getAddressSuggestions("1 Main")).resolves.toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("P4 Supabase not configured: no suggestions", async () => {
    mockGetClient.mockImplementation(() => {
      throw new Error("Supabase client is not initialized");
    });
    await expect(addressVerificationService.getAddressSuggestions("1 Main")).resolves.toEqual([]);
  });

  it.each([
    ["rate limited", 429, "rate_limited"],
    ["token rejected", 401, "signed_out"],
    ["proxy down", 503, "http_503"],
  ])("P5 %s: no suggestions; details reject with the reason", async (_n, status, reason) => {
    mockInvoke.mockResolvedValue({ data: null, error: httpError(status) });
    await expect(addressVerificationService.getAddressSuggestions("1 Main")).resolves.toEqual([]);
    await expect(addressVerificationService.getAddressDetails("ChIJabcdefghij")).rejects.toMatchObject({
      name: "AddressLookupUnavailableError",
      reason,
    });
  });

  it("P6 offline (invoke rejects): no suggestions; validate is false", async () => {
    mockInvoke.mockRejectedValue(new TypeError("fetch failed"));
    await expect(addressVerificationService.getAddressSuggestions("1 Main")).resolves.toEqual([]);
    await expect(addressVerificationService.validateAddress("1 Main St")).resolves.toBe(false);
  });

  it("P7 timeout: rejects as unavailable", async () => {
    jest.useFakeTimers();
    try {
      mockInvoke.mockReturnValue(new Promise(() => {}));
      const p = addressVerificationService.getAddressDetails("ChIJabcdefghij");
      const assertion = expect(p).rejects.toBeInstanceOf(AddressLookupUnavailableError);
      await jest.advanceTimersByTimeAsync(9000);
      await assertion;
    } finally {
      jest.useRealTimers();
    }
  });

  it("P8 never logs the address text", async () => {
    mockInvoke.mockResolvedValue({ data: null, error: httpError(429) });
    await addressVerificationService.getAddressSuggestions("742 Evergreen Terrace");
    const logged = JSON.stringify([
      (logService.info as jest.Mock).mock.calls,
      (logService.debug as jest.Mock).mock.calls,
      (logService.warn as jest.Mock).mock.calls,
      (logService.error as jest.Mock).mock.calls,
    ]);
    expect(logged).not.toContain("Evergreen");
  });

  it("P9 initialize needs no key", () => {
    expect(addressVerificationService.initialize()).toBe(true);
  });
});
