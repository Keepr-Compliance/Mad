/**
 * Tests for firewallService (BACKLOG-2348).
 *
 * Covers the platform-independent surface: the output parser and the
 * non-Windows short-circuit. The live PowerShell query is verified manually on
 * Windows — it is intentionally not exercised here to keep the suite
 * deterministic across macOS/Windows/Linux CI.
 */

import {
  parseFirewallOutput,
  checkInboundFirewallAllowed,
} from "../firewallService";

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe("firewallService", () => {
  describe("parseFirewallOutput", () => {
    it("returns true for ALLOWED (with surrounding whitespace/newlines)", () => {
      expect(parseFirewallOutput("ALLOWED\r\n")).toBe(true);
      expect(parseFirewallOutput("  ALLOWED  ")).toBe(true);
    });

    it("is case-insensitive", () => {
      expect(parseFirewallOutput("allowed")).toBe(true);
    });

    it("returns false for BLOCKED", () => {
      expect(parseFirewallOutput("BLOCKED\n")).toBe(false);
    });

    it("returns false for empty or unexpected output", () => {
      expect(parseFirewallOutput("")).toBe(false);
      expect(parseFirewallOutput("something else")).toBe(false);
    });
  });

  describe("checkInboundFirewallAllowed", () => {
    it("short-circuits to allowed:true, checked:false on non-Windows", async () => {
      const result = await checkInboundFirewallAllowed({
        platform: "darwin",
        execPath: "/Applications/Keepr.app/Contents/MacOS/Keepr",
      });
      expect(result).toEqual({ allowed: true, checked: false });
    });

    it("short-circuits on linux too", async () => {
      const result = await checkInboundFirewallAllowed({ platform: "linux" });
      expect(result).toEqual({ allowed: true, checked: false });
    });
  });
});
