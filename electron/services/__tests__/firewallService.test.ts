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

    it("returns allowed:true, checked:true when the query reports ALLOWED (win32)", async () => {
      const exec = jest.fn().mockResolvedValue("ALLOWED\r\n");
      const result = await checkInboundFirewallAllowed({
        platform: "win32",
        execPath: "C:/apps/keepr.exe",
        exec,
      });
      expect(result).toEqual({ allowed: true, checked: true });
      // The executable path is forwarded to the runner for the -Program filter.
      expect(exec).toHaveBeenCalledWith(expect.any(String), "C:/apps/keepr.exe");
    });

    it("returns allowed:false, checked:true when the query reports BLOCKED (win32)", async () => {
      const exec = jest.fn().mockResolvedValue("BLOCKED\n");
      const result = await checkInboundFirewallAllowed({
        platform: "win32",
        execPath: "C:/apps/keepr.exe",
        exec,
      });
      expect(result).toEqual({ allowed: false, checked: true });
    });

    it("fails safe to allowed:false, checked:false when the query errors/times out (win32)", async () => {
      // Safe default: on any failure we show the pre-warn rather than let the OS
      // prompt appear unexplained — this is the branch the feature's safety rests on.
      const exec = jest.fn().mockRejectedValue(new Error("ETIMEDOUT"));
      const result = await checkInboundFirewallAllowed({
        platform: "win32",
        execPath: "C:/apps/keepr.exe",
        exec,
      });
      expect(result).toEqual({ allowed: false, checked: false });
    });
  });
});
