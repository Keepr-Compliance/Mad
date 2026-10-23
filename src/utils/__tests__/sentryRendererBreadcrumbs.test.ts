/**
 * BACKLOG-4049 C1: unit sweep of the renderer breadcrumb filter and the scope
 * sanitizer helpers. Fixture values are fictional.
 */
import type { Breadcrumb } from "@sentry/electron/renderer";
import {
  RENDERER_BREADCRUMB_CATEGORIES,
  RENDERER_BREADCRUMB_STRING_KEYS,
  SCOPE_SANITIZER_NAME,
  filterRendererBreadcrumb,
  withScopeSanitizer,
} from "../sentryRendererBreadcrumbs";

const NAME = "Marlo Fenwick";
const EMAIL = "marlo.fenwick@example.com";

describe("filterRendererBreadcrumb: categories", () => {
  const rejected: Array<unknown> = [
    "ui.click",
    "ui.input",
    "console",
    "navigation",
    "fetch",
    "xhr",
    "sentry.event",
    "sentry.transaction",
    "http",
    "new.category",
    undefined,
    null,
    "",
    "Sync",
    "SYNC",
    "sync.x",
    "xsync",
    " sync",
    "sync ",
    "onboarding",
    "onboarding.fda.extra",
    "iphone",
    42,
  ];
  it.each(rejected.map((c) => [String(c), c]))("rejects category %s", (_label, category) => {
    expect(filterRendererBreadcrumb({ category, message: "m" } as Breadcrumb)).toBeNull();
  });

  it("keeps exactly the 7 app categories", () => {
    expect([...RENDERER_BREADCRUMB_CATEGORIES].sort()).toEqual([
      "init",
      "iphone.detection",
      "iphone.driver_recovery",
      "onboarding.fda",
      "onboarding.init",
      "onboarding.verification",
      "sync",
    ]);
    for (const category of RENDERER_BREADCRUMB_CATEGORIES) {
      expect(filterRendererBreadcrumb({ category, message: "ok" })).toEqual({
        category,
        message: "ok",
      });
    }
  });
});

describe("filterRendererBreadcrumb: data rebuild", () => {
  it("drops strings under unlisted keys (error, message, userId)", () => {
    const out = filterRendererBreadcrumb({
      category: "sync",
      data: { error: `failed for ${NAME}`, message: EMAIL, userId: "abcd1234", attempt: 3 },
    });
    expect(out?.data).toEqual({ attempt: 3 });
  });

  it("keeps string values under every listed key", () => {
    for (const key of RENDERER_BREADCRUMB_STRING_KEYS) {
      const value = key === "syncTypes" ? ["contacts", "emails"] : "value-1";
      const out = filterRendererBreadcrumb({ category: "sync", data: { [key]: value } });
      expect(out?.data).toEqual({ [key]: value });
    }
  });

  it("keeps number, boolean and null values under any key", () => {
    const data = { attempt: 2, waited_ms: 10, will_retry: true, hasX: false, currentSync: null };
    expect(filterRendererBreadcrumb({ category: "sync", data })?.data).toEqual(data);
  });

  it("drops nested objects and non-string arrays", () => {
    const out = filterRendererBreadcrumb({
      category: "sync",
      data: {
        nested: { name: NAME },
        syncTypes: ["contacts", 5],
        list: ["a", "b"],
        stage: { inner: "x" },
      },
    });
    expect(out?.data).toBeUndefined();
  });

  it("redacts emails and phone numbers in kept text and caps its length", () => {
    const out = filterRendererBreadcrumb({
      category: "sync",
      message: `Sync started: ${EMAIL} +1 206 555-0142 attempt 1/3`,
      data: { stage: `stage ${EMAIL}` },
    });
    expect(out?.message).toBe("Sync started: [email] [phone] attempt 1/3");
    expect(out?.data).toEqual({ stage: "stage [email]" });
    const long = filterRendererBreadcrumb({ category: "sync", message: "x".repeat(500) });
    expect(long?.message).toHaveLength(200);
  });

  it("keeps only known level and type values and a numeric timestamp", () => {
    expect(
      filterRendererBreadcrumb({
        category: "init",
        level: "info",
        type: "default",
        timestamp: 123,
      }),
    ).toEqual({ category: "init", level: "info", type: "default", timestamp: 123 });
    expect(
      filterRendererBreadcrumb({
        category: "init",
        level: NAME as Breadcrumb["level"],
        type: NAME,
        timestamp: NAME as unknown as number,
      }),
    ).toEqual({ category: "init" });
  });

  it("is idempotent", () => {
    const once = filterRendererBreadcrumb({
      category: "sync",
      message: `Sync completed: ${EMAIL}`,
      level: "info",
      timestamp: 5,
      data: { attempt: 1, syncType: "contacts", error: NAME },
    });
    expect(filterRendererBreadcrumb(once as Breadcrumb)).toEqual(once);
  });

  it("returns null when reading the breadcrumb throws", () => {
    const hostile = {
      category: "sync",
      get data(): Record<string, unknown> {
        throw new Error("boom");
      },
    } as Breadcrumb;
    expect(filterRendererBreadcrumb(hostile)).toBeNull();
  });
});

describe("withScopeSanitizer", () => {
  const scopeAccess = {
    getCurrentScope: jest.fn(),
    getIsolationScope: jest.fn(),
    getGlobalScope: jest.fn(),
  } as never;
  const named = (name: string) => ({ name });

  it("inserts the sanitizer directly before ScopeToMain", () => {
    const out = withScopeSanitizer(
      [named("A"), named("ScopeToMain"), named("B")] as never,
      scopeAccess,
    );
    expect(out.map((i) => i.name)).toEqual(["A", SCOPE_SANITIZER_NAME, "ScopeToMain", "B"]);
  });

  it("appends the sanitizer when ScopeToMain is absent, and never duplicates it", () => {
    const once = withScopeSanitizer([named("A")] as never, scopeAccess);
    const twice = withScopeSanitizer(once, scopeAccess);
    expect(twice.map((i) => i.name)).toEqual(["A", SCOPE_SANITIZER_NAME]);
  });
});
