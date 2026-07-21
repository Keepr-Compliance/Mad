/**
 * Tests for AccountVerificationStep (BACKLOG-1383)
 *
 * Covers:
 * - Event-driven init: immediate verification when init already complete
 * - Event-driven init: subscribes and waits when init not complete
 * - Stage-appropriate messages shown during wait
 * - Verification failure with exponential backoff retry
 * - Max retries exhausted shows error UI with Try Again + Contact Support
 * - Cleanup on unmount
 *
 * @module onboarding/steps/__tests__/AccountVerificationStep.test
 */

import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import {
  AccountVerificationContent,
  meta,
} from "../AccountVerificationStep";

// =============================================================================
// MOCK SETUP
// =============================================================================

// Mock Sentry
jest.mock("@sentry/electron/renderer", () => ({
  addBreadcrumb: jest.fn(),
  setTag: jest.fn(),
  captureMessage: jest.fn(),
}));

// Mock logger
jest.mock("../../../../utils/logger", () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock sentryOnboarding
jest.mock("../../sentryOnboarding", () => ({
  classifyFailureReason: jest.fn().mockReturnValue("unknown"),
  reportOnboardingFailure: jest.fn(),
}));

import * as Sentry from "@sentry/electron/renderer";
import { reportOnboardingFailure } from "../../sentryOnboarding";

// =============================================================================
// HELPERS
// =============================================================================

type InitStageCallback = (event: {
  stage: string;
  progress?: number;
  message?: string;
  error?: { message: string; retryable: boolean };
}) => void;

let capturedInitStageCallback: InitStageCallback | null = null;
let capturedUnsubscribe: jest.Mock;

function setupInitStageMock(currentStage: string = "idle") {
  capturedInitStageCallback = null;
  capturedUnsubscribe = jest.fn();

  window.api.system.getInitStage = jest.fn().mockResolvedValue({
    stage: currentStage,
  });

  window.api.system.onInitStage = jest.fn().mockImplementation((callback: InitStageCallback) => {
    capturedInitStageCallback = callback;
    return capturedUnsubscribe;
  });
}

const defaultOnAction = jest.fn();

// =============================================================================
// TESTS
// =============================================================================

describe("AccountVerificationStep", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    capturedInitStageCallback = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // META TESTS
  // =========================================================================

  describe("meta", () => {
    it("has correct meta.id", () => {
      expect(meta.id).toBe("account-verification");
    });

    it("auto-advances (hideContinue)", () => {
      expect(meta.navigation?.hideContinue).toBe(true);
    });

    it("does not show back button", () => {
      expect(meta.navigation?.showBack).toBe(false);
    });

    it("cannot be skipped", () => {
      expect(meta.skip).toBeUndefined();
    });

    it("isComplete returns true when user is verified", () => {
      expect(meta.isComplete!({ isUserVerifiedInLocalDb: true } as any)).toBe(true);
    });

    it("isComplete returns false when user is not verified", () => {
      expect(meta.isComplete!({ isUserVerifiedInLocalDb: false } as any)).toBe(false);
    });
  });

  // =========================================================================
  // INIT ALREADY COMPLETE ON MOUNT
  // =========================================================================

  describe("init already complete on mount", () => {
    it("proceeds immediately to verification when getInitStage returns 'complete'", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      window.api.system.verifyUserInLocalDb = jest.fn().mockResolvedValue({ success: true, userId: "u1" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Should show verifying state then success
      await waitFor(() => {
        expect(window.api.system.verifyUserInLocalDb).toHaveBeenCalled();
      });

      // Sentry breadcrumb for init already complete
      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "onboarding.init",
          message: "Init already complete on mount",
        })
      );
    });

    it("dispatches USER_VERIFIED_IN_LOCAL_DB after success", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      window.api.system.verifyUserInLocalDb = jest.fn().mockResolvedValue({ success: true, userId: "u1" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      await waitFor(() => {
        expect(screen.getByText("Account ready!")).toBeInTheDocument();
      });

      // Advance timers for MIN_DISPLAY_MS
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });

      expect(defaultOnAction).toHaveBeenCalledWith({ type: "USER_VERIFIED_IN_LOCAL_DB" });
    });
  });

  // =========================================================================
  // INIT NOT COMPLETE - SUBSCRIBES AND WAITS
  // =========================================================================

  describe("init not complete on mount - subscribes to events", () => {
    it("shows waiting-for-init state when init is not complete", async () => {
      setupInitStageMock("db-opening");

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Should subscribe to events
      expect(window.api.system.onInitStage).toHaveBeenCalled();

      // Should show initializing state
      expect(screen.getByText("Initializing...")).toBeInTheDocument();
    });

    it("shows stage-appropriate messages", async () => {
      setupInitStageMock("idle");

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Simulate stage events
      await act(async () => {
        capturedInitStageCallback?.({ stage: "db-opening" });
      });
      expect(screen.getByText("Opening secure database...")).toBeInTheDocument();

      await act(async () => {
        capturedInitStageCallback?.({ stage: "migrating" });
      });
      expect(screen.getByText("Updating database...")).toBeInTheDocument();

      await act(async () => {
        capturedInitStageCallback?.({ stage: "creating-user" });
      });
      expect(screen.getByText("Setting up your account...")).toBeInTheDocument();
    });

    it("starts verification when 'complete' event arrives", async () => {
      setupInitStageMock("db-opening");
      window.api.system.verifyUserInLocalDb = jest.fn().mockResolvedValue({ success: true, userId: "u1" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Simulate complete event
      await act(async () => {
        capturedInitStageCallback?.({ stage: "complete" });
      });

      await waitFor(() => {
        expect(window.api.system.verifyUserInLocalDb).toHaveBeenCalled();
      });

      // Should have cleaned up the subscription
      expect(capturedUnsubscribe).toHaveBeenCalled();
    });

    it("logs Sentry breadcrumb for each stage received while waiting", async () => {
      setupInitStageMock("idle");

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      await act(async () => {
        capturedInitStageCallback?.({ stage: "db-opening" });
      });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "onboarding.init",
          message: expect.stringContaining("db-opening"),
        })
      );
    });
  });

  // =========================================================================
  // VERIFICATION FAILURE WITH RETRY BACKOFF
  // =========================================================================

  describe("verification failure with exponential backoff", () => {
    it("retries with exponential backoff on failure", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });

      let callCount = 0;
      window.api.system.verifyUserInLocalDb = jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.resolve({ success: false, error: "DB not ready" });
        }
        return Promise.resolve({ success: true, userId: "u1" });
      });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // First call should happen immediately
      expect(window.api.system.verifyUserInLocalDb).toHaveBeenCalledTimes(1);

      // Advance past first backoff (~1s + jitter)
      await act(async () => {
        jest.advanceTimersByTime(1600);
      });
      expect(window.api.system.verifyUserInLocalDb).toHaveBeenCalledTimes(2);

      // Advance past second backoff (~2s + jitter)
      await act(async () => {
        jest.advanceTimersByTime(2600);
      });
      expect(window.api.system.verifyUserInLocalDb).toHaveBeenCalledTimes(3);

      // Third attempt succeeds
      await waitFor(() => {
        expect(screen.getByText("Account ready!")).toBeInTheDocument();
      });
    });

    it("logs Sentry breadcrumbs for retry attempts", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      window.api.system.verifyUserInLocalDb = jest
        .fn()
        .mockResolvedValueOnce({ success: false, error: "DB not ready" })
        .mockResolvedValue({ success: true, userId: "u1" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Check first attempt breadcrumb
      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "onboarding.verification",
          message: expect.stringContaining("Verification attempt 1"),
        })
      );

      // Check retry breadcrumb (failed, will retry)
      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "onboarding.verification",
          message: expect.stringContaining("will retry"),
          level: "warning",
        })
      );
    });
  });

  // =========================================================================
  // MAX RETRIES EXHAUSTED
  // =========================================================================

  describe("max retries exhausted", () => {
    it("shows error UI with Try Again and Contact Support buttons", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      window.api.system.verifyUserInLocalDb = jest
        .fn()
        .mockResolvedValue({ success: false, error: "DB not ready" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Advance through all retries (1s, 2s, 4s + jitter each)
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          jest.advanceTimersByTime(5000);
        });
      }

      await waitFor(() => {
        expect(screen.getByText("Setup failed")).toBeInTheDocument();
      });

      expect(screen.getByText("Try Again")).toBeInTheDocument();
      expect(screen.getByText("Contact Support")).toBeInTheDocument();
    });

    it("reports to Sentry after final failure", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      window.api.system.verifyUserInLocalDb = jest
        .fn()
        .mockResolvedValue({ success: false, error: "DB not ready" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Advance through all retries
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          jest.advanceTimersByTime(5000);
        });
      }

      await waitFor(() => {
        expect(Sentry.captureMessage).toHaveBeenCalledWith(
          "Account verification failed after max retries",
          expect.objectContaining({
            level: "error",
            tags: expect.objectContaining({
              step: "account_verification",
              onboarding_phase: "verification",
            }),
          })
        );
      });

      expect(reportOnboardingFailure).toHaveBeenCalled();
    });

    it("Try Again button restarts verification", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      window.api.system.verifyUserInLocalDb = jest
        .fn()
        .mockResolvedValue({ success: false, error: "DB not ready" });

      const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Advance through all retries
      for (let i = 0; i < 3; i++) {
        await act(async () => {
          jest.advanceTimersByTime(5000);
        });
      }

      await waitFor(() => {
        expect(screen.getByText("Try Again")).toBeInTheDocument();
      });

      // Reset mock to succeed
      window.api.system.verifyUserInLocalDb = jest
        .fn()
        .mockResolvedValue({ success: true, userId: "u1" });

      await user.click(screen.getByText("Try Again"));

      await waitFor(() => {
        expect(screen.getByText("Account ready!")).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // TRANSIENT "DB STARTING UP" RESPONSE (BACKLOG-2149)
  // =========================================================================

  describe("transient DB-starting-up response (BACKLOG-2149)", () => {
    it("shows a 'starting up' state (not 'Setup failed') on a transient response", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      window.api.system.verifyUserInLocalDb = jest
        .fn()
        .mockResolvedValue({ success: false, transient: true, retryable: true, error: "Database is starting up" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      await waitFor(() => {
        expect(window.api.system.verifyUserInLocalDb).toHaveBeenCalled();
      });

      // Calm "starting up" copy, NOT the terminal failure.
      await waitFor(() => {
        expect(screen.getByText("Starting up your secure database...")).toBeInTheDocument();
      });
      expect(screen.queryByText("Setup failed")).not.toBeInTheDocument();
    });

    it("does NOT escalate to 'Setup failed' even after many transient retries", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      window.api.system.verifyUserInLocalDb = jest
        .fn()
        .mockResolvedValue({ success: false, transient: true, retryable: true, error: "Database is starting up" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Far more than MAX_RETRIES worth of cycles — transient never terminates.
      for (let i = 0; i < 8; i++) {
        await act(async () => {
          jest.advanceTimersByTime(5000);
        });
      }

      expect(screen.queryByText("Setup failed")).not.toBeInTheDocument();
      // Should not have reported a terminal onboarding failure.
      expect(reportOnboardingFailure).not.toHaveBeenCalled();
    });

    it("recovers to success when the DB finishes starting up", async () => {
      window.api.system.getInitStage = jest.fn().mockResolvedValue({ stage: "complete" });
      // First a transient response, then success.
      window.api.system.verifyUserInLocalDb = jest
        .fn()
        .mockResolvedValueOnce({ success: false, transient: true, retryable: true, error: "Database is starting up" })
        .mockResolvedValue({ success: true, userId: "u1" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      // Advance the transient backoff so the retry fires.
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });

      await waitFor(() => {
        expect(screen.getByText("Account ready!")).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // CLEANUP ON UNMOUNT
  // =========================================================================

  describe("cleanup on unmount", () => {
    it("cleans up init stage subscription on unmount", async () => {
      setupInitStageMock("db-opening");

      let unmount: () => void;
      await act(async () => {
        const result = render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
        unmount = result.unmount;
      });

      // Verify subscription was created
      expect(window.api.system.onInitStage).toHaveBeenCalled();

      // Unmount
      act(() => {
        unmount();
      });

      // Cleanup should have been called
      expect(capturedUnsubscribe).toHaveBeenCalled();
    });

    it("does not update state after unmount", async () => {
      setupInitStageMock("db-opening");

      let unmount: () => void;
      await act(async () => {
        const result = render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
        unmount = result.unmount;
      });

      act(() => {
        unmount();
      });

      // Triggering callback after unmount should not cause errors
      // (mountedRef.current = false guards all state updates)
      expect(() => {
        capturedInitStageCallback?.({ stage: "complete" });
      }).not.toThrow();
    });
  });

  // =========================================================================
  // BACKWARD COMPATIBILITY
  // =========================================================================

  describe("backward compatibility", () => {
    it("falls back to direct verification when onInitStage is unavailable", async () => {
      window.api.system.getInitStage = jest.fn().mockRejectedValue(new Error("Not available"));
      window.api.system.onInitStage = undefined as any;
      window.api.system.verifyUserInLocalDb = jest.fn().mockResolvedValue({ success: true, userId: "u1" });

      await act(async () => {
        render(
          <AccountVerificationContent
            context={{} as any}
            onAction={defaultOnAction}
          />
        );
      });

      await waitFor(() => {
        expect(window.api.system.verifyUserInLocalDb).toHaveBeenCalled();
      });
    });
  });
});
