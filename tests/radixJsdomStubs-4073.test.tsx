/**
 * BACKLOG-4073 — the root jest setup (tests/setup.js) carries the four
 * Element stubs Radix needs under jsdom: hasPointerCapture,
 * setPointerCapture, releasePointerCapture and scrollIntoView.
 *
 * This opens a kit (@keepr/ui) Select with a pointer and picks an item, so a
 * removed stub reds here instead of in the first screen that adopts a kit
 * Select. A stub defined in one test file instead of tests/setup.js would
 * leave this file red.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@keepr/ui";

describe("BACKLOG-4073 — Radix stubs in tests/setup.js", () => {
  it("the four Element stubs are installed globally", () => {
    expect(typeof Element.prototype.hasPointerCapture).toBe("function");
    expect(typeof Element.prototype.setPointerCapture).toBe("function");
    expect(typeof Element.prototype.releasePointerCapture).toBe("function");
    expect(typeof Element.prototype.scrollIntoView).toBe("function");
  });

  it("a kit Select opens with a pointer and selects an item", async () => {
    const user = userEvent.setup();
    const onValueChange = jest.fn();
    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger aria-label="Status">
          <SelectValue placeholder="Choose a status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="open">Open</SelectItem>
          <SelectItem value="closed">Closed</SelectItem>
        </SelectContent>
      </Select>,
    );

    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Closed" }));

    expect(onValueChange).toHaveBeenCalledWith("closed");
  });
});
