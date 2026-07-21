/**
 * LoadingScreen Tests (BACKLOG-1382)
 *
 * Tests for the LoadingScreen component, including:
 * - Default phase messages
 * - Init stage-specific messages when events are available
 * - Migration progress display
 * - Backward compatibility when no init stage events arrive
 *
 * @module appCore/state/machine/components/__tests__/LoadingScreen.test
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { LoadingScreen } from "../LoadingScreen";

// Mock OfflineNotice (not relevant to LoadingScreen logic)
jest.mock("../../../../../components/common/OfflineNotice", () => ({
  OfflineNotice: () => null,
}));

// Mock platformInit utility
jest.mock("../../utils/platformInit", () => ({
  getDbInitMessage: (platform: { isMacOS: boolean }) =>
    platform.isMacOS
      ? "Waiting for Keychain access..."
      : "Initializing secure database...",
}));

describe("LoadingScreen", () => {
  // ============================================
  // DEFAULT PHASE MESSAGES (backward compatibility)
  // ============================================

  describe("default phase messages (no init stage)", () => {
    it("shows checking storage message", () => {
      render(<LoadingScreen phase="checking-storage" />);
      expect(screen.getByText("Checking secure storage...")).toBeInTheDocument();
    });

    it("shows validating auth message", () => {
      render(<LoadingScreen phase="validating-auth" />);
      expect(screen.getByText("Verifying your account...")).toBeInTheDocument();
    });

    it("shows loading auth message", () => {
      render(<LoadingScreen phase="loading-auth" />);
      expect(screen.getByText("Loading authentication...")).toBeInTheDocument();
    });

    it("shows loading user data message", () => {
      render(<LoadingScreen phase="loading-user-data" />);
      expect(screen.getByText("Loading your data...")).toBeInTheDocument();
    });

    it("shows platform-specific message for initializing-db on macOS", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: true, isWindows: false }}
        />
      );
      expect(screen.getByText("Waiting for Keychain access...")).toBeInTheDocument();
    });

    it("shows platform-specific message for initializing-db on Windows", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: false, isWindows: true }}
        />
      );
      expect(screen.getByText("Initializing secure database...")).toBeInTheDocument();
    });
  });

  // ============================================
  // INIT STAGE MESSAGES (BACKLOG-1379)
  // ============================================

  describe("init stage-specific messages", () => {
    it("shows 'Checking security...' for db-opening stage", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: true, isWindows: false }}
          initStage="db-opening"
        />
      );
      expect(screen.getByText("Checking security...")).toBeInTheDocument();
    });

    it("shows 'Updating database...' for migrating stage without progress", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: true, isWindows: false }}
          initStage="migrating"
        />
      );
      expect(screen.getByText("Updating database...")).toBeInTheDocument();
    });

    it("shows 'Updating database... X%' for migrating stage with progress", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: true, isWindows: false }}
          initStage="migrating"
          migrationProgress={75}
        />
      );
      expect(screen.getByText("Updating database... 75%")).toBeInTheDocument();
    });

    it("shows 'Database ready...' for db-ready stage", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: true, isWindows: false }}
          initStage="db-ready"
        />
      );
      expect(screen.getByText("Database ready...")).toBeInTheDocument();
    });

    it("shows 'Finalizing setup...' for creating-user stage", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: true, isWindows: false }}
          initStage="creating-user"
        />
      );
      expect(screen.getByText("Finalizing setup...")).toBeInTheDocument();
    });

    it("shows 'Ready' for complete stage", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: true, isWindows: false }}
          initStage="complete"
        />
      );
      expect(screen.getByText("Ready")).toBeInTheDocument();
    });

    it("falls back to platform message for unknown init stage", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          platform={{ isMacOS: true, isWindows: false }}
          initStage="some-unknown-stage"
        />
      );
      // Should fall back to platform-specific message
      expect(screen.getByText("Waiting for Keychain access...")).toBeInTheDocument();
    });

    it("ignores initStage when not in initializing-db phase", () => {
      render(
        <LoadingScreen
          phase="loading-auth"
          initStage="db-opening"
        />
      );
      // Should show the phase message, not the init stage message
      expect(screen.getByText("Loading authentication...")).toBeInTheDocument();
    });
  });

  // ============================================
  // SPINNER (single loading indicator — BACKLOG-1842)
  // ============================================
  //
  // Previously this screen rendered a spinner AND a flat determinate
  // progress bar (`role="progressbar"`) simultaneously — two loading
  // indicators for one loading state. The progress bar was removed; the
  // spinner is the only indicator now, regardless of phase or progress props.

  describe("spinner", () => {
    it("always shows the loading spinner", () => {
      render(<LoadingScreen phase="checking-storage" />);
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("renders exactly one loading indicator, not a spinner plus a progress bar", () => {
      render(
        <LoadingScreen
          phase="initializing-db"
          progress={50}
          initStage="migrating"
          migrationProgress={60}
        />
      );
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("shows the spinner during awaiting-keychain phase too", () => {
      render(<LoadingScreen phase="awaiting-keychain" progress={50} />);
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
  });
});
