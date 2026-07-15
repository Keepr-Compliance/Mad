/**
 * Unit tests for tour steps configuration
 * Tests that all tour steps have proper configuration to prevent beacon display
 */

import {
  getDashboardTourSteps,
  JOYRIDE_STYLES,
  JOYRIDE_LOCALE,
} from "../tourSteps";

// Mock window.api.notification for notification step tests
beforeEach(() => {
  (globalThis as Record<string, unknown>).window = {
    api: {
      notification: {
        send: jest.fn().mockResolvedValue({ success: true }),
        isSupported: jest.fn().mockResolvedValue({ success: true, supported: false }),
      },
      system: {
        platform: "darwin",
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
});

describe("tourSteps configuration", () => {
  describe("getDashboardTourSteps", () => {
    it("should return an array of steps", () => {
      const steps = getDashboardTourSteps(true);
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
    });

    it("should have disableBeacon set to true on ALL steps to prevent blue dot from appearing", () => {
      const steps = getDashboardTourSteps(true);
      steps.forEach((step) => {
        expect(step.disableBeacon).toBe(true);
      });
    });

    it("should have required properties on each step", () => {
      const steps = getDashboardTourSteps(true);
      steps.forEach((step) => {
        expect(step).toHaveProperty("target");
        expect(step).toHaveProperty("content");
        expect(step).toHaveProperty("placement");
      });
    });

    it("should include AI detection step when hasAIAddon is true", () => {
      const steps = getDashboardTourSteps(true);
      const aiStep = steps.find((s) => s.target === '[data-tour="ai-detection-status"]');
      expect(aiStep).toBeDefined();
    });

    it("should exclude AI detection step when hasAIAddon is false", () => {
      const steps = getDashboardTourSteps(false);
      const aiStep = steps.find((s) => s.target === '[data-tour="ai-detection-status"]');
      expect(aiStep).toBeUndefined();
    });

    it("should accept options object for backward compatibility with boolean", () => {
      const stepsBoolean = getDashboardTourSteps(true);
      const stepsOptions = getDashboardTourSteps({
        hasAIAddon: true,
        isMacOS: false,
        notificationsEnabled: true,
      });
      // Both should have the same step count (no notification step since not macOS/enabled)
      expect(stepsBoolean.length).toBe(stepsOptions.length);
    });
  });

  describe("notification permission step", () => {
    it("should include notification step on macOS when notifications are not enabled", () => {
      const stepsWithNotification = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: true,
        notificationsEnabled: false,
        hasSyncVisible: true,
      });
      const stepsWithout = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
        hasSyncVisible: true,
      });
      expect(stepsWithNotification.length).toBe(stepsWithout.length + 1);
    });

    it("should NOT include notification step on Windows", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: false,
        hasSyncVisible: true,
      });
      const macSteps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: true,
        notificationsEnabled: false,
        hasSyncVisible: true,
      });
      expect(macSteps.length).toBe(steps.length + 1);
    });

    it("should NOT include notification step when notifications are already enabled", () => {
      const stepsEnabled = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: true,
        notificationsEnabled: true,
        hasSyncVisible: true,
      });
      const stepsDisabled = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: true,
        notificationsEnabled: false,
        hasSyncVisible: true,
      });
      expect(stepsDisabled.length).toBe(stepsEnabled.length + 1);
    });

    it("should place notification step after sync-status step", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: true,
        notificationsEnabled: false,
        hasSyncVisible: true,
      });
      // Step 0: welcome (body), Step 1: sync-status, Step 2: notification (also targets sync-status)
      expect(steps[1].target).toBe('[data-tour="sync-status"]');
      expect(steps[2].target).toBe('[data-tour="sync-status"]');
      // Step 3 should be new-audit-card
      expect(steps[3].target).toBe('[data-tour="new-audit-card"]');
    });

    it("should have disableBeacon on notification step", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: true,
        notificationsEnabled: false,
        hasSyncVisible: true,
      });
      // The notification step is at index 2
      expect(steps[2].disableBeacon).toBe(true);
    });

    it("notification step content should be a React element (not a string)", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: true,
        notificationsEnabled: false,
        hasSyncVisible: true,
      });
      // The notification step is at index 2
      expect(typeof steps[2].content).not.toBe("string");
    });

    it("should default to no notification step when using boolean signature", () => {
      // Boolean signature defaults isMacOS=false, notificationsEnabled=true
      const stepsBoolean = getDashboardTourSteps(false);
      const stepsNoNotif = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
      });
      expect(stepsBoolean.length).toBe(stepsNoNotif.length);
    });
  });

  describe("sync-status tour step", () => {
    it("should include sync-status step when hasSyncVisible is true", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
        hasSyncVisible: true,
      });
      const syncStep = steps.find((s) => s.target === '[data-tour="sync-status"]');
      expect(syncStep).toBeDefined();
    });

    it("should exclude sync-status step when hasSyncVisible is false", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
        hasSyncVisible: false,
      });
      const syncStep = steps.find((s) => s.target === '[data-tour="sync-status"]');
      expect(syncStep).toBeUndefined();
    });

    it("should exclude sync-status step when hasSyncVisible is undefined", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
      });
      const syncStep = steps.find((s) => s.target === '[data-tour="sync-status"]');
      expect(syncStep).toBeUndefined();
    });
  });

  describe("iPhone sync tour step", () => {
    it("should include iPhone sync step when hasIPhoneSync is true", () => {
      const stepsWithSync = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
        hasIPhoneSync: true,
      });
      const stepsWithout = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
        hasIPhoneSync: false,
      });
      expect(stepsWithSync.length).toBe(stepsWithout.length + 1);
    });

    it("should NOT include iPhone sync step when hasIPhoneSync is false", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
        hasIPhoneSync: false,
      });
      const syncStep = steps.find((s) => s.target === '[data-tour="sync-phone-card"]');
      expect(syncStep).toBeUndefined();
    });

    it("should target sync-phone-card element", () => {
      const steps = getDashboardTourSteps({
        hasAIAddon: false,
        isMacOS: false,
        notificationsEnabled: true,
        hasIPhoneSync: true,
      });
      const syncStep = steps.find((s) => s.target === '[data-tour="sync-phone-card"]');
      expect(syncStep).toBeDefined();
      expect(syncStep?.disableBeacon).toBe(true);
    });
  });

  describe("JOYRIDE_STYLES", () => {
    it("should have primary color defined", () => {
      expect(JOYRIDE_STYLES.options.primaryColor).toBe("#3b82f6");
    });

    it("should have high z-index for overlay", () => {
      expect(JOYRIDE_STYLES.options.zIndex).toBe(10000);
    });
  });

  describe("JOYRIDE_LOCALE", () => {
    it("should have custom last button text", () => {
      expect(JOYRIDE_LOCALE.last).toBe("Done");
    });
  });
});
