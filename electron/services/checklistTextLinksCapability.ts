/**
 * BACKLOG-3968 — may this submission send checklist TEXT links?
 *
 * The cloud says so itself: `public.submission_checklist_capabilities()`
 * (supabase/migrations/20261031230000_backlog_3968_checklist_text_links.sql
 * §6) returns `{ link_kinds, text_links, text_external_ids }`. A project
 * without that migration has no such function, and its snapshot function
 * raises on kind 'text' — so texts are sent ONLY on a clear yes.
 *
 * Held (`textLinks: false`) on ANY of: no signed-in session, no client, an
 * error from the call (PGRST202 function absent, auth, network), a call that
 * does not answer within `CAPABILITY_TIMEOUT_MS`, or `text_links` not strictly
 * `true` (SR review of PR-5, §6).
 *
 * Read once per gather (`submissionService.gatherForSubmission`): the
 * pre-flight and the submit each ask, and the submit's own answer decides
 * both its pre-flight list and its snapshot payload. Never cached across
 * attempts. While held, the submit also leaves `external_id` off the uploaded
 * text rows (that column arrives with the same migration).
 */

import supabaseService from "./supabaseService";
import logService from "./logService";

const LOG_CONTEXT = "ChecklistTextLinksCapability";

/** The RPC name, exported so tests address the same function. */
export const CAPABILITIES_RPC = "submission_checklist_capabilities";

/** How long the capability call may take before texts are held. */
export const CAPABILITY_TIMEOUT_MS = 8000;

export type TextLinksCapability =
  | { textLinks: true }
  | { textLinks: false; reason: "no_session" | "error" | "timeout" | "not_supported" };

/** The one method of the Supabase client this module uses. */
export interface CapabilityRpcClient {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
}

const TIMED_OUT = Symbol("timed out");

export async function textLinksCapability(
  /** Called inside the guard: a client that cannot be built holds texts. */
  getClient: () => CapabilityRpcClient | null | undefined,
  options: { timeoutMs?: number; hasSession?: () => Promise<boolean> } = {}
): Promise<TextLinksCapability> {
  const timeoutMs = options.timeoutMs ?? CAPABILITY_TIMEOUT_MS;
  const hasSession =
    options.hasSession ?? (async () => (await supabaseService.getAuthSession()) !== null);
  const held = (reason: "no_session" | "error" | "timeout" | "not_supported", detail?: unknown): TextLinksCapability => {
    logService.warn("[Submission] Checklist text links are held for this submission", LOG_CONTEXT, {
      reason,
      detail: detail instanceof Error ? detail.message : detail,
    });
    return { textLinks: false, reason };
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    if (!(await hasSession())) return held("no_session");
    const client = getClient();
    if (!client) return held("no_session");
    const answer = await Promise.race([
      Promise.resolve(client.rpc(CAPABILITIES_RPC)),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
    ]);
    if (answer === TIMED_OUT) return held("timeout");
    if (answer.error) return held("error", answer.error.code ?? answer.error.message);
    const data = answer.data;
    if (data !== null && typeof data === "object" && (data as { text_links?: unknown }).text_links === true) {
      return { textLinks: true };
    }
    return held("not_supported");
  } catch (err) {
    return held("error", err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
