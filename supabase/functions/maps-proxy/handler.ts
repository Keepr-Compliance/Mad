/**
 * Request handler for the maps-proxy Edge Function (BACKLOG-3834).
 *
 * The desktop app used to call Google Maps directly with a key shipped inside
 * the app. It now calls this function with the signed-in user's access token;
 * the Google key lives only in this function's server-side secret.
 *
 * Pure TypeScript with no Deno-specific imports, so it can be unit tested with
 * Jest (tests/edge-functions/mapsProxy.test.ts). `index.ts` wires it to
 * `Deno.serve` with the real environment, `fetch` and rate limiter.
 *
 * Request: POST, JSON body, one of
 *   { op: "autocomplete", input: string, sessiontoken?: string }
 *   { op: "details", place_id: string, sessiontoken?: string }
 *   { op: "geocode", address: string }
 * Any other op, or any other key in the body, is rejected with 400. Every
 * Google parameter other than the user's text (key, types, components,
 * fields) is fixed here, never taken from the client.
 *
 * Responses:
 *   200 { status, predictions | result | results }  trimmed Google payload
 *   400 { error: "bad_request" }
 *   401 { error: "unauthenticated" }   no user behind the token (incl. anon key)
 *   405 { error: "method_not_allowed" }
 *   429 { error: "rate_limited" }      + Retry-After
 *   502 { error: "upstream_unavailable" }
 *   503 { error: "unavailable" }       function not configured
 *
 * Never logs the user's address text.
 */

export const GOOGLE_MAPS_BASE = "https://maps.googleapis.com/maps/api";

/** Server-only secret holding the Google Maps key. */
export const MAPS_KEY_SECRET = "GOOGLE_MAPS_SERVER_KEY";

/**
 * Per-user limits. Autocomplete fires once per keystroke in the desktop form,
 * so a single address can cost ~30 calls; the minute cap leaves room for that.
 * The limiter is in-memory (best effort per isolate); the hard ceiling is the
 * per-API quota set on the key in Google Cloud.
 */
export const RATE_LIMITS = [
  { name: "minute", max: 120, windowMs: 60 * 1000 },
  { name: "day", max: 2000, windowMs: 24 * 60 * 60 * 1000 },
] as const;

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

export interface HandlerDeps {
  /** Reads an environment variable (Deno.env.get in production). */
  getEnv: (name: string) => string | undefined;
  /** fetch implementation (global fetch in production). */
  fetch: typeof fetch;
  /** Rate limiter (supabase/functions/_shared/rateLimiter.ts in production). */
  checkRateLimit: (key: string, max: number, windowMs: number) => RateLimitResult;
}

type Op = "autocomplete" | "details" | "geocode";

/** The ONLY body keys accepted for each op. */
export const ALLOWED_KEYS: Record<Op, readonly string[]> = {
  autocomplete: ["op", "input", "sessiontoken"],
  details: ["op", "place_id", "sessiontoken"],
  geocode: ["op", "address"],
};

const SESSION_TOKEN_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;

interface ValidRequest {
  op: Op;
  url: string;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

function isText(v: unknown, min: number, max: number): v is string {
  return typeof v === "string" && v.trim().length >= min && v.length <= max;
}

/**
 * Validate the body against the allow-list and build the Google URL.
 * Returns null for anything not explicitly allowed.
 */
export function buildGoogleRequest(body: unknown, apiKey: string): ValidRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const op = b.op;
  if (op !== "autocomplete" && op !== "details" && op !== "geocode") return null;

  const allowed = ALLOWED_KEYS[op];
  for (const k of Object.keys(b)) {
    if (!allowed.includes(k)) return null;
  }
  if (b.sessiontoken !== undefined && !(typeof b.sessiontoken === "string" && SESSION_TOKEN_RE.test(b.sessiontoken))) {
    return null;
  }

  const params = new URLSearchParams();
  let path: string;
  if (op === "autocomplete") {
    if (!isText(b.input, 3, 200)) return null;
    path = "place/autocomplete/json";
    params.set("input", b.input);
    params.set("types", "address");
    params.set("components", "country:us");
    if (typeof b.sessiontoken === "string") params.set("sessiontoken", b.sessiontoken);
  } else if (op === "details") {
    if (!(typeof b.place_id === "string" && PLACE_ID_RE.test(b.place_id))) return null;
    path = "place/details/json";
    params.set("place_id", b.place_id);
    params.set("fields", "address_components,formatted_address,geometry");
    if (typeof b.sessiontoken === "string") params.set("sessiontoken", b.sessiontoken);
  } else {
    if (!isText(b.address, 5, 500)) return null;
    path = "geocode/json";
    params.set("address", b.address);
  }
  params.set("key", apiKey);
  return { op, url: `${GOOGLE_MAPS_BASE}/${path}?${params.toString()}` };
}

interface AddressComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

function trimComponents(v: unknown): AddressComponent[] {
  if (!Array.isArray(v)) return [];
  return v.map((c) => ({
    long_name: String(c?.long_name ?? ""),
    short_name: String(c?.short_name ?? ""),
    types: Array.isArray(c?.types) ? c.types.map(String) : [],
  }));
}

function trimLocation(v: unknown): { lat: number; lng: number } | null {
  const loc = (v as { location?: { lat?: unknown; lng?: unknown } } | undefined)?.location;
  if (typeof loc?.lat !== "number" || typeof loc?.lng !== "number") return null;
  return { lat: loc.lat, lng: loc.lng };
}

/** Pass through only the fields the desktop app reads. Never error_message. */
export function trimGoogleResponse(op: Op, data: unknown): Record<string, unknown> {
  const d = (data ?? {}) as Record<string, unknown>;
  const status = typeof d.status === "string" ? d.status : "UNKNOWN_ERROR";
  if (op === "autocomplete") {
    const preds = Array.isArray(d.predictions) ? d.predictions : [];
    return {
      status,
      predictions: preds.map((p: Record<string, unknown>) => {
        const sf = (p?.structured_formatting ?? {}) as Record<string, unknown>;
        return {
          place_id: String(p?.place_id ?? ""),
          description: String(p?.description ?? ""),
          structured_formatting: {
            main_text: String(sf.main_text ?? ""),
            secondary_text: String(sf.secondary_text ?? ""),
          },
        };
      }),
    };
  }
  if (op === "details") {
    const r = d.result as Record<string, unknown> | undefined;
    return {
      status,
      result: r
        ? {
            formatted_address: String(r.formatted_address ?? ""),
            address_components: trimComponents(r.address_components),
            geometry: { location: trimLocation(r.geometry) },
          }
        : null,
    };
  }
  const results = Array.isArray(d.results) ? d.results : [];
  const first = results[0] as Record<string, unknown> | undefined;
  return {
    status,
    results: first
      ? [
          {
            formatted_address: String(first.formatted_address ?? ""),
            address_components: trimComponents(first.address_components),
            geometry: { location: trimLocation(first.geometry) },
            place_id: String(first.place_id ?? ""),
          },
        ]
      : [],
  };
}

/**
 * Resolve the user id from the caller's access token. The gateway's JWT check
 * also accepts the anon key, so this is the real check: no user → null.
 */
export async function resolveUserId(
  authorization: string | null,
  deps: HandlerDeps,
): Promise<string | null> {
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return null;
  const supabaseUrl = deps.getEnv("SUPABASE_URL");
  const anonKey = deps.getEnv("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) return null;
  try {
    const res = await deps.fetch(`${supabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: anonKey, Authorization: authorization },
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { id?: unknown } | null;
    return typeof user?.id === "string" && user.id.length > 0 ? user.id : null;
  } catch {
    return null;
  }
}

export async function handleRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const apiKey = deps.getEnv(MAPS_KEY_SECRET);
  if (!apiKey || !deps.getEnv("SUPABASE_URL") || !deps.getEnv("SUPABASE_ANON_KEY")) {
    return json({ error: "unavailable" }, 503);
  }

  // ── Authenticate (fail closed) ─────────────────────────────────────────
  const userId = await resolveUserId(req.headers.get("Authorization"), deps);
  if (!userId) {
    return json({ error: "unauthenticated" }, 401);
  }

  // ── Per-user rate limit ────────────────────────────────────────────────
  for (const limit of RATE_LIMITS) {
    const r = deps.checkRateLimit(`maps-proxy:${limit.name}:${userId}`, limit.max, limit.windowMs);
    if (!r.allowed) {
      return json({ error: "rate_limited" }, 429, { "Retry-After": String(r.retryAfter ?? 60) });
    }
  }

  // ── Allow-list ─────────────────────────────────────────────────────────
  const body = await req.json().catch(() => null);
  const google = buildGoogleRequest(body, apiKey);
  if (!google) {
    return json({ error: "bad_request" }, 400);
  }

  // ── Call Google ────────────────────────────────────────────────────────
  try {
    const res = await deps.fetch(google.url, { method: "GET" });
    if (!res.ok) {
      console.warn(`[maps-proxy] upstream http ${res.status} op=${google.op}`);
      return json({ error: "upstream_unavailable" }, 502);
    }
    const data = await res.json();
    const trimmed = trimGoogleResponse(google.op, data);
    if (trimmed.status !== "OK" && trimmed.status !== "ZERO_RESULTS") {
      // Status only: Google's error_message can echo request details.
      console.warn(`[maps-proxy] upstream status ${String(trimmed.status)} op=${google.op}`);
    }
    return json(trimmed, 200);
  } catch {
    console.warn(`[maps-proxy] upstream fetch failed op=${google.op}`);
    return json({ error: "upstream_unavailable" }, 502);
  }
}
