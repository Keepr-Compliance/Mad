import React from "react";
import { render, screen } from "@testing-library/react";
import { ShellBanners } from "../ShellBanners";
import type { AppStateMachine } from "../../state/types";

jest.mock("../../../components/common/AtRestMigrationBanner", () => ({
  AtRestMigrationBanner: () => <div data-testid="at-rest-banner" />,
}));
jest.mock("../../../components/setup/ResumeSetupBanner", () => ({
  ResumeSetupBanner: () => null,
}));

const appAt = (currentStep: string) =>
  ({
    currentStep,
    isOnline: true,
    isChecking: false,
    handleRetryConnection: jest.fn(),
  }) as unknown as AppStateMachine;

describe("ShellBanners", () => {
  it("shows the migration banner when signed in", () => {
    render(<ShellBanners app={appAt("dashboard")} />);
    expect(screen.getByTestId("at-rest-banner")).toBeInTheDocument();
  });

  it("does not show the migration banner on the login screen", () => {
    render(<ShellBanners app={appAt("login")} />);
    expect(screen.queryByTestId("at-rest-banner")).toBeNull();
  });
});
