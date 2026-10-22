/**
 * BACKLOG-4049 C2: the real @sentry/electron renderer SDK, initialised with the
 * options src/main.tsx uses, with a fake preload IPC. Asserts on every scope
 * payload the renderer forwards to main (breadcrumbs, tags, extra, user,
 * contexts, attachments), not on the breadcrumb array alone.
 *
 * jest.config.js maps "@sentry/electron" to a mock, so the real library is
 * required by relative path. The fake IPC must exist before the require, or the
 * SDK falls back to fetch().
 *
 * Fixture values are fictional.
 */
import { buildRendererSentryOptions } from "../sentryRendererBreadcrumbs";

const NAME = "Marlo Fenwick";
const EMAIL = "marlo.fenwick@example.com";

const scopes: string[] = [];
(window as unknown as { __SENTRY_IPC__: unknown }).__SENTRY_IPC__ = {
  "sentry-ipc": {
    sendRendererStart: () => {},
    sendScope: (body: string) => scopes.push(body),
    sendEnvelope: () => {},
    sendStatus: () => {},
    sendStructuredLog: () => {},
    sendMetric: () => {},
  },
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Sentry = require("../../../node_modules/@sentry/electron/renderer/index.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function payloads(): Array<Record<string, unknown>> {
  return scopes.map((s) => JSON.parse(s));
}
function allBreadcrumbs(): Array<Record<string, unknown>> {
  return payloads().flatMap((p) => (p.breadcrumbs as Array<Record<string, unknown>>) || []);
}
function expectClean(): void {
  const all = scopes.join("\n").toLowerCase();
  expect(all).not.toContain(NAME.toLowerCase());
  expect(all).not.toContain("fenwick");
  expect(all).not.toContain(EMAIL.toLowerCase());
}

beforeAll(() => {
  Sentry.init(buildRendererSentryOptions(Sentry));
});

beforeEach(() => {
  scopes.length = 0;
});

describe("renderer Sentry scope forwarded to main", () => {
  it("records no click, input, console, navigation or error-title breadcrumbs", async () => {
    document.body.innerHTML = `
      <div class="row"><button aria-label="Remove ${NAME} from transaction">x</button></div>
      <button id="acct" title="${EMAIL} - account settings">A</button>
      <input aria-label="Search ${NAME}" id="q" />`;
    (document.querySelector("button") as HTMLElement).click();
    await wait(20);
    (document.getElementById("acct") as HTMLElement).click();
    await wait(20);
    (document.getElementById("q") as HTMLElement).dispatchEvent(
      new KeyboardEvent("keypress", { key: "a", bubbles: true }),
    );
    await wait(1100);
    // eslint-disable-next-line no-console
    console.log(`lookup ${NAME} ${EMAIL}`);
    // eslint-disable-next-line no-console
    console.warn(`warn ${NAME}`);
    history.pushState({}, "", `/contacts/c-123?email=${EMAIL}#x`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    Sentry.addBreadcrumb({ category: "new.category", message: `new ${NAME}` });
    Sentry.captureException(new Error(`${NAME} not found`));
    Sentry.addBreadcrumb({
      category: "sync",
      message: "sync done",
      data: { attempt: 2, stage: "db-ready", error: `lookup failed for ${NAME} <${EMAIL}>` },
    });
    await wait(50);

    expect(scopes.length).toBeGreaterThan(0);
    expectClean();
    const cats = allBreadcrumbs().map((b) => b.category);
    expect(cats.filter((c) => c !== "sync")).toEqual([]);
    const sync = allBreadcrumbs().find((b) => b.category === "sync");
    expect(sync).toBeDefined();
    expect(sync?.data).toEqual({ attempt: 2, stage: "db-ready" });
  });

  it("drops scope-level writes that carry a name or email, and keeps allowed tags", async () => {
    Sentry.getCurrentScope().addBreadcrumb({ category: "ui.click", message: `click ${NAME}` });
    Sentry.getIsolationScope().addBreadcrumb({
      category: "sync",
      message: "scope sync",
      data: { attempt: 1, error: EMAIL },
    });
    Sentry.setTag("contact", NAME);
    Sentry.getCurrentScope().setTag("who", EMAIL);
    Sentry.setTag("onboarding_phase", `phase ${EMAIL}`);
    Sentry.setTag("init_stage", "db-ready");
    Sentry.setExtra("who", EMAIL);
    Sentry.getCurrentScope().setExtras({ name: NAME });
    Sentry.setUser({ id: "user-1", email: EMAIL, username: NAME });
    Sentry.setContext("person", { name: NAME });
    Sentry.getGlobalScope().setTag("global_who", NAME);
    Sentry.addBreadcrumb({ category: "init", message: "init ok", data: { stage: "ready" } });
    await wait(20);

    expect(scopes.length).toBeGreaterThan(0);
    expectClean();
    const last = payloads()[payloads().length - 1];
    expect(last.tags).toEqual({ onboarding_phase: "phase [email]", init_stage: "db-ready" });
    expect(last.extra).toEqual({});
    expect(last.user).toEqual({ id: "user-1" });
    const crumbs = allBreadcrumbs();
    expect(crumbs.map((b) => b.category).filter((c) => c === "ui.click")).toEqual([]);
    expect(crumbs.find((b) => b.message === "scope sync")?.data).toEqual({ attempt: 1 });
    expect(crumbs.find((b) => b.category === "init")?.data).toEqual({ stage: "ready" });
  });
});
