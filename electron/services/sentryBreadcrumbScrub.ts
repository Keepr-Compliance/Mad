/**
 * BACKLOG-4040 S3: scrub every main-process breadcrumb, whatever its category.
 *
 * Breadcrumbs are kept on the Sentry scope, and the minidump integration writes
 * that scope to `userData/sentry/scope_v3.json` in PLAINTEXT (a hard-coded store
 * with no hook, so it cannot be sealed). Every main-process breadcrumb passes
 * `beforeBreadcrumb` before it reaches the scope, so redacting here is what keeps
 * emails and phone numbers out of that file. Before this, only HTTP breadcrumbs
 * were touched (their query string, BACKLOG-3768).
 *
 * Not covered: breadcrumbs the RENDERER sends over IPC. `@sentry/electron/main`
 * `ipc.js` adds them to the scope directly, without `beforeBreadcrumb`.
 *
 * Pure: no Sentry or Electron import. Never throws.
 */
import { redactLogText } from "../utils/redactSensitive";
import { scrubHttpBreadcrumb } from "./httpBreadcrumbScrub";

interface BreadcrumbLike {
  type?: string;
  category?: string;
  message?: string;
  data?: { [key: string]: unknown };
}

const MAX_DEPTH = 6;

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactLogText(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: { [key: string]: unknown } = {};
  for (const [k, v] of Object.entries(value as { [key: string]: unknown })) out[k] = scrubValue(v, depth + 1);
  return out;
}

export function scrubBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T {
  let next: T = breadcrumb;
  try {
    next = { ...breadcrumb };
    if (typeof next.message === "string") next.message = redactLogText(next.message);
    if (next.data && typeof next.data === "object") next.data = scrubValue(next.data, 0) as T["data"];
  } catch {
    next = breadcrumb;
  }
  return scrubHttpBreadcrumb(next);
}
