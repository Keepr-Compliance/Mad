/**
 * BACKLOG-3927: Settings > General in the Microsoft Store build has no in-app
 * updater controls (the Store delivers updates). The website build keeps them.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

jest.mock("@/hooks/useNotification", () => ({ useNotification: () => ({ notify: jest.fn() }) }));
jest.mock("../../../contexts/NetworkContext", () => ({ useNetwork: () => ({ isOnline: true }) }));

import { GeneralSettings } from "../GeneralSettings";

function setStoreFlag(value: boolean | undefined) {
  const system = (window.api as unknown as { system: Record<string, unknown> }).system;
  if (value === undefined) delete system.isStoreBuild;
  else system.isStoreBuild = value;
}
afterEach(() => setStoreFlag(undefined));

describe("GeneralSettings updates card (BACKLOG-3927)", () => {
  it("Store build: no Check for Updates button and no auto-download switch; says the Store updates Keepr", () => {
    setStoreFlag(true);
    render(<GeneralSettings userId="u1" initialPreferences={{}} />);
    expect(screen.queryByText("Check for Updates")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Auto-download updates" })).not.toBeInTheDocument();
    expect(screen.getByText("Keepr updates through the Microsoft Store.")).toBeInTheDocument();
  });

  it("website build: Check for Updates and the auto-download switch are shown", () => {
    setStoreFlag(false);
    render(<GeneralSettings userId="u1" initialPreferences={{}} />);
    expect(screen.getByText("Check for Updates")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Auto-download updates" })).toBeInTheDocument();
    expect(screen.queryByText("Keepr updates through the Microsoft Store.")).not.toBeInTheDocument();
  });
});
