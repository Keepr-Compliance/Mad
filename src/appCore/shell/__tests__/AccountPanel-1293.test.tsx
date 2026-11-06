/**
 * BACKLOG-1293 — the app version at the bottom of the account side panel.
 *
 * The fixture mirrors what the "get-app-info" handler returns
 * (electron/handlers/permissionHandlers.ts): { name, version, path, pid }.
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AccountPanel } from "../AccountPanel";
import type { AppStateMachine } from "../../state/types";

jest.mock("../../../contexts/LicenseContext", () => ({
  useLicense: () => ({ licenseType: "individual" }),
}));
jest.mock("../../../hooks/useFeatureGate", () => ({
  useFeatureGate: () => ({ isAllowed: () => true }),
}));
jest.mock("../../../hooks/useStrictFeatureState", () => ({
  useStrictFeatureState: () => "allowed",
}));

function makeApp(): AppStateMachine {
  return {
    modalState: { showProfile: true },
    currentUser: {
      // pii-allow-uuid: invented all-zero fixture id, not from any live row
      id: "00000000-0000-0000-0000-000000000001",
      email: "avery@example.com",
      display_name: "Avery Example",
    },
    closeProfile: jest.fn(),
    openSettings: jest.fn(),
    handleLogout: jest.fn(),
  } as unknown as AppStateMachine;
}

const getAppInfo = () => window.api.system.getAppInfo as jest.Mock;

describe("AccountPanel version label (BACKLOG-1293)", () => {
  it("shows 'Keepr <version>' at the bottom of the panel", async () => {
    getAppInfo().mockResolvedValue({ name: "keepr", version: "2.46.2", path: "/x", pid: 1 });
    render(<AccountPanel app={makeApp()} />);
    const label = await screen.findByTestId("account-panel-version");
    expect(label).toHaveTextContent("Keepr 2.46.2");
    // Below Sign out, inside the pinned footer.
    expect(screen.getByTestId("account-panel-footer")).toContainElement(label);
  });

  it("renders nothing when the read fails", async () => {
    getAppInfo().mockRejectedValue(new Error("ipc down"));
    render(<AccountPanel app={makeApp()} />);
    await waitFor(() => expect(getAppInfo()).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("account-panel-version")).toBeNull();
    expect(screen.queryByText(/^Keepr/)).toBeNull();
  });

  it("renders nothing when no version comes back", async () => {
    getAppInfo().mockResolvedValue({ name: "keepr", path: "/x", pid: 1 });
    render(<AccountPanel app={makeApp()} />);
    await waitFor(() => expect(getAppInfo()).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByTestId("account-panel-version")).toBeNull();
  });

  it("renders nothing while the version is loading", () => {
    getAppInfo().mockReturnValue(new Promise(() => {}));
    render(<AccountPanel app={makeApp()} />);
    expect(screen.queryByTestId("account-panel-version")).toBeNull();
  });
});
