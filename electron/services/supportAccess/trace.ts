/**
 * Support trace entry point for producers (BACKLOG-2393)
 *
 * Deliberately tiny, with no imports that carry runtime weight.
 *
 * Producers live deep in the app — contact resolution, message import, email
 * sync. If they imported the support access bundle directly they would drag
 * `electron.app`, the Supabase client and the whole diagnostics collector into
 * every test that touches them, and a diagnostics feature would become a
 * reason for unrelated suites to fail. So the bundle registers itself here at
 * startup, and producers depend only on this file.
 *
 * Before registration every call is a no-op. That is the correct default: no
 * window can be open before the persisted state has been read.
 */

import type { SupportLogScopeId } from "./scopes";

export interface SupportTraceSink {
  write(
    scope: SupportLogScopeId,
    event: string,
    fields: Record<string, unknown>,
  ): void;
  isScopeActive(scope: SupportLogScopeId): boolean;
  /** Something failed somewhere in the app. Debounced downstream. */
  notifyError(): void;
}

let sink: SupportTraceSink | null = null;

export function registerSupportTraceSink(next: SupportTraceSink | null): void {
  sink = next;
}

/**
 * Record one scoped diagnostic event. Never throws, never blocks: a producer
 * must not be able to fail because diagnostics did.
 */
export function supportTrace(
  scope: SupportLogScopeId,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!sink) return;
  try {
    sink.write(scope, event, fields);
  } catch {
    /* diagnostics must never break the thing they are observing */
  }
}

/**
 * Tell support access that something went wrong, so it can capture a report
 * close to the failure rather than at the next scheduled hour.
 *
 * This is the on-error half of the batched-upload design, which existed as a
 * debounced code path with nothing calling it. It is wired to
 * `failureLogService.logFailure` — the app's one central "a thing failed"
 * point — through this seam rather than by importing the bundle, which would
 * put a cycle between the failure log and the diagnostics collector that reads
 * the failure log.
 *
 * Never throws. Debouncing and the window check both live downstream.
 */
export function notifySupportError(): void {
  if (!sink) return;
  try {
    sink.notifyError();
  } catch {
    /* diagnostics must never break the thing they are observing */
  }
}

/**
 * True when this scope is granted and the window is open.
 *
 * Call this before assembling anything expensive — or anything identifying.
 * `supportTrace` will drop the entry either way, but the fields would already
 * have been built by then.
 */
export function isSupportScopeActive(scope: SupportLogScopeId): boolean {
  if (!sink) return false;
  try {
    return sink.isScopeActive(scope);
  } catch {
    return false;
  }
}
