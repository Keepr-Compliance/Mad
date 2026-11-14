/**
 * Keepr Cloud RPC client — BACKLOG-4243 PR-2.
 *
 * Every call is one RPC as the signed-in user (migration 20261112190000).
 * Every write carries `p_expected_user_id` FIRST; the caller passes the id the
 * pass was pinned to, never a value read from the live session (R1).
 *
 * Results are classified, never thrown:
 * - `ok`        the envelope said ok/success true (rows still need checking, R2);
 * - `refused`   the envelope said false with a code (known or not, contract
 *               `tolerance`); an unknown code is non-retryable for that call;
 * - `transport` no envelope: network error, timeout, HTTP/PostgREST error.
 *               Retryable with back-off (R6, R7); the outcome is unknown.
 * Only codes are kept: never an error message, detail or hint (R7).
 */
import type { JsonValue } from "./jcs";

/**
 * Client timeout for one RPC. Must be longer than the server's statement
 * timeout for the `authenticated` role so a timed-out call is already dead on
 * the server before any retry (R6). The server value is UNTRACED in this repo
 * (no `statement_timeout` in supabase/); this constant is the one place to
 * change if a measured value is larger.
 */
export const CLIENT_RPC_TIMEOUT_MS = 30_000;

export const KNOWN_ENVELOPE_ERRORS = [
  "not_authorized",
  "not_entitled",
  "wrong_account",
  "invalid_input",
  "batch_too_large",
  "invalid_organization",
  "not_found",
  "not_licensed",
  "notice_outdated",
  "turn_off_failed",
  "delete_failed",
  "too_large",
  "object_missing",
  "size_mismatch",
] as const;

export type CallResult =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "refused"; code: string; known: boolean }
  | { kind: "transport"; code: string };

export interface RpcResponse {
  data: unknown;
  error: { code?: unknown; status?: unknown } | null;
  status?: number;
}

/** The transport: one RPC by name. Injected; the default wraps supabase-js. */
export type RpcTransport = (fn: string, args: Record<string, JsonValue>, signal: AbortSignal) => Promise<RpcResponse>;

function codeOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 64) : null;
}

export function classifyResponse(res: RpcResponse): CallResult {
  if (res.error) {
    const code = codeOf(res.error.code) ?? (typeof res.status === "number" ? `http_${res.status}` : "http_error");
    return { kind: "transport", code };
  }
  const body = res.data;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { kind: "transport", code: "no_envelope" };
  }
  const env = body as Record<string, unknown>;
  const flag = "ok" in env ? env.ok : "success" in env ? env.success : undefined;
  if (flag === true) return { kind: "ok", body: env };
  if (flag === false) {
    const code = codeOf(env.error) ?? "no_code";
    return { kind: "refused", code, known: (KNOWN_ENVELOPE_ERRORS as readonly string[]).includes(code) };
  }
  return { kind: "transport", code: "no_envelope" };
}

export class CloudClient {
  constructor(
    private readonly transport: RpcTransport,
    private readonly timeoutMs: number = CLIENT_RPC_TIMEOUT_MS,
  ) {}

  async call(fn: string, args: Record<string, JsonValue>): Promise<CallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.transport(fn, args, controller.signal);
      return classifyResponse(res);
    } catch {
      return { kind: "transport", code: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The state read. Not a write: no expected-user argument. */
  async getState(): Promise<CallResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.transport("get_my_cloud_autosave_state", {}, controller.signal);
      if (res.error) return classifyResponse(res);
      // The state function returns a bare object (no ok flag), shape v1.
      const body = res.data;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        return { kind: "ok", body: body as Record<string, unknown> };
      }
      return { kind: "transport", code: "no_envelope" };
    } catch {
      return { kind: "transport", code: controller.signal.aborted ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  setAutosave(expectedUserId: string, enabled: boolean, noticeVersion: number | null): Promise<CallResult> {
    return this.call("set_my_cloud_autosave", {
      p_expected_user_id: expectedUserId,
      p_enabled: enabled,
      p_notice_version: noticeVersion,
    });
  }

  upsertDeal(expectedUserId: string, deal: { [key: string]: JsonValue }): Promise<CallResult> {
    return this.call("cloud_upsert_deal", { p_expected_user_id: expectedUserId, p_deal: deal });
  }

  deleteDeal(expectedUserId: string, cloudDealId: string): Promise<CallResult> {
    return this.call("cloud_delete_deal", { p_expected_user_id: expectedUserId, p_cloud_deal_id: cloudDealId });
  }

  markDealSynced(expectedUserId: string, installId: string, cloudDealId: string): Promise<CallResult> {
    return this.call("cloud_mark_deal_synced", {
      p_expected_user_id: expectedUserId,
      p_source_install_id: installId,
      p_cloud_deal_id: cloudDealId,
    });
  }
}
