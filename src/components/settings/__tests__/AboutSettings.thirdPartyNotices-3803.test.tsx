/**
 * BACKLOG-3803: Settings > About links to the bundled third-party notices.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { AboutSettings } from "../AboutSettings";

describe("AboutSettings third-party notices link (BACKLOG-3803)", () => {
  it("opens the bundled notices through the main process", () => {
    const open = window.api.shell.openThirdPartyNotices as jest.Mock;
    open.mockClear();
    render(<AboutSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Third-Party Notices" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith();
  });
});
