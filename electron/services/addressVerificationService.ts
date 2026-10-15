/**
 * Address Verification Service
 *
 * Address autocomplete, place details and geocoding. BACKLOG-3834: the app no
 * longer holds a Google key. Every lookup goes through the `maps-proxy` Edge
 * Function with the signed-in user's session token; the key lives only on the
 * server. Signed out, offline, rate limited or proxy down → lookups degrade
 * (no suggestions; details/geocode reject) and manual address entry still works.
 */

import logService from "./logService";
import supabaseService from "./supabaseService";

export const MAPS_PROXY_FUNCTION = "maps-proxy";
export const MAPS_PROXY_TIMEOUT_MS = 8000;

/** Thrown when the proxy cannot answer (signed out, offline, rate limited). */
export class AddressLookupUnavailableError extends Error {
  constructor(public readonly reason: string) {
    super(`Address lookup unavailable: ${reason}`);
    this.name = "AddressLookupUnavailableError";
  }
}

/**
 * Address suggestion from autocomplete
 */
export interface AddressSuggestion {
  place_id: string;
  formatted_address: string;
  main_text: string;
  secondary_text: string;
}

/**
 * Coordinates
 */
interface Coordinates {
  lat: number;
  lng: number;
}

/**
 * Detailed address information
 */
export interface AddressDetails {
  formatted_address: string;
  street_number?: string;
  route?: string;
  street: string;
  city?: string;
  state?: string;
  state_short?: string;
  zip?: string;
  country?: string;
  coordinates: Coordinates;
  place_id: string;
}

/**
 * Google address component
 */
interface GoogleAddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

/**
 * Parsed address components
 */
interface ParsedAddressComponents {
  street_number?: string;
  route?: string;
  locality?: string;
  administrative_area_level_1?: string;
  administrative_area_level_1_short?: string;
  administrative_area_level_2?: string;
  postal_code?: string;
  country?: string;
  country_short?: string;
}

/** Trimmed Google result as returned by the proxy for details/geocode. */
interface ProxyPlaceResult {
  formatted_address?: string;
  address_components?: GoogleAddressComponent[];
  geometry?: { location?: { lat?: number; lng?: number } | null };
  place_id?: string;
}

interface ProxyPrediction {
  place_id?: string;
  description?: string;
  structured_formatting?: { main_text?: string; secondary_text?: string };
}

interface ProxyResponse {
  status?: string;
  predictions?: ProxyPrediction[];
  result?: ProxyPlaceResult | null;
  results?: ProxyPlaceResult[];
}

type ProxyBody =
  | { op: "autocomplete"; input: string; sessiontoken?: string }
  | { op: "details"; place_id: string; sessiontoken?: string }
  | { op: "geocode"; address: string };

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AddressLookupUnavailableError("timeout")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** HTTP status carried by a supabase-js FunctionsHttpError, if any. */
function httpStatusOf(error: unknown): number | null {
  const ctx = (error as { context?: { status?: unknown } } | null)?.context;
  return typeof ctx?.status === "number" ? ctx.status : null;
}

class AddressVerificationService {
  /**
   * Kept for the `address:initialize` IPC contract. There is no key to load any
   * more; lookups need only a signed-in Supabase session, checked per call.
   */
  initialize(): boolean {
    logService.debug("[AddressVerification] Using maps-proxy", "AddressVerification");
    return true;
  }

  /**
   * Call the maps-proxy Edge Function as the signed-in user.
   * @throws AddressLookupUnavailableError when signed out, offline, rate
   *         limited, or the proxy fails. Never logs the address text.
   */
  private async callProxy(body: ProxyBody): Promise<ProxyResponse> {
    let client;
    try {
      client = supabaseService.getClient();
    } catch {
      throw new AddressLookupUnavailableError("not_configured");
    }

    let hasSession = false;
    try {
      const { data } = await client.auth.getSession();
      hasSession = !!data?.session?.access_token;
    } catch {
      hasSession = false;
    }
    if (!hasSession) {
      throw new AddressLookupUnavailableError("signed_out");
    }

    let result: { data: unknown; error: unknown };
    try {
      result = await withTimeout(
        client.functions.invoke(MAPS_PROXY_FUNCTION, { body }),
        MAPS_PROXY_TIMEOUT_MS,
      );
    } catch (error) {
      const reason = error instanceof AddressLookupUnavailableError ? error.reason : "network";
      logService.info("[AddressVerification] Proxy unavailable", "AddressVerification", { op: body.op, reason });
      throw new AddressLookupUnavailableError(reason);
    }

    if (result.error) {
      const status = httpStatusOf(result.error);
      const reason =
        status === 401 ? "signed_out" : status === 429 ? "rate_limited" : status ? `http_${status}` : "network";
      logService.info("[AddressVerification] Proxy unavailable", "AddressVerification", { op: body.op, reason });
      throw new AddressLookupUnavailableError(reason);
    }

    return (result.data ?? {}) as ProxyResponse;
  }

  /**
   * Get address autocomplete suggestions
   * @param input - Partial address input
   * @param sessionToken - Session token for billing optimization
   * @returns Array of address suggestions; empty when lookups are unavailable
   */
  async getAddressSuggestions(
    input: string,
    sessionToken: string | null = null,
  ): Promise<AddressSuggestion[]> {
    if (!input || input.length < 3) {
      return [];
    }

    let data: ProxyResponse;
    try {
      data = await this.callProxy(
        sessionToken
          ? { op: "autocomplete", input, sessiontoken: sessionToken }
          : { op: "autocomplete", input },
      );
    } catch (error) {
      if (error instanceof AddressLookupUnavailableError) {
        // Degraded: no suggestions, the user keeps typing the address by hand.
        return [];
      }
      throw error;
    }

    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      logService.error("[AddressVerification] API error:", "AddressVerification", { status: data.status });
      throw new Error(`Google Places API error: ${data.status}`);
    }

    const suggestions = (data.predictions || []).map((prediction) => ({
      place_id: prediction.place_id || "",
      formatted_address: prediction.description || "",
      main_text: prediction.structured_formatting?.main_text || "",
      secondary_text: prediction.structured_formatting?.secondary_text || "",
    }));

    logService.debug(
      `[AddressVerification] Found ${suggestions.length} suggestions`,
      "AddressVerification",
    );

    return suggestions;
  }

  /**
   * Get detailed address information for a place ID
   * @param placeId - Google Place ID
   * @returns Detailed address object
   * @throws AddressLookupUnavailableError when lookups are unavailable
   */
  async getAddressDetails(placeId: string): Promise<AddressDetails> {
    const data = await this.callProxy({ op: "details", place_id: placeId });

    if (data.status !== "OK" || !data.result) {
      logService.error("[AddressVerification] API error:", "AddressVerification", { status: data.status });
      throw new Error(`Google Places API error: ${data.status}`);
    }

    return this._toAddressDetails(data.result, placeId);
  }

  /**
   * Geocode an address string to coordinates
   * @param address - Full address string
   * @returns Geocoded address with coordinates
   * @throws AddressLookupUnavailableError when lookups are unavailable
   */
  async geocodeAddress(address: string): Promise<AddressDetails> {
    const data = await this.callProxy({ op: "geocode", address });

    const result = data.results?.[0];
    if (data.status !== "OK" || !result) {
      logService.error("[AddressVerification] Geocoding error:", "AddressVerification", { status: data.status });
      throw new Error(`Geocoding failed: ${data.status}`);
    }

    return this._toAddressDetails(result, result.place_id || "");
  }

  /**
   * Validate if an address exists and is complete
   * @param address - Address string to validate
   * @returns True if address is valid
   */
  async validateAddress(address: string): Promise<boolean> {
    try {
      const result = await this.geocodeAddress(address);
      return !!(result.street && result.city && result.state && result.zip);
    } catch {
      return false;
    }
  }

  private _toAddressDetails(result: ProxyPlaceResult, placeId: string): AddressDetails {
    const addressComponents = this._parseAddressComponents(result.address_components || []);
    return {
      formatted_address: result.formatted_address || "",
      street_number: addressComponents.street_number,
      route: addressComponents.route,
      street:
        `${addressComponents.street_number || ""} ${addressComponents.route || ""}`.trim(),
      city:
        addressComponents.locality ||
        addressComponents.administrative_area_level_2,
      state: addressComponents.administrative_area_level_1,
      state_short: addressComponents.administrative_area_level_1_short,
      zip: addressComponents.postal_code,
      country: addressComponents.country,
      coordinates: {
        lat: result.geometry?.location?.lat as number,
        lng: result.geometry?.location?.lng as number,
      },
      place_id: placeId,
    };
  }

  /**
   * Parse Google address components into usable format
   * @private
   */
  private _parseAddressComponents(
    components: GoogleAddressComponent[],
  ): ParsedAddressComponents {
    const parsed: ParsedAddressComponents = {};

    components.forEach((component) => {
      const types = component.types;

      if (types.includes("street_number")) {
        parsed.street_number = component.long_name;
      }
      if (types.includes("route")) {
        parsed.route = component.long_name;
      }
      if (types.includes("locality")) {
        parsed.locality = component.long_name;
      }
      if (types.includes("administrative_area_level_1")) {
        parsed.administrative_area_level_1 = component.long_name;
        parsed.administrative_area_level_1_short = component.short_name;
      }
      if (types.includes("administrative_area_level_2")) {
        parsed.administrative_area_level_2 = component.long_name;
      }
      if (types.includes("postal_code")) {
        parsed.postal_code = component.long_name;
      }
      if (types.includes("country")) {
        parsed.country = component.long_name;
        parsed.country_short = component.short_name;
      }
    });

    return parsed;
  }
}

// Export singleton instance
export default new AddressVerificationService();
