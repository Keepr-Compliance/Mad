/**
 * BACKLOG-3363: Settings on a Windows on ARM PC.
 * - Sync Tools: no Install / Repair — the unsupported message instead.
 * - Import source (iPhone Sync selected): no connect / Trust steps — the
 *   unsupported message instead (C6). Uses the REAL PlatformProvider so the
 *   context wiring is exercised, not a mocked usePlatform.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { SyncToolsSettings } from "../SyncToolsSettings";
import { ImportSourceSettings } from "../ImportSourceSettings";
import { PlatformProvider } from "../../../contexts/PlatformContext";
import { WINDOWS_ARM64_UNSUPPORTED_HEADING } from "../../../constants/windowsArm64Copy";

type SystemApi = Record<string, unknown>;
const system = () => (window.api as unknown as { system: SystemApi }).system;
let savedPlatform: unknown;

function setHost(platform: string, arm: boolean | undefined) {
  system().platform = platform;
  if (arm === undefined) delete system().isWindowsArm64;
  else system().isWindowsArm64 = arm;
}

beforeEach(() => {
  savedPlatform = system().platform;
  (window.api.drivers!.checkApple as jest.Mock).mockResolvedValue({
    isInstalled: true,
    version: "1.0",
    serviceRunning: false,
    error: null,
  });
  jest.mocked(window.api.preferences.get).mockResolvedValue({
    success: true,
    preferences: { messages: { source: "iphone-sync" } },
  } as never);
});

afterEach(() => {
  system().platform = savedPlatform;
  delete system().isWindowsArm64;
});

describe("SyncToolsSettings on Windows on ARM (BACKLOG-3363)", () => {
  it("ARM: shows the unsupported message, no Install or Repair button", async () => {
    setHost("win32", true);
    render(<SyncToolsSettings />);
    expect(screen.getByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeInTheDocument();
    // Let the mount-time status check settle, then re-check.
    await waitFor(() => expect(window.api.drivers!.checkApple).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Install Sync Tools|Repair Installation/i })).toBeNull();
  });

  it("normal Windows PC: Repair button offered (installed, service stopped)", async () => {
    setHost("win32", false);
    render(<SyncToolsSettings />);
    expect(await screen.findByRole("button", { name: /Repair Installation/i })).toBeInTheDocument();
    expect(screen.queryByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeNull();
  });
});

describe("ImportSourceSettings on Windows on ARM (BACKLOG-3363 C6)", () => {
  it("ARM + iPhone Sync: unsupported text replaces the connect / Trust steps", async () => {
    setHost("win32", true);
    render(
      <PlatformProvider>
        <ImportSourceSettings userId="user-1" />
      </PlatformProvider>,
    );
    expect(await screen.findByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeInTheDocument();
    expect(screen.queryByText(/Connect your iPhone to this/i)).toBeNull();
    expect(screen.queryByText(/Trust this computer/i)).toBeNull();
  });

  it("normal Windows PC + iPhone Sync: connect / Trust steps shown", async () => {
    setHost("win32", false);
    render(
      <PlatformProvider>
        <ImportSourceSettings userId="user-1" />
      </PlatformProvider>,
    );
    expect(await screen.findByText(/Connect your iPhone to this PC/i)).toBeInTheDocument();
    expect(screen.queryByText(WINDOWS_ARM64_UNSUPPORTED_HEADING)).toBeNull();
  });
});
