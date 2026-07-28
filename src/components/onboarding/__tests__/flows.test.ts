/**
 * Tests for onboarding flow utilities
 *
 * @module onboarding/__tests__/flows.test
 */

import {
  getFlowForPlatform,
  getFlowSteps,
  MACOS_FLOW_STEPS,
  WINDOWS_FLOW_STEPS,
} from "../flows";

describe("Onboarding Flows", () => {
  describe("getFlowForPlatform", () => {
    it("returns correct steps for macOS", () => {
      const steps = getFlowForPlatform("macos");
      expect(steps).toEqual(MACOS_FLOW_STEPS);
      expect(steps).toContain("phone-type");
      expect(steps).toContain("secure-storage");
      expect(steps).toContain("account-verification");
      expect(steps).toContain("email-connect");
      expect(steps).toContain("data-sync");
      expect(steps).toContain("permissions");
    });

    it("returns correct steps for Windows", () => {
      const steps = getFlowForPlatform("windows");
      expect(steps).toEqual(WINDOWS_FLOW_STEPS);
      expect(steps).toContain("phone-type");
      expect(steps).toContain("apple-driver");
      expect(steps).toContain("account-verification");
      expect(steps).toContain("email-connect");
      expect(steps).toContain("data-sync");
    });

    it("returns macOS flow for Linux", () => {
      const steps = getFlowForPlatform("linux");
      expect(steps).toEqual(MACOS_FLOW_STEPS);
    });

    it("phone-type is always the first step", () => {
      expect(getFlowForPlatform("macos")[0]).toBe("phone-type");
      expect(getFlowForPlatform("windows")[0]).toBe("phone-type");
    });

    // BACKLOG-2288: resolved platform flows must not surface the android setup
    // steps — Android users get into the app and set up sync in Settings (PR2).
    it("resolved flows exclude the android setup steps", () => {
      for (const platform of ["macos", "windows", "linux"] as const) {
        const steps = getFlowForPlatform(platform);
        expect(steps).not.toContain("android-download");
        expect(steps).not.toContain("android-coming-soon");
      }
    });
  });

  describe("getFlowSteps", () => {
    it("returns OnboardingStep objects for macOS", () => {
      const steps = getFlowSteps("macos");

      expect(steps.length).toBe(MACOS_FLOW_STEPS.length);
      expect(steps.map((s) => s.meta.id)).toEqual([...MACOS_FLOW_STEPS]);

      // Verify each step has required properties
      for (const step of steps) {
        expect(step.meta).toBeDefined();
        expect(step.meta.id).toBeDefined();
        expect(step.Content).toBeDefined();
        expect(typeof step.Content).toBe("function");
      }
    });

    it("returns OnboardingStep objects for Windows", () => {
      const steps = getFlowSteps("windows");

      expect(steps.length).toBe(WINDOWS_FLOW_STEPS.length);
      expect(steps.map((s) => s.meta.id)).toEqual([...WINDOWS_FLOW_STEPS]);
    });

    it("step order matches flow definition", () => {
      const macosSteps = getFlowSteps("macos");
      const macosIds = macosSteps.map((s) => s.meta.id);

      // Verify order matches exactly
      MACOS_FLOW_STEPS.forEach((id, index) => {
        expect(macosIds[index]).toBe(id);
      });
    });
  });

  describe("Flow Configuration", () => {
    // BACKLOG-1821: both flows gained the appended `data-source-floor` integrity
    // step. It is the LAST step and only becomes applicable when the user reached
    // the end with zero connected sources.
    // BACKLOG-2288: the `android-download` + `android-coming-soon` steps were
    // removed from both flows (macOS 10→8, Windows 9→7); Android companion sync
    // now happens later via the guided Settings flow.
    it("macOS flow has 8 steps", () => {
      expect(MACOS_FLOW_STEPS.length).toBe(8);
    });

    it("Windows flow has 7 steps", () => {
      expect(WINDOWS_FLOW_STEPS.length).toBe(7);
    });

    it("data-source-floor is the last step of both flows (BACKLOG-1821)", () => {
      expect(MACOS_FLOW_STEPS[MACOS_FLOW_STEPS.length - 1]).toBe("data-source-floor");
      expect(WINDOWS_FLOW_STEPS[WINDOWS_FLOW_STEPS.length - 1]).toBe("data-source-floor");
    });

    it("macOS includes secure-storage and permissions", () => {
      expect(MACOS_FLOW_STEPS).toContain("secure-storage");
      expect(MACOS_FLOW_STEPS).toContain("permissions");
    });

    it("Windows does not include secure-storage or permissions", () => {
      expect(WINDOWS_FLOW_STEPS).not.toContain("secure-storage");
      expect(WINDOWS_FLOW_STEPS).not.toContain("permissions");
    });

    it("Windows includes apple-driver", () => {
      expect(WINDOWS_FLOW_STEPS).toContain("apple-driver");
    });

    it("macOS does not include apple-driver", () => {
      expect(MACOS_FLOW_STEPS).not.toContain("apple-driver");
    });

    it("both flows include account-verification step", () => {
      expect(MACOS_FLOW_STEPS).toContain("account-verification");
      expect(WINDOWS_FLOW_STEPS).toContain("account-verification");
    });

    it("both flows include data-sync step", () => {
      expect(MACOS_FLOW_STEPS).toContain("data-sync");
      expect(WINDOWS_FLOW_STEPS).toContain("data-sync");
    });

    // BACKLOG-2288: android-download / android-coming-soon were removed from the
    // onboarding flows. Neither flow should contain them anymore; Android users
    // set up companion sync later via the guided Settings flow (BACKLOG-2227 PR2).
    it("neither flow includes android-download or android-coming-soon", () => {
      expect(MACOS_FLOW_STEPS).not.toContain("android-download");
      expect(MACOS_FLOW_STEPS).not.toContain("android-coming-soon");
      expect(WINDOWS_FLOW_STEPS).not.toContain("android-download");
      expect(WINDOWS_FLOW_STEPS).not.toContain("android-coming-soon");
    });

    // BACKLOG-2288: phone-type is immediately followed by the platform's first
    // setup step (secure-storage on macOS, apple-driver on Windows) now that the
    // android steps no longer sit between them.
    it("phone-type is immediately followed by the platform setup step", () => {
      const macosPhoneIndex = MACOS_FLOW_STEPS.indexOf("phone-type");
      expect(MACOS_FLOW_STEPS[macosPhoneIndex + 1]).toBe("secure-storage");

      const windowsPhoneIndex = WINDOWS_FLOW_STEPS.indexOf("phone-type");
      expect(WINDOWS_FLOW_STEPS[windowsPhoneIndex + 1]).toBe("apple-driver");
    });

    it("data-sync comes after email-connect", () => {
      const macosEmailIndex = MACOS_FLOW_STEPS.indexOf("email-connect");
      const macosSyncIndex = MACOS_FLOW_STEPS.indexOf("data-sync");
      expect(macosSyncIndex).toBeGreaterThan(macosEmailIndex);

      const windowsEmailIndex = WINDOWS_FLOW_STEPS.indexOf("email-connect");
      const windowsSyncIndex = WINDOWS_FLOW_STEPS.indexOf("data-sync");
      expect(windowsSyncIndex).toBeGreaterThan(windowsEmailIndex);
    });
  });
});
