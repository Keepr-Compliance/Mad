/**
 * The brokerage's last active admin was kept (BACKLOG-4027, founder decision B).
 *
 * A brokerage always keeps at least one active admin. When SCIM or directory sync tries to
 * demote or deactivate the last one, the database keeps the role and licence as they were and
 * writes one billing_change_log row (action 'sync_change_skipped_last_admin'); its single writer
 * is the trigger public._guard_last_admin. This module then emails Keepr support and the
 * brokerage's IT contact (org_contacts role 'it', if set) so a new admin is named, at most once
 * per brokerage per 24 hours, through the broker portal's internal email route.
 *
 * No jsr imports: the database client and fetch are injected so the module runs under jest as
 * well as Deno. Never throws.
 */

/** billing_change_log.action the trigger writes (the de-dupe key). */
export const LAST_ADMIN_LOG_ACTION = "sync_change_skipped_last_admin";

/** scim_sync_log.error_message for a SCIM request that would have removed the last admin. */
export const LAST_ADMIN_KEPT = "last_admin_kept";

/** SCIM 403 detail: the identity provider's admin sees why the person stays active. */
export const LAST_ADMIN_DETAIL =
  "last_admin_kept: Keepr requires at least one active admin in this brokerage. Name another admin in Keepr first, then retry.";

/** De-dupe window for the email. */
export const LAST_ADMIN_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The portal call never holds up the caller for longer than this. */
export const LAST_ADMIN_EMAIL_TIMEOUT_MS = 3000;

/** Keepr staff recipient when KEEPR_SUPPORT_EMAIL is not set. */
export const DEFAULT_SUPPORT_EMAIL = "support@keeprcompliance.com";

// deno-lint-ignore no-explicit-any
type Db = { from(table: string): any };

export interface LastAdminNotifyDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  getEnv: (key: string) => string | undefined;
  now?: () => number;
  timeoutMs?: number;
}

export function defaultLastAdminNotifyDeps(): LastAdminNotifyDeps {
  const g = globalThis as unknown as {
    Deno?: { env: { get(key: string): string | undefined } };
  };
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    getEnv: (key) => g.Deno?.env.get(key),
  };
}

export type LastAdminNotifyOutcome =
  | "sent"
  | "deduped"
  | "not_configured"
  | "failed";

export interface LastAdminNotifyParams {
  orgId: string;
  /** Name or email of the admin who was kept. */
  personLabel: string;
  /** What the identity provider asked for. */
  kind: "deactivate" | "demote";
  source: "scim" | "directory_sync";
}

/**
 * Email support and the IT contact that the last admin was kept. Call it AFTER the write the
 * trigger kept: the current request's billing_change_log row already exists, so a count of 1 in
 * the window is this request alone, and more than 1 means an earlier send already went out.
 */
export async function notifyLastAdminKept(
  db: Db,
  deps: LastAdminNotifyDeps,
  params: LastAdminNotifyParams,
): Promise<LastAdminNotifyOutcome> {
  try {
    const portalUrl = deps.getEnv("BROKER_PORTAL_URL");
    const apiSecret = deps.getEnv("INTERNAL_API_SECRET");
    if (!portalUrl || !apiSecret) {
      console.error("[last-admin] email skipped: BROKER_PORTAL_URL or INTERNAL_API_SECRET not set");
      return "not_configured";
    }
    const nowMs = deps.now ? deps.now() : Date.now();

    const { count: recent, error: recentError } = await db
      .from("billing_change_log")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", params.orgId)
      .eq("action", LAST_ADMIN_LOG_ACTION)
      .gte("created_at", new Date(nowMs - LAST_ADMIN_EMAIL_WINDOW_MS).toISOString());
    if (recentError) {
      console.error("[last-admin] de-dupe read failed, sending anyway:", recentError.message);
    } else if ((recent ?? 0) > 1) {
      return "deduped";
    }

    const { data: org } = await db
      .from("organizations")
      .select("name")
      .eq("id", params.orgId)
      .maybeSingle();

    const support = (deps.getEnv("KEEPR_SUPPORT_EMAIL") ?? "").trim() || DEFAULT_SUPPORT_EMAIL;
    const recipients = new Set<string>([support]);

    // The brokerage's IT contact, if one is set: a member row -> its account's email, or the
    // invited email while the invitation is unclaimed.
    const { data: contacts } = await db
      .from("org_contacts")
      .select("member_id")
      .eq("organization_id", params.orgId)
      .eq("role", "it")
      .is("removed_at", null);
    const memberIds = ((contacts ?? []) as Array<{ member_id: string | null }>)
      .map((c) => c.member_id)
      .filter((id): id is string => !!id);
    if (memberIds.length > 0) {
      const { data: members } = await db
        .from("organization_members")
        .select("user_id, invited_email")
        .in("id", memberIds);
      const rows = (members ?? []) as Array<{ user_id: string | null; invited_email: string | null }>;
      const userIds = rows.map((m) => m.user_id).filter((id): id is string => !!id);
      for (const m of rows) {
        if (!m.user_id && m.invited_email) recipients.add(m.invited_email.trim());
      }
      if (userIds.length > 0) {
        const { data: users } = await db.from("users").select("email").in("id", userIds);
        for (const u of (users ?? []) as Array<{ email: string | null }>) {
          if (u.email && u.email.trim()) recipients.add(u.email.trim());
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LAST_ADMIN_EMAIL_TIMEOUT_MS);
    try {
      const res = await deps.fetch(`${portalUrl}/api/email/last-admin-kept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-secret": apiSecret },
        body: JSON.stringify({
          recipients: Array.from(recipients),
          personLabel: params.personLabel,
          brokerageName: (org?.name as string | undefined) ?? "your brokerage",
          kind: params.kind,
          source: params.source,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        console.error(`[last-admin] email: portal returned ${res.status}`);
        return "failed";
      }
      return "sent";
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error("[last-admin] email failed:", err instanceof Error ? err.message : err);
    return "failed";
  }
}
