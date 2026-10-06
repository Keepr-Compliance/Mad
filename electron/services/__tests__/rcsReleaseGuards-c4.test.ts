/**
 * @jest-environment node
 */
/**
 * SR clean-up C4 — release guards for the Google Messages import.
 *
 * 1. The store link: EXTENSION_PUBLISHED may only be true when the store URL
 *    is a real Chrome Web Store detail URL (…/detail/<slug>/<32-letter id>).
 *    Mutation: published flipped on with today's placeholder URL → red.
 * 2. The link code is drawn from a CSPRNG: newLinkCode takes its bytes from
 *    @noble's randomBytes (crypto.getRandomValues), never Math.random.
 *    Mutations: Math.random in newLinkCode → red; a non-uniform reduction → red.
 * 3. The lookback cut-over is final (no TODO / RELEASE OWNER note).
 */
import fs from "fs";
import path from "path";
import { RCS_EXTENSION_STORE_URL } from "../../handlers/rcsImportHandlers";
import { EXTENSION_PUBLISHED } from "../../../src/components/settings/android/extensionDistribution";
import { DEFAULT_LOOKBACK_MONTHS } from "../macOSMessagesImportService/importHelpers";
import { EMAIL_CACHE_DURATION_MONTHS_DEFAULT } from "../../constants";
import { resolveEmailCacheDurationMonths } from "../../utils/preferenceHelper";
import { resolveLookbackMonths } from "../macOSMessagesImportService/importHelpers";

jest.mock("electron", () => ({ app: { getPath: () => "", isPackaged: false }, ipcMain: { handle: jest.fn(), on: jest.fn() }, shell: { openExternal: jest.fn() }, BrowserWindow: { getAllWindows: () => [] } }));

const ROOT = path.join(__dirname, "..", "..", "..");
const STORE_DETAIL = /^https:\/\/chromewebstore\.google\.com\/detail\/[a-z0-9-]+\/[a-p]{32}$/;

describe("release guards (C4)", () => {
  it("EXTENSION_PUBLISHED is only on with a real store detail URL", () => {
    if (EXTENSION_PUBLISHED) expect(RCS_EXTENSION_STORE_URL).toMatch(STORE_DETAIL);
    // The guard itself rejects today's placeholder (no extension id).
    expect(STORE_DETAIL.test("https://chromewebstore.google.com/detail/keepr-for-google-messages")).toBe(false);
    expect(STORE_DETAIL.test(`https://chromewebstore.google.com/detail/keepr/${"a".repeat(32)}`)).toBe(true);
  });

  it("newLinkCode: CSPRNG bytes (noble.randomBytes), rejection-sampled, no Math.random", () => {
    const src = fs.readFileSync(path.join(ROOT, "chrome-extension", "pair-protocol.js"), "utf8");
    const fn = /function newLinkCode\(\) \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
    expect(fn).toContain("noble.randomBytes(");
    expect(fn).not.toMatch(/Math\.random/);
    // 16,000,000 = 16 × 10^6: the reduction mod 10^6 is uniform.
    expect(fn).toMatch(/n < 16000000/);
    expect(src).not.toMatch(/Math\.random/);

    // Behaviour: with getRandomValues spied on, every code comes from it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const P = require(path.join(ROOT, "chrome-extension", "pair-protocol.js"));
    const spy = jest.spyOn(globalThis.crypto, "getRandomValues");
    const mathSpy = jest.spyOn(Math, "random");
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) codes.add(P.newLinkCode());
    expect(spy).toHaveBeenCalled();
    expect(mathSpy).not.toHaveBeenCalled();
    for (const c of codes) expect(c).toMatch(/^[0-9]{6}$/);
    expect(codes.size).toBeGreaterThan(190);
    spy.mockRestore();
    mathSpy.mockRestore();
  });

  // Founder (2026-10-06): 1.5 months for ALL accounts — no grandfathering of
  // older accounts at 3; an explicit choice always wins. Sign-in writes no
  // lookback preference. Mutations: a default back at 3; a sign-in path
  // writing the window again → red.
  it("the lookback default: 1.5 for every account; an explicit choice wins; sign-in writes nothing", () => {
    expect(DEFAULT_LOOKBACK_MONTHS).toBe(1.5);
    expect(EMAIL_CACHE_DURATION_MONTHS_DEFAULT).toBe(1.5);
    expect(resolveLookbackMonths(null, DEFAULT_LOOKBACK_MONTHS)).toBe(1.5);
    expect(resolveLookbackMonths({ lookbackMonths: 3 }, DEFAULT_LOOKBACK_MONTHS)).toBe(3);
    expect(resolveEmailCacheDurationMonths(null)).toBe(1.5);
    expect(resolveEmailCacheDurationMonths({ emailCache: { durationMonths: 3 } })).toBe(3);
    expect(fs.existsSync(path.join(ROOT, "electron", "services", "lookbackGrandfatherService.ts"))).toBe(false);
    for (const f of [["electron", "main.ts"], ["electron", "handlers", "sessionHandlers.ts"]]) {
      const src = fs.readFileSync(path.join(ROOT, ...f), "utf8");
      expect(src).not.toMatch(/lookbackGrandfather|grandfatherLookback/);
    }
  });
});
