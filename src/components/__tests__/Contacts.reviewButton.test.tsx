/**
 * BACKLOG-2410 — the review queue's entry point lives on Clients & Contacts.
 *
 * The founder was specific on both halves: the button belongs HERE and not in
 * Settings ("this is contact work, not configuration"), and it must be
 * discoverable WITHOUT being nagging — so it does not render at all when there
 * is nothing to review.
 */

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import Contacts from "../Contacts";

jest.mock("../../appCore", () => ({
  ...jest.requireActual("../../appCore"),
  useAppStateMachine: () => ({ isDatabaseInitialized: true }),
}));

jest.mock("../../contexts/NetworkContext", () => ({
  useNetwork: () => ({
    isOnline: true,
    isChecking: false,
    lastOnlineAt: null,
    lastOfflineAt: null,
    connectionError: null,
    checkConnection: jest.fn(),
    clearError: jest.fn(),
    setConnectionError: jest.fn(),
  }),
}));

type Listener = (event: { matches: boolean }) => void;

function installMatchMedia(narrow: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: narrow,
    media: "",
    addEventListener: (_e: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_e: string, cb: Listener) => listeners.delete(cb),
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
    onchange: null,
    dispatchEvent: () => true,
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = jest.fn().mockReturnValue(mql);
}

const USER = "user-123";

beforeEach(() => {
  jest.clearAllMocks();
  installMatchMedia(false);
  jest.mocked(window.api.contacts.getAll).mockResolvedValue({ success: true, contacts: [] });
  jest.mocked(window.api.contacts.getAvailable).mockResolvedValue({ success: true, contacts: [] });
  jest.mocked(window.api.contacts.getReviewQueue).mockResolvedValue({ success: true, clusters: [] });
});

describe("Contacts — review duplicates button", () => {
  /**
   * NEGATIVE CONTROL RUN: changed the gate to `reviewQueueCount !== null` (i.e.
   * always show once loaded). Observed: the "does not render" tests fail with a
   * "Review 0 possible duplicates" button — the permanent nag the founder ruled
   * out.
   */
  it("does not render when there is nothing to review", async () => {
    jest.mocked(window.api.contacts.getReviewQueueCount).mockResolvedValue({ success: true, count: 0 });

    render(<Contacts userId={USER} onClose={jest.fn()} />);

    await waitFor(() =>
      expect(window.api.contacts.getReviewQueueCount).toHaveBeenCalledWith(USER),
    );
    expect(screen.queryByTestId("review-duplicates-button")).toBeNull();
  });

  it("does not render when the count could not be read", async () => {
    jest.mocked(window.api.contacts.getReviewQueueCount).mockResolvedValue({
      success: false,
      error: "boom",
    });

    render(<Contacts userId={USER} onClose={jest.fn()} />);

    await waitFor(() =>
      expect(window.api.contacts.getReviewQueueCount).toHaveBeenCalledWith(USER),
    );
    // A wrong number on a review surface is worse than a missing button.
    expect(screen.queryByTestId("review-duplicates-button")).toBeNull();
  });

  it("shows the count, in the founder's wording", async () => {
    jest.mocked(window.api.contacts.getReviewQueueCount).mockResolvedValue({ success: true, count: 12 });

    render(<Contacts userId={USER} onClose={jest.fn()} />);

    const button = await screen.findByTestId("review-duplicates-button");
    expect(button).toHaveTextContent("Review 12 possible duplicates");
  });

  it("says 'duplicate' when there is exactly one", async () => {
    jest.mocked(window.api.contacts.getReviewQueueCount).mockResolvedValue({ success: true, count: 1 });

    render(<Contacts userId={USER} onClose={jest.fn()} />);

    expect(await screen.findByTestId("review-duplicates-button")).toHaveTextContent(
      "Review 1 possible duplicate",
    );
  });

  it("opens the review panel", async () => {
    jest.mocked(window.api.contacts.getReviewQueueCount).mockResolvedValue({ success: true, count: 3 });

    render(<Contacts userId={USER} onClose={jest.fn()} />);
    await userEvent.click(await screen.findByTestId("review-duplicates-button"));

    expect(await screen.findByTestId("review-duplicates-modal")).toBeInTheDocument();
    await waitFor(() => expect(window.api.contacts.getReviewQueue).toHaveBeenCalledWith(USER));
  });
});
