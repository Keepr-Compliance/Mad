/**
 * Tests for AndroidSyncModal (BACKLOG-2320 launch + BACKLOG-2324 layout).
 *
 * Focus: the modal SHELL — that the guided wizard sits flush in a body with a
 * scroll affordance so tall content is never clipped/unreachable in a narrow or
 * short viewport (the pre-2324 bug: everything below "I've Installed It" was
 * unreachable because the modal body did not scroll). The wizard internals are
 * covered by AndroidSyncSetup.test.tsx and stubbed here.
 */

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { AndroidSyncModal } from "../AndroidSyncModal";

// Isolate the modal shell from the wizard (window.api / QR generation / timers).
jest.mock("../../../components/settings/android/AndroidSyncSetup", () => ({
  AndroidSyncSetup: ({ userId }: { userId: string }) => (
    <div data-testid="android-sync-setup-stub">wizard for {userId}</div>
  ),
}));

describe("AndroidSyncModal", () => {
  it("renders the wizard flush inside a scrollable body", () => {
    render(<AndroidSyncModal userId="user-1" onClose={jest.fn()} />);

    // The wizard is mounted in the modal body.
    expect(screen.getByTestId("android-sync-setup-stub")).toBeInTheDocument();

    // The body scrolls so nothing is unreachable in a narrow/short viewport.
    const body = screen.getByTestId("android-sync-modal-body");
    expect(body.className).toMatch(/overflow-y-auto/);
    // It is the flex-grow region (min-h-0 keeps the flex column scroll chain intact).
    expect(body.className).toMatch(/flex-1/);
    expect(body.className).toMatch(/min-h-0/);
  });

  it("calls onClose when the minimize button is clicked (sync preserved)", () => {
    const onClose = jest.fn();
    render(<AndroidSyncModal userId="user-1" onClose={onClose} />);

    fireEvent.click(screen.getByTitle(/Minimize/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
