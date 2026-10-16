/**
 * SCIM seat-limit refusals (BACKLOG-3851 PR-2c).
 *
 * The seat trigger raises `seat_limit_reached` (SQLSTATE P0001) when a SCIM write would
 * take a seat in a full brokerage. The handler answers 403 and this module emails the
 * brokerage's IT admins (fallback: admins, then brokers), at most once per brokerage per
 * 24 hours, through the broker portal's internal email route.
 *
 * No jsr imports: the database client and fetch are injected so the module runs under
 * jest as well as Deno.
 */

/** error_message written to scim_sync_log for every seat refusal (the de-dupe key). */
export const SEAT_LIMIT_ERROR = "seat_limit_reached";

/** SCIM 403 detail for a seat refusal. Neutral: it does not promise that a retry adds anyone. */
export const SEAT_LIMIT_DETAIL =
  "seat_limit_reached: every Keepr license in this brokerage is in use. Keepr did not add or re-activate this user. A Broker or Admin can free a license on the Users page in Keepr, or add seats through Keepr support.";

/** De-dupe window for the IT-admin email. */
export const SEAT_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The portal call never holds up the SCIM answer for longer than this. */
export const SEAT_EMAIL_TIMEOUT_MS = 3000;

/** Recipient roles, in order: the first role with at least one active member wins. */
export const SEAT_EMAIL_ROLE_ORDER = ["it_admin", "admin", "broker"] as const;

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

export interface SeatNotifyDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  getEnv: (key: string) => string | undefined;
  now?: () => number;
  timeoutMs?: number;
}

export function defaultSeatNotifyDeps(): SeatNotifyDeps {
  const g = globalThis as unknown as {
    Deno?: { env: { get(key: string): string | undefined } };
  };
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    getEnv: (key) => g.Deno?.env.get(key),
  };
}

/** True when a PostgREST error is the seat trigger's refusal. */
export function isSeatLimitError(
  err: { code?: string; message?: string } | null | undefined,
): boolean {
  return !!err && err.code === "P0001" &&
    String(err.message ?? "").includes(SEAT_LIMIT_ERROR);
}

/** Same rule as public.member_row_holds_seat(text, timestamptz, uuid). */
export function rowHoldsSeat(
  row: { license_status: string | null; invitation_expires_at: string | null; user_id: string | null },
  nowMs: number,
): boolean {
  if (row.license_status === "active") return true;
  if (row.license_status !== "pending") return false;
  if (row.user_id) return true;
  if (!row.invitation_expires_at) return true;
  return Date.parse(row.invitation_expires_at) >= nowMs;
}

export type SeatNotifyOutcome =
  | "sent"
  | "deduped"
  | "no_recipients"
  | "not_configured"
  | "failed";

export interface SeatNotifyParams {
  orgId: string;
  /** Name or email of the person who was not added / re-activated. */
  personLabel: string;
  kind: "add" | "reactivate";
  /** A refused re-activation: the person is a member and must not be emailed about themself. */
  excludeUserId?: string;
}

/**
 * Email the brokerage's IT admins that a SCIM write was refused for seats. Never throws;
 * the caller answers 403 whatever this returns. Call it BEFORE logging the current
 * refusal, so the de-dupe count sees only earlier refusals.
 */
export async function notifySeatLimitReached(
  db: Db,
  deps: SeatNotifyDeps,
  params: SeatNotifyParams,
): Promise<SeatNotifyOutcome> {
  try {
    const portalUrl = deps.getEnv("BROKER_PORTAL_URL");
    const apiSecret = deps.getEnv("INTERNAL_API_SECRET");
    if (!portalUrl || !apiSecret) {
      console.error("[scim] seat email skipped: BROKER_PORTAL_URL or INTERNAL_API_SECRET not set");
      return "not_configured";
    }
    const nowMs = deps.now ? deps.now() : Date.now();

    const { count: recent, error: recentError } = await db
      .from("scim_sync_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", params.orgId)
      .eq("response_status", 403)
      .eq("error_message", SEAT_LIMIT_ERROR)
      .gte("created_at", new Date(nowMs - SEAT_EMAIL_WINDOW_MS).toISOString());
    if (recentError) {
      console.error("[scim] seat email: de-dupe read failed, sending anyway:", recentError.message);
    } else if ((recent ?? 0) > 0) {
      return "deduped";
    }

    const { data: org } = await db
      .from("organizations")
      .select("name, max_seats")
      .eq("id", params.orgId)
      .maybeSingle();

    const { data: members, error: membersError } = await db
      .from("organization_members")
      .select("user_id, role, license_status, invitation_expires_at")
      .eq("organization_id", params.orgId);
    if (membersError || !Array.isArray(members)) {
      console.error("[scim] seat email: member read failed:", membersError?.message);
      return "failed";
    }

    type Member = {
      user_id: string | null;
      role: string;
      license_status: string | null;
      invitation_expires_at: string | null;
    };
    const rows = members as Member[];
    const used = rows.filter((m) => rowHoldsSeat(m, nowMs)).length;

    let recipientIds: string[] = [];
    for (const role of SEAT_EMAIL_ROLE_ORDER) {
      recipientIds = rows
        .filter((m) =>
          m.role === role && m.license_status === "active" && !!m.user_id &&
          m.user_id !== params.excludeUserId
        )
        .map((m) => m.user_id as string);
      if (recipientIds.length > 0) break;
    }
    if (recipientIds.length === 0) return "no_recipients";

    const { data: users } = await db
      .from("users")
      .select("id, email")
      .in("id", recipientIds);
    const recipients = Array.from(
      new Set(
        ((users ?? []) as Array<{ email: string | null }>)
          .map((u) => (u.email ?? "").trim())
          .filter((e) => e.length > 0),
      ),
    );
    if (recipients.length === 0) return "no_recipients";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SEAT_EMAIL_TIMEOUT_MS);
    try {
      const res = await deps.fetch(`${portalUrl}/api/email/seat-limit-reached`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": apiSecret },
        body: JSON.stringify({
          recipients,
          personLabel: params.personLabel,
          brokerageName: (org?.name as string | undefined) ?? "your brokerage",
          used,
          maxSeats: (org?.max_seats as number | null | undefined) ?? null,
          kind: params.kind,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`[scim] seat email: portal returned ${res.status}`);
        return "failed";
      }
      return "sent";
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error("[scim] seat email failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
}
