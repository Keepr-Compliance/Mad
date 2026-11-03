/**
 * BACKLOG-3964 slice 3a — AccountAvatar never distorts (control C8).
 * jsdom has no layout, so the classes that hold the circle's shape are pinned;
 * real pixels are checked in the built-app cell (H7).
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AccountAvatar } from "../AccountAvatar";

const LONG_NAME = `${"Bartholomew ".repeat(16)}Longname`.trim(); // ~200 characters

describe("AccountAvatar", () => {
  it.each([32, 40] as const)("keeps a fixed, square, non-shrinking %ipx circle next to a very long name", (size) => {
    render(
      <div className="flex w-40">
        <AccountAvatar size={size} name={LONG_NAME} email="x@y.z" />
        <span className="truncate">{LONG_NAME}</span>
      </div>,
    );
    const avatar = screen.getByTestId("account-avatar");
    expect(avatar).toHaveClass("shrink-0", "aspect-square", "rounded-full", "overflow-hidden", "bg-primary-600");
    expect(avatar).toHaveClass(size === 32 ? "h-8" : "h-10", size === 32 ? "w-8" : "w-10");
    expect(avatar.className).not.toMatch(/gradient/);
    expect(avatar).toHaveTextContent(/^BB$/);
  });

  it("covers the circle with the photo, never stretching it", () => {
    render(<AccountAvatar name="Ann Lee" imageUrl="https://x/a.png" />);
    const img = screen.getByTestId("account-avatar").querySelector("img") as HTMLImageElement;
    expect(img).toHaveClass("h-full", "w-full", "object-cover");
    expect(img).toHaveAttribute("alt", "");
  });
});
