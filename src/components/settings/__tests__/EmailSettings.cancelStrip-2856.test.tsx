/**
 * BACKLOG-2856 (founder live QA, 2026-08-25) — the re-cache result is a
 * dismissible strip, and a cancelled run says what actually happened.
 *
 * > "it would be nice if the msg when it's cancelled is like messages —
 * >  highlight and dismissable msg."
 *
 * The messages panel already has exactly this, built from his QA of THAT panel
 * (BACKLOG-2749: "the completion strip has been dismissed. It used to linger
 * with no way to close it."). So this reuses `MacOSMessagesImportSettings`'s
 * pattern — `resultDismissed` state, reset on each new run, absolute X control —
 * rather than inventing a second one.
 *
 * The 8-second auto-clear that used to hide this message is gone. It has to be:
 * a strip that clears itself makes the dismiss control decorative, and the panel
 * he compared this to keeps its strip up until dismissed.
 *
 * MUTATIONS
 * ---------
 *   A. drop `!recacheResultDismissed` from the strip's render condition
 *        -> "dismissing hides it" goes RED
 *   B. drop `setRecacheResultDismissed(false)` from the start of a run
 *        -> "a new run resets the dismissal" goes RED
 *   C. return the count clause for a cancelled FORCE run
 *        -> "a cancelled force run never claims a count" goes RED
 *   D. drop the `emailsCached > 0` fork
 *        -> "distinguishes partial work from nothing at all" goes RED
 */

import React from "react";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmailSettings, describeCancelledRecache } from "../EmailSettings";

jest.mock("../../../contexts/NetworkContext", () => ({
  useNetwork: () => ({ isOnline: true }),
}));

jest.mock("../../../services", () => ({
  settingsService: { updatePreferences: jest.fn().mockResolvedValue({ success: true }) },
  authService: {
    googleConnectMailbox: jest.fn(),
    microsoftConnectMailbox: jest.fn(),
    googleDisconnectMailbox: jest.fn(),
    microsoftDisconnectMailbox: jest.fn(),
    onMailboxConnected: jest.fn(() => () => {}),
  },
}));

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrecacheEmails = jest.fn();
const mockCancelPrecache = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelPrecache.mockResolvedValue({ success: true });
  (window as unknown as { api: unknown }).api = {
    system: {
      checkAllConnections: jest.fn().mockResolvedValue({
        success: true,
        google: { connected: true, email: "me@example.com" },
        microsoft: { connected: false },
      }),
    },
    transactions: {
      precacheEmails: (...a: unknown[]) => mockPrecacheEmails(...a),
      cancelPrecacheEmails: (...a: unknown[]) => mockCancelPrecache(...a),
      onPrecacheProgress: () => () => {},
    },
  };
});

const renderPanel = () =>
  render(
    <React.StrictMode>
      <EmailSettings userId="user-1" initialPreferences={undefined as never} />
    </React.StrictMode>,
  );

/** Settle the component's pending promises without touching the clock. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {});
  }
}

/** Click the ordinary Re-cache and wait for its strip. */
async function runOrdinary(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(screen.getByTestId("recache-emails")).toBeInTheDocument());
  await user.click(screen.getByTestId("recache-emails"));
  return screen.findByTestId("recache-result");
}

describe("BACKLOG-2856 — the result strip can be dismissed", () => {
  /**
   * CONTROL — the control he asked for exists and works.
   *
   * MUTATION A: drop `!recacheResultDismissed` from the render condition -> RED.
   */
  it("hides the strip when the dismiss control is used", async () => {
    const user = userEvent.setup();
    mockPrecacheEmails.mockResolvedValue({ success: false, cancelled: true, emailsStored: 0 });
    renderPanel();

    const strip = await runOrdinary(user);
    expect(strip).toBeInTheDocument();

    await user.click(screen.getByTestId("recache-result-dismiss"));

    await waitFor(() =>
      expect(screen.queryByTestId("recache-result")).not.toBeInTheDocument(),
    );
  });

  /**
   * CONTROL — dismissing hides THIS run's message and nothing else. A dismissal
   * that outlived its run would silently swallow every future result, which is a
   * worse defect than the lingering strip it replaced.
   *
   * MUTATION B: drop `setRecacheResultDismissed(false)` from the start of a run
   * -> RED (the second run's strip never appears).
   */
  it("shows the next run's strip after an earlier one was dismissed", async () => {
    const user = userEvent.setup();
    mockPrecacheEmails.mockResolvedValue({ success: false, cancelled: true, emailsStored: 0 });
    renderPanel();

    await runOrdinary(user);
    await user.click(screen.getByTestId("recache-result-dismiss"));
    await waitFor(() =>
      expect(screen.queryByTestId("recache-result")).not.toBeInTheDocument(),
    );

    mockPrecacheEmails.mockResolvedValue({
      success: true,
      emailsStored: 12,
      emailsFetched: 40,
    });
    await user.click(screen.getByTestId("recache-emails"));

    const second = await screen.findByTestId("recache-result");
    expect(second).toHaveTextContent(/Cached 12 new emails/);
  });

  /**
   * CONTROL — the strip does not clear itself.
   *
   * The 8-second timer is gone; without this, a regression that reinstated it
   * would leave the dismiss button present but pointless, and the test above
   * would still pass because it dismisses within the window.
   *
   * Fake timers, so this asserts the ABSENCE of a timeout rather than waiting
   * eight real seconds and proving nothing.
   */
  it("keeps the strip up indefinitely until it is dismissed", async () => {
    // The clock is taken over BEFORE the run, which is the whole point: an
    // auto-clear scheduled on the real clock cannot be fast-forwarded, and the
    // first draft of this test installed the fake timers afterwards and stayed
    // green against a reinstated `setTimeout(…, 8000)`.
    //
    // `fireEvent` rather than `userEvent` for the same reason the other tests
    // use `userEvent`: userEvent's own click machinery schedules timeouts and
    // deadlocks against a faked clock, while fireEvent dispatches synchronously.
    jest.useFakeTimers();
    try {
      mockPrecacheEmails.mockResolvedValue({ success: true, emailsStored: 3, emailsFetched: 3 });
      renderPanel();
      await flush();

      fireEvent.click(screen.getByTestId("recache-emails"));
      await flush();
      expect(screen.getByTestId("recache-result")).toBeInTheDocument();

      // Well past the 8 seconds the removed auto-clear used to wait.
      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });

      expect(screen.getByTestId("recache-result")).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("BACKLOG-2856 — what a cancelled run is told it did", () => {
  /**
   * CONTROL — the fork the founder's two runs genuinely produce.
   *
   * A FORCE run wrote only to staging and the `finally` dropped it, so its
   * download is gone; naming a count would claim rows were kept that were not.
   * An ORDINARY run wrote straight to live, so whatever it cached before
   * stopping is still there and saying nothing would make an interrupted run
   * look like a wasted one.
   *
   * Driven through the pure helper, because the interesting cases are the ones
   * that need a run to stop at a particular point.
   *
   * MUTATION C: return the count clause for a force run -> RED.
   * MUTATION D: drop the `emailsCached > 0` fork -> RED.
   */
  it("distinguishes a cancel that stopped partial work from one that stopped nothing", () => {
    // Ordinary run, rows already in live email.
    expect(describeCancelledRecache(false, 240)).toBe(
      "Re-cache cancelled. 240 emails were cached before it stopped.",
    );
    // Ordinary run, nothing cached yet — no count clause at all, matching the
    // messages panel's "Import cancelled." with no clause when nothing ran.
    expect(describeCancelledRecache(false, 0)).toBe("Re-cache cancelled.");
    // Singular, because "1 emails were cached" is the kind of sentence that
    // makes a user distrust the number next to it.
    expect(describeCancelledRecache(false, 1)).toBe(
      "Re-cache cancelled. 1 email was cached before it stopped.",
    );
    // A FORCE run kept nothing, so it claims nothing.
    expect(describeCancelledRecache(true, 240)).toBe(
      "Re-cache cancelled. Your emails and their links were left unchanged.",
    );
    expect(describeCancelledRecache(true, 240)).not.toMatch(/240/);
  });

  /**
   * CONTROL — the panel actually reaches that fork with the real field.
   *
   * The helper being right is worth nothing if `handleRecacheEmails` passes the
   * wrong number, or the wrong `force` flag. This drives the whole path: an
   * ordinary run cancelled after 240 rows.
   */
  it("names the rows an ordinary cancelled run kept", async () => {
    const user = userEvent.setup();
    mockPrecacheEmails.mockResolvedValue({
      success: false,
      cancelled: true,
      emailsStored: 240,
      emailsFetched: 300,
    });
    renderPanel();

    const strip = await runOrdinary(user);
    expect(strip).toHaveTextContent("Re-cache cancelled. 240 emails were cached before it stopped.");
    expect(strip).toHaveClass("bg-yellow-50");
  });

  /**
   * CONTROL — and the force path does not, even though the same field is present
   * on the result. `emailsStored` counts rows written to STAGING, which the
   * `finally` dropped; printing it would be the BACKLOG-2775 defect again — a
   * count that describes work the user no longer has.
   */
  it("never claims a count after a cancelled force run", async () => {
    const user = userEvent.setup();
    mockPrecacheEmails.mockResolvedValue({
      success: false,
      cancelled: true,
      emailsStored: 240,
      emailsFetched: 300,
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("force-recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("force-recache-emails"));
    await user.click(screen.getByTestId("force-recache-confirm"));

    const strip = await screen.findByTestId("recache-result");
    expect(strip).toHaveTextContent(/left unchanged/);
    expect(strip).not.toHaveTextContent(/240/);
  });
});
