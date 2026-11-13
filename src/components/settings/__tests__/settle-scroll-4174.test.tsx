/**
 * BACKLOG-4174 — opening Settings at a section keeps that section at the top
 * while the sections above it finish growing.
 *
 * The real Settings page runs with a host that clears the target on arrival,
 * as SettingsLayer does. ResizeObserver and scrollIntoView are mocked; each
 * resize report carries the observed element and its height.
 *
 *   C1   a scroll event, then the content column grows: About is re-scrolled
 *        once, with behavior "instant".
 *   C1s  the bottom spacer grows: same re-scroll.
 *   C2   a wheel before the growth: no re-scroll.
 *   C3   growth after SECTION_SETTLE_MS: no re-scroll.
 *   C5   a tab is clicked after landing, then growth: no re-scroll to About.
 *   C6   the observer's first report equals each element's height at landing:
 *        no re-scroll, so the smooth landing is left alone.
 *   C7   the spacer is 0 at landing and its FIRST report is already grown:
 *        About is re-scrolled.
 *
 * getBoundingClientRect is mocked so the content column and the spacer lay out
 * at the heights the observer later reports as their starting sizes.
 */

import React from "react";
import { act, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Settings from "../../Settings";
import { PlatformProvider } from "../../../contexts/PlatformContext";
import { NotificationProvider } from "../../../contexts/NotificationContext";

if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = jest.fn();
}

// Context providers the page needs.
jest.mock("@/contexts/LicenseContext", () => ({
  useLicense: () => ({
    licenseType: "individual" as const,
    hasAIAddon: true,
    organizationId: null,
    canExport: true,
    canSubmit: false,
    canAutoDetect: true,
    isLoading: false,
    refresh: jest.fn(),
  }),
}));
jest.mock("@/contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: new Date(),
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn().mockResolvedValue(true),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

// Fictional fixture values.
const ACCOUNT = { user: { id: "user-123", email: "avery@example.com", display_name: "Avery Example" }, provider: "google" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });

/** Plan read and strict read, each settled by the test. */
function mockReads(): {
  plan: Deferred<Record<string, { allowed: boolean }>>;
  strict: Deferred<string>;
} {
  const plan = deferred<Record<string, { allowed: boolean }>>();
  const strict = deferred<string>();
  jest.mocked(window.api.featureGate.getAll).mockReturnValue(plan.promise as never);
  jest.mocked(window.api.featureGate.strictState).mockImplementation(((key: string) =>
    key === "autodetect_eval" ? strict.promise : Promise.resolve("blocked")) as never);
  return { plan, strict };
}

function mockSettingsApi(): void {
  jest.mocked(window.api.system.checkAllConnections).mockResolvedValue({
    success: true,
    google: { connected: false },
    microsoft: { connected: false },
  });
  jest.mocked(window.api.preferences.get).mockResolvedValue({
    success: true,
    preferences: { export: { defaultFormat: "combined-pdf" } },
  });
  jest.mocked(window.api.preferences.update).mockResolvedValue({ success: true });
  jest.mocked(window.api.onGoogleMailboxConnected).mockReturnValue(jest.fn());
  jest.mocked(window.api.onMicrosoftMailboxConnected).mockReturnValue(jest.fn());
  jest.mocked(window.api.onGoogleMailboxDisconnected).mockReturnValue(jest.fn());
  jest.mocked(window.api.onMicrosoftMailboxDisconnected).mockReturnValue(jest.fn());
  jest.mocked(window.api.messages.onImportProgress).mockReturnValue(jest.fn());
  jest.mocked(window.api.llm.getConfig).mockResolvedValue({ success: true, data: {} } as never);
  jest.mocked(window.api.llm.getUsage).mockResolvedValue({
    success: true,
    data: { tokensThisMonth: 0, platformAllowance: 10000, platformUsed: 0 },
  } as never);
  window.api.update.checkForUpdates = jest.fn().mockResolvedValue({ updateAvailable: false });
  window.api.auth.getActiveDevices = jest.fn().mockResolvedValue({ success: true, devices: [] });
  window.api.transactions.precacheEmails = jest
    .fn()
    .mockResolvedValue({ success: true, emailsFetched: 0, emailsStored: 0 });
  window.api.preferences.save = jest.fn().mockResolvedValue({ success: true });
  (window.api as unknown as { learn: unknown }).learn = {
    getState: jest.fn().mockResolvedValue({
      success: true,
      available: true,
      enabled: false,
      answers: { deal: 0, bulk: 0 },
      pilotReport: false,
      pilotPending: false,
      pilotLastSentAt: null,
    }),
  };
}


// The real SECTION_SETTLE_MS (3000); restated so the timer control fails if it shrinks.
const SETTLE_MS = 3000;

/** Clears the target once the section is reached, like SettingsLayer. */
function Host({ section }: { section: string }) {
  const [target, setTarget] = React.useState<string | null>(section);
  return (
    <NotificationProvider>
      <PlatformProvider>
        <Settings
          account={ACCOUNT}
          userId="user-123"
          onClose={jest.fn()}
          onStartLearn={jest.fn()}
          onSeeLearnScore={jest.fn()}
          initialSection={target}
          onSectionReached={() => setTarget(null)}
        />
      </PlatformProvider>
    </NotificationProvider>
  );
}

interface FakeObserver {
  cb: ResizeObserverCallback;
  els: Element[];
  off: boolean;
}
let observers: FakeObserver[] = [];
let calls: Array<{ id: string; behavior?: string }> = [];
let originalRO: typeof ResizeObserver | undefined;
let originalScrollIntoView: typeof Element.prototype.scrollIntoView;
let originalRect: typeof Element.prototype.getBoundingClientRect;
/** Laid-out heights at landing; C7 lowers the spacer's to 0. */
let contentStart = 100;
let spacerStart = 100;

beforeEach(() => {
  mockSettingsApi();
  observers = [];
  calls = [];
  originalRO = (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  originalScrollIntoView = Element.prototype.scrollIntoView;
  originalRect = Element.prototype.getBoundingClientRect;
  contentStart = 100;
  spacerStart = 100;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = originalRect.call(this);
    const height =
      this.getAttribute("data-testid") === "settings-bottom-spacer"
        ? spacerStart
        : this.parentElement?.classList.contains("overflow-y-auto") && this === this.parentElement.firstElementChild
          ? contentStart
          : null;
    if (height === null) return rect;
    return { x: rect.x, y: rect.y, top: rect.top, left: rect.left, right: rect.right, width: rect.width, bottom: rect.top + height, height, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    private o: FakeObserver;
    constructor(cb: ResizeObserverCallback) {
      this.o = { cb, els: [], off: false };
      observers.push(this.o);
    }
    observe(el: Element) {
      this.o.els.push(el);
    }
    unobserve() {}
    disconnect() {
      this.o.off = true;
    }
  };
  Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
    calls.push({ id: (this as HTMLElement).id, behavior: typeof arg === "object" ? arg.behavior : undefined });
  };
});
afterEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  Element.prototype.getBoundingClientRect = originalRect;
  jest.useRealTimers();
});

/** Reports `el` at `height` to every live observer watching it. */
function report(el: Element, height: number): void {
  act(() => {
    for (const o of observers) {
      if (o.off || !o.els.includes(el)) continue;
      o.cb([{ target: el, contentRect: { height } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}
/** The observer's first report: every watched element at its landed height. */
function reportStartingSizes(): void {
  for (const o of observers) for (const el of o.els) report(el, el === spacer() ? spacerStart : contentStart);
}

const scroller = (): HTMLElement => document.querySelector(".overflow-y-auto") as HTMLElement;
const content = (): Element => scroller().firstElementChild as Element;
const spacer = (): Element => screen.getByTestId("settings-bottom-spacer");

async function landAtAbout(): Promise<number> {
  const { plan, strict } = mockReads();
  plan.resolve({});
  strict.resolve("blocked");
  render(<Host section="settings-about" />);
  await tick();
  await tick();
  await tick();
  expect(calls).toEqual([{ id: "settings-about", behavior: "smooth" }]);
  reportStartingSizes();
  return calls.length;
}

describe("BACKLOG-4174 the landed section stays at the top while Settings settles", () => {
  it("C1 the content column grows after a scroll event: About is re-scrolled instantly", async () => {
    const n = await landAtAbout();
    act(() => {
      scroller().dispatchEvent(new Event("scroll"));
    });
    report(content(), 400);
    expect(calls.slice(n)).toEqual([{ id: "settings-about", behavior: "instant" }]);
  });

  it("C1s the bottom spacer grows: About is re-scrolled instantly", async () => {
    const n = await landAtAbout();
    report(spacer(), 520);
    expect(calls.slice(n)).toEqual([{ id: "settings-about", behavior: "instant" }]);
  });

  it("C2 a wheel before the growth ends the window", async () => {
    const n = await landAtAbout();
    act(() => {
      scroller().dispatchEvent(new Event("wheel"));
    });
    report(content(), 400);
    expect(calls.slice(n)).toEqual([]);
  });

  it("C3 growth after the settle window is left alone", async () => {
    jest.useFakeTimers();
    const { plan, strict } = mockReads();
    plan.resolve({});
    strict.resolve("blocked");
    render(<Host section="settings-about" />);
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(20);
      });
    }
    expect(calls).toEqual([{ id: "settings-about", behavior: "smooth" }]);
    reportStartingSizes();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(SETTLE_MS + 100);
    });
    const n = calls.length;
    report(content(), 400);
    expect(calls.slice(n)).toEqual([]);
  });

  it("C5 a tab clicked after landing ends the window", async () => {
    await landAtAbout();
    const tab = screen.getByTestId("settings-tab-security");
    act(() => {
      tab.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      tab.click();
    });
    const n = calls.length;
    report(content(), 400);
    expect(calls.slice(n).filter((c) => c.id === "settings-about")).toEqual([]);
  });

  it("C6 the first report of each element's size does not re-scroll", async () => {
    const { plan, strict } = mockReads();
    plan.resolve({});
    strict.resolve("blocked");
    render(<Host section="settings-about" />);
    await tick();
    await tick();
    await tick();
    expect(observers.some((o) => !o.off && o.els.length > 0)).toBe(true);
    reportStartingSizes();
    expect(calls).toEqual([{ id: "settings-about", behavior: "smooth" }]);
  });

  it("C7 the spacer is 0 at landing and its first report is grown: About is re-scrolled", async () => {
    spacerStart = 0;
    const { plan, strict } = mockReads();
    plan.resolve({});
    strict.resolve("blocked");
    render(<Host section="settings-about" />);
    await tick();
    await tick();
    await tick();
    expect(calls).toEqual([{ id: "settings-about", behavior: "smooth" }]);
    expect(spacer().getBoundingClientRect().height).toBe(0);
    report(content(), contentStart);
    report(spacer(), 520);
    expect(calls.slice(1)).toEqual([{ id: "settings-about", behavior: "instant" }]);
  });
});
