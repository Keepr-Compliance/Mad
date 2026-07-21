/**
 * Tests for onboarding step components
 *
 * @module onboarding/__tests__/steps.test
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import PhoneTypeStep from "../steps/PhoneTypeStep";
import PermissionsStep from "../steps/PermissionsStep";
import type { OnboardingContext, StepAction } from "../types";

// Mock context for testing - matches OnboardingContext interface
const createMockContext = (
  overrides: Partial<OnboardingContext> = {}
): OnboardingContext => ({
  phoneType: null,
  emailConnected: false,
  connectedEmail: null,
  emailSkipped: false,
  driverSkipped: false,
  driverSetupComplete: false,
  permissionsGranted: false,
  termsAccepted: true,
  emailProvider: null,
  authProvider: "google",
  isNewUser: true,
  isDatabaseInitialized: false,
  platform: "macos",
  userId: null,
  isUserVerifiedInLocalDb: false,
  isResumedFromFdaRelaunch: false,
  ...overrides,
});

describe("PhoneTypeStep", () => {
  describe("meta", () => {
    it("has correct meta.id", () => {
      expect(PhoneTypeStep.meta.id).toBe("phone-type");
    });

    it("has progress label", () => {
      expect(PhoneTypeStep.meta.progressLabel).toBe("Phone Type");
    });

    it("supports both platforms", () => {
      expect(PhoneTypeStep.meta.platforms).toContain("macos");
      expect(PhoneTypeStep.meta.platforms).toContain("windows");
    });

    it("hides back button (first step)", () => {
      expect(PhoneTypeStep.meta.navigation?.showBack).toBe(false);
    });

    it("hides continue button (auto-advances)", () => {
      expect(PhoneTypeStep.meta.navigation?.hideContinue).toBe(true);
    });

    describe("isStepComplete", () => {
      it("returns false when no phone selected", () => {
        const context = createMockContext({ phoneType: null });
        expect(PhoneTypeStep.meta.isStepComplete?.(context)).toBe(false);
      });

      it("returns true when iPhone selected", () => {
        const context = createMockContext({ phoneType: "iphone" });
        expect(PhoneTypeStep.meta.isStepComplete?.(context)).toBe(true);
      });

      it("returns true when Android selected", () => {
        const context = createMockContext({ phoneType: "android" });
        expect(PhoneTypeStep.meta.isStepComplete?.(context)).toBe(true);
      });
    });
  });

  describe("Content", () => {
    it("renders phone selection cards", () => {
      const onAction = jest.fn();
      render(
        <PhoneTypeStep.Content
          context={createMockContext()}
          onAction={onAction}
        />
      );
      expect(screen.getByText("iPhone")).toBeInTheDocument();
      expect(screen.getByText("Android")).toBeInTheDocument();
    });

    it("renders heading", () => {
      render(
        <PhoneTypeStep.Content
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );
      expect(
        screen.getByRole("heading", { name: /What phone do you use/i })
      ).toBeInTheDocument();
    });

    it("fires SELECT_PHONE action with iphone on iPhone click", () => {
      const onAction = jest.fn();
      render(
        <PhoneTypeStep.Content
          context={createMockContext()}
          onAction={onAction}
        />
      );

      fireEvent.click(screen.getByText("iPhone"));

      expect(onAction).toHaveBeenCalledWith({
        type: "SELECT_PHONE",
        payload: { phoneType: "iphone" },
      });
    });

    it("fires SELECT_PHONE action with android on Android click", () => {
      const onAction = jest.fn();
      render(
        <PhoneTypeStep.Content
          context={createMockContext()}
          onAction={onAction}
        />
      );

      fireEvent.click(screen.getByText("Android"));

      expect(onAction).toHaveBeenCalledWith({
        type: "SELECT_PHONE",
        payload: { phoneType: "android" },
      });
    });

    it("shows iPhone as selected when context has iphone", () => {
      render(
        <PhoneTypeStep.Content
          context={createMockContext({ phoneType: "iphone" })}
          onAction={jest.fn()}
        />
      );

      // iPhone card should have selected styling (border-blue-500)
      const iphoneButton = screen.getByText("iPhone").closest("button");
      expect(iphoneButton).toHaveClass("border-blue-500");
    });

    it("shows Android as selected when context has android", () => {
      render(
        <PhoneTypeStep.Content
          context={createMockContext({ phoneType: "android" })}
          onAction={jest.fn()}
        />
      );

      // Android card should have selected styling (border-green-500)
      const androidButton = screen.getByText("Android").closest("button");
      expect(androidButton).toHaveClass("border-green-500");
    });

    it("renders privacy info box", () => {
      render(
        <PhoneTypeStep.Content
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

      expect(
        screen.getByText(/Your phone data stays private and secure/i)
      ).toBeInTheDocument();
    });

    it("has two clickable buttons", () => {
      render(
        <PhoneTypeStep.Content
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBe(2);
    });
  });
});

describe("PermissionsStep", () => {
  describe("meta.shouldShow", () => {
    it("returns true when permissions not yet granted", () => {
      const context = createMockContext({ permissionsGranted: false });
      expect(PermissionsStep.meta.shouldShow?.(context)).toBe(true);
    });

    it("returns false when permissions already granted (returning user)", () => {
      const context = createMockContext({ permissionsGranted: true });
      expect(PermissionsStep.meta.shouldShow?.(context)).toBe(false);
    });
  });

  describe("meta", () => {
    it("has correct meta.id", () => {
      expect(PermissionsStep.meta.id).toBe("permissions");
    });

    it("is macOS only", () => {
      expect(PermissionsStep.meta.platforms).toContain("macos");
      expect(PermissionsStep.meta.platforms).not.toContain("windows");
    });
  });

  // BACKLOG-1816: FDA one-toggle UX. Keepr auto-lists in Full Disk Access
  // (handleOpenSystemSettings/mount call triggerFullDiskAccess()), so the copy
  // describes flipping the toggle.
  //
  // BACKLOG-1842 (resume-at-step fix round, founder QA correction): the
  // pre-listing is best-effort, not guaranteed — a fresh/ad-hoc build can
  // fail to register, or the founder's live test found Keepr genuinely
  // absent from the list. Copy must therefore handle BOTH cases (in the
  // list -> toggle it; not in the list -> use + / drag to add manually) and
  // must NEVER assert unconditional presence in the list.
  describe("Content copy (one-toggle FDA flow)", () => {
    const renderContent = () =>
      render(
        <PermissionsStep.Content
          context={createMockContext()}
          onAction={jest.fn()}
        />
      );

    it("guides the user to find Keepr in the list AND flip its toggle -- without asserting unconditional presence", () => {
      const { container } = renderContent();
      const text = container.textContent ?? "";
      // Copy spans <strong> tags, so assert against normalized text content.
      expect(text).toMatch(/find.*keepr.*in the.*full disk access.*list/i);
      // Toggle-on guidance is present.
      expect(text).toMatch(/switch its toggle/i);
      // Must NOT claim Keepr is unconditionally already listed (the
      // BACKLOG-1842 founder-QA regression: pre-listing can fail).
      expect(text).not.toMatch(/is already in the/i);
    });

    it("covers the not-in-the-list case with the + / drag-in manual-add guidance", () => {
      const { container } = renderContent();
      const text = container.textContent ?? "";
      expect(text).toMatch(/don.t see keepr listed/i);
      expect(text).toMatch(/click the.*\+.*button.*to add it manually|drag the keepr app in/i);
      expect(text).toMatch(/this copy of keepr/i);
    });

    it("triggers Full Disk Access on mount so Keepr is pre-listed", () => {
      renderContent();
      expect(
        window.api.system.triggerFullDiskAccess
      ).toHaveBeenCalled();
    });
  });
});

describe("PhoneTypeStep shouldShow (TASK-955)", () => {
  it("returns true when phone type not selected", () => {
    const context = createMockContext({ phoneType: null });
    expect(PhoneTypeStep.meta.shouldShow?.(context)).toBe(true);
  });

  it("returns false when phone type already selected (returning user)", () => {
    const context = createMockContext({ phoneType: "iphone" });
    expect(PhoneTypeStep.meta.shouldShow?.(context)).toBe(false);
  });
});

describe("Step Registry", () => {
  it("all registered steps have required properties", () => {
    // Import from steps/index to ensure all steps are loaded
    const { STEP_REGISTRY } = require("../steps");

    for (const [id, step] of Object.entries(STEP_REGISTRY)) {
      // Meta should exist and have required fields
      expect(step).toHaveProperty("meta");
      expect((step as any).meta).toHaveProperty("id");
      expect((step as any).meta.id).toBe(id);
      expect((step as any).meta).toHaveProperty("progressLabel");
      expect((step as any).meta).toHaveProperty("platforms");

      // Content should be a component function
      expect(step).toHaveProperty("Content");
      expect(typeof (step as any).Content).toBe("function");
    }
  });

  it("all steps have non-empty platforms array", () => {
    const { STEP_REGISTRY } = require("../steps");

    for (const [_id, step] of Object.entries(STEP_REGISTRY)) {
      const platforms = (step as any).meta.platforms;
      expect(platforms).toBeDefined();
      expect(Array.isArray(platforms)).toBe(true);
      expect(platforms.length).toBeGreaterThan(0);
    }
  });
});
