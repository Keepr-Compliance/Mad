/**
 * Renderer Sentry allow-list (BACKLOG-4049).
 *
 * The renderer SDK forwards its scope (breadcrumbs, tags, extra, user,
 * attachments) to the main process on every scope change, and main applies it
 * to its own scope. This module decides what the renderer is allowed to put
 * there. Two layers:
 *
 *   1. `filterRendererBreadcrumb` runs as `beforeBreadcrumb`. Only the app
 *      categories below are kept, and their `data` is rebuilt from scratch.
 *      Everything else (ui.*, console, navigation, fetch, xhr, sentry.*, any
 *      future category) returns null. A throw returns null (fail closed).
 *   2. `createScopeSanitizerIntegration` registers a scope listener ahead of the
 *      SDK's ScopeToMain integration. Writes made directly on a scope skip
 *      `beforeBreadcrumb`, so before each forward this listener re-filters the
 *      scope's breadcrumbs, keeps only the listed tag keys, keeps only `user.id`,
 *      and empties `extra`, `contexts`, `attributes` and attachments.
 *
 * Adding a category, a data key or a tag key is a one-line change to the sets
 * below. The guard in `src/utils/__tests__/sentryRendererBreadcrumbs.guard.test.ts`
 * fails when a call site uses anything that is not listed here.
 *
 * This file has no runtime import from `@sentry/*` (type imports only): the SDK
 * namespace is passed in by `src/main.tsx`, so tests can drive the real library.
 */
import type { Breadcrumb, BrowserOptions } from "@sentry/electron/renderer";

type SentryRendererModule = typeof import("@sentry/electron/renderer");
export type RendererScopeAccess = Pick<
  SentryRendererModule,
  "getCurrentScope" | "getIsolationScope" | "getGlobalScope"
>;
type RendererScope = ReturnType<SentryRendererModule["getCurrentScope"]>;
type RendererIntegration = Extract<
  NonNullable<BrowserOptions["integrations"]>,
  readonly unknown[]
>[number];

/** The only breadcrumb categories the renderer may record. Exact match. */
export const RENDERER_BREADCRUMB_CATEGORIES: ReadonlySet<string> = new Set([
  "sync",
  "init",
  "onboarding.init",
  "onboarding.verification",
  "onboarding.fda",
  "iphone.detection",
  "iphone.driver_recovery",
]);

/**
 * Data keys whose STRING values are kept. Number, boolean and null values pass
 * under any key; strings under any other key are dropped.
 */
export const RENDERER_BREADCRUMB_STRING_KEYS: ReadonlySet<string> = new Set([
  "stage",
  "previousStage",
  "init_stage",
  "operation",
  "provider",
  "syncType",
  "syncTypes",
  "platform",
  "hint",
  "currentSync",
  "link_variant",
  "outcome",
]);

/** Data keys that may hold an array (of strings only). */
const STRING_ARRAY_KEYS: ReadonlySet<string> = new Set(["syncTypes"]);

/** The only scope tag keys the renderer may set. */
export const RENDERER_SCOPE_TAG_KEYS: ReadonlySet<string> = new Set([
  "init_stage",
  "onboarding_phase",
]);

const LEVELS: ReadonlySet<string> = new Set([
  "fatal",
  "error",
  "warning",
  "log",
  "info",
  "debug",
]);
const TYPES: ReadonlySet<string> = new Set(["default", "info", "debug", "error"]);

const MAX_TEXT = 200;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d ().-]{8,}\d/g;

/** Backstop for kept text: removes emails and phone-shaped runs, caps length. */
function cleanText(value: string): string {
  const out = value
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 10 ? "[phone]" : m));
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT) : out;
}

function rebuildData(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      if (RENDERER_BREADCRUMB_STRING_KEYS.has(key)) out[key] = cleanText(value);
    } else if (Array.isArray(value)) {
      if (STRING_ARRAY_KEYS.has(key) && value.every((v) => typeof v === "string")) {
        out[key] = value.map((v: string) => cleanText(v));
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `beforeBreadcrumb` for the renderer. Returns a rebuilt breadcrumb for an
 * allowed category, otherwise null. Applying it twice gives the same result.
 */
export function filterRendererBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  try {
    const category = breadcrumb.category;
    if (typeof category !== "string" || !RENDERER_BREADCRUMB_CATEGORIES.has(category)) {
      return null;
    }
    const out: Breadcrumb = { category };
    if (typeof breadcrumb.timestamp === "number") out.timestamp = breadcrumb.timestamp;
    if (typeof breadcrumb.level === "string" && LEVELS.has(breadcrumb.level)) {
      out.level = breadcrumb.level;
    }
    if (typeof breadcrumb.type === "string" && TYPES.has(breadcrumb.type)) {
      out.type = breadcrumb.type;
    }
    if (typeof breadcrumb.message === "string") out.message = cleanText(breadcrumb.message);
    const data = breadcrumb.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const rebuilt = rebuildData(data as Record<string, unknown>);
      if (rebuilt) out.data = rebuilt;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Reduces one scope, in place, to what the renderer may forward. Works on the
 * objects `getScopeData()` returns, which are the scope's own.
 */
export function sanitizeRendererScope(scope: RendererScope): void {
  try {
    const d = scope.getScopeData();

    const tags = d.tags as Record<string, unknown>;
    for (const key of Object.keys(tags)) {
      const value = tags[key];
      if (!RENDERER_SCOPE_TAG_KEYS.has(key)) {
        delete tags[key];
      } else if (typeof value === "string") {
        tags[key] = cleanText(value);
      } else if (typeof value !== "number" && typeof value !== "boolean") {
        delete tags[key];
      }
    }

    for (const bag of [d.extra, d.contexts, d.attributes]) {
      const record = (bag ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(record)) delete record[key];
    }

    const user = d.user as Record<string, unknown>;
    for (const key of Object.keys(user)) {
      const value = user[key];
      if (key !== "id" || (typeof value !== "string" && typeof value !== "number")) {
        delete user[key];
      }
    }

    d.attachments.length = 0;

    const crumbs = d.breadcrumbs;
    let write = 0;
    for (let read = 0; read < crumbs.length; read++) {
      const kept = filterRendererBreadcrumb(crumbs[read]);
      if (kept) crumbs[write++] = kept;
    }
    crumbs.length = write;
  } catch {
    // Fail closed: if the scope cannot be reduced, empty it.
    try {
      scope.clear();
    } catch {
      // nothing left to do
    }
  }
}

export const SCOPE_SANITIZER_NAME = "KeeprScopeSanitizer";

/**
 * An integration whose scope listeners run before ScopeToMain's (it must sit
 * ahead of ScopeToMain in the integration list; see `withScopeSanitizer`).
 */
export function createScopeSanitizerIntegration(
  sentry: RendererScopeAccess,
): RendererIntegration {
  const run = (): void => {
    sanitizeRendererScope(sentry.getGlobalScope());
    sanitizeRendererScope(sentry.getIsolationScope());
    sanitizeRendererScope(sentry.getCurrentScope());
  };
  return {
    name: SCOPE_SANITIZER_NAME,
    setup() {
      run();
      sentry.getIsolationScope().addScopeListener(run);
      sentry.getCurrentScope().addScopeListener(run);
      sentry.getGlobalScope().addScopeListener(run);
    },
  };
}

/** Inserts the sanitizer directly before ScopeToMain (or last if it is absent). */
export function withScopeSanitizer(
  integrations: RendererIntegration[],
  sentry: RendererScopeAccess,
): RendererIntegration[] {
  const sanitizer = createScopeSanitizerIntegration(sentry);
  const out = integrations.filter((i) => i.name !== SCOPE_SANITIZER_NAME);
  const at = out.findIndex((i) => i.name === "ScopeToMain");
  if (at === -1) return [...out, sanitizer];
  return [...out.slice(0, at), sanitizer, ...out.slice(at)];
}

/** The options `src/main.tsx` passes to `Sentry.init`. */
export function buildRendererSentryOptions(
  sentry: RendererScopeAccess,
): Pick<BrowserOptions, "beforeBreadcrumb" | "integrations"> {
  return {
    beforeBreadcrumb: filterRendererBreadcrumb,
    integrations: (defaults: RendererIntegration[]) => withScopeSanitizer(defaults, sentry),
  };
}
