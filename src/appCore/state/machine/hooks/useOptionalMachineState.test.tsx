/**
 * useOptionalMachineState Tests
 *
 * Tests for the optional machine state hook that enables gradual migration.
 */

import React from "react";
import { renderHook } from "@testing-library/react";
import { useOptionalMachineState } from "./useOptionalMachineState";
import { AppStateProvider } from "../AppStateContext";
import type { AppState } from "../types";
import * as featureFlags from "../utils/featureFlags";

// Mock the feature flags module
jest.mock("../utils/featureFlags", () => ({
  isNewStateMachineEnabled: jest.fn(),
}));

const mockIsNewStateMachineEnabled = featureFlags.isNewStateMachineEnabled as jest.Mock;

describe("useOptionalMachineState", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("when feature flag is disabled", () => {
    beforeEach(() => {
      mockIsNewStateMachineEnabled.mockReturnValue(false);
    });

    it("returns null even when inside provider", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <AppStateProvider>{children}</AppStateProvider>
      );

      const { result } = renderHook(() => useOptionalMachineState(), {
        wrapper,
      });

      expect(result.current).toBeNull();
    });

    it("returns null when outside provider", () => {
      const { result } = renderHook(() => useOptionalMachineState());
      expect(result.current).toBeNull();
    });
  });

  describe("when feature flag is enabled", () => {
    beforeEach(() => {
      mockIsNewStateMachineEnabled.mockReturnValue(true);
    });

    it("returns context value when inside provider", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <AppStateProvider>{children}</AppStateProvider>
      );

      const { result } = renderHook(() => useOptionalMachineState(), {
        wrapper,
      });

      expect(result.current).not.toBeNull();
      expect(result.current?.state).toBeDefined();
      expect(result.current?.dispatch).toBeDefined();
      expect(result.current?.isLoading).toBe(true); // Initial state
    });

    it("returns null when outside provider", () => {
      const { result } = renderHook(() => useOptionalMachineState());
      expect(result.current).toBeNull();
    });

    it("returns correct state from provider", () => {
      const initialState: AppState = {
        status: "ready",
        user: { id: "test-id", email: "test@example.com" },
        platform: { isMacOS: true, isWindows: false, hasIPhone: true },
        userData: {
          phoneType: "iphone",
          hasCompletedEmailOnboarding: true,
          hasEmailConnected: true,
          needsDriverSetup: false,
          fda: "granted",
        },
      };

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <AppStateProvider initialState={initialState}>{children}</AppStateProvider>
      );

      const { result } = renderHook(() => useOptionalMachineState(), {
        wrapper,
      });

      expect(result.current?.state.status).toBe("ready");
      expect(result.current?.isReady).toBe(true);
      expect(result.current?.isLoading).toBe(false);
      expect(result.current?.currentUser?.email).toBe("test@example.com");
    });

    it("provides all context value properties", () => {
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <AppStateProvider>{children}</AppStateProvider>
      );

      const { result } = renderHook(() => useOptionalMachineState(), {
        wrapper,
      });

      // Verify all expected properties exist
      expect(result.current).toHaveProperty("state");
      expect(result.current).toHaveProperty("dispatch");
      expect(result.current).toHaveProperty("isLoading");
      expect(result.current).toHaveProperty("isReady");
      expect(result.current).toHaveProperty("currentUser");
      expect(result.current).toHaveProperty("platform");
      expect(result.current).toHaveProperty("loadingPhase");
      expect(result.current).toHaveProperty("onboardingStep");
      expect(result.current).toHaveProperty("error");
    });
  });

  describe("feature flag toggling", () => {
    it("responds to feature flag changes on re-render", () => {
      mockIsNewStateMachineEnabled.mockReturnValue(false);

      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <AppStateProvider>{children}</AppStateProvider>
      );

      const { result, rerender } = renderHook(() => useOptionalMachineState(), {
        wrapper,
      });

      expect(result.current).toBeNull();

      // Enable the feature flag
      mockIsNewStateMachineEnabled.mockReturnValue(true);
      rerender();

      expect(result.current).not.toBeNull();
    });
  });
});
