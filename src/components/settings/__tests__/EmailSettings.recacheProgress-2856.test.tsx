/**
 * BACKLOG-2856 — the progress surface and Cancel control for email re-cache,
 * and the confirmation dialog's enumeration of what a force run destroys.
 *
 * THE DEFECTS THESE ARE BORN AGAINST
 * ----------------------------------
 * 1. "after passing the warning window there is no progress bar. we should be
 *    doing it just like the force re import of the msgs." The run was silent for
 *    its whole duration — on a real mailbox, minutes of a UI indistinguishable
 *    from a hung app, for an operation that deletes the email cache.
 * 2. "i don't see the cancel button" — the service handled cancellation safely
 *    but nothing could trigger one.
 * 3. "did you put it on a different branch that doesn't have the need review?"
 *    The force re-cache emptied the Needs Review queue and the confirmation
 *    never said it would, so the founder concluded the app was broken.
 *
 * The bar and the Cancel control are asserted for BOTH buttons, because the
 * ordinary Re-cache is equally silent and now has the BACKLOG-2857 repair pass
 * in front of it.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { EmailSettings } from "../EmailSettings";
import { FORCE_RECACHE_LOSSES } from "../forceRecacheWarning";

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

/** Progress subscribers, so a test can push events the way the main process does. */
let progressSubscribers: Array<(p: unknown) => void> = [];
const emitProgress = (p: unknown) =>
  act(() => {
    progressSubscribers.forEach((fn) => fn(p));
  });

const mockPrecacheEmails = jest.fn();
const mockCancelPrecache = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  progressSubscribers = [];
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
      onPrecacheProgress: (cb: (p: unknown) => void) => {
        progressSubscribers.push(cb);
        return () => {
          progressSubscribers = progressSubscribers.filter((fn) => fn !== cb);
        };
      },
    },
  };
});

const renderPanel = () =>
  render(
    <React.StrictMode>
      <EmailSettings userId="user-1" initialPreferences={undefined as never} />
    </React.StrictMode>,
  );

/** A precache that stays pending until the test releases it. */
function pendingPrecache() {
  let release!: (value: unknown) => void;
  mockPrecacheEmails.mockImplementation(
    () => new Promise((resolve) => { release = resolve; }),
  );
  return { release: (v: unknown) => act(() => { release(v); }) };
}

describe("BACKLOG-2856 — the progress bar", () => {
  it("shows nothing until a run starts", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("recache-emails")).toBeInTheDocument());
    expect(screen.queryByTestId("recache-progress")).not.toBeInTheDocument();
  });

  /**
   * THE ORDINARY BUTTON. Not only the force one — the founder reported force,
   * but shipping a bar on one of two adjacent silent buttons would just move the
   * complaint, and this is the button with the repair pass in front of it.
   *
   * MUTATION: delete the `onPrecacheProgress` subscription effect -> RED.
   */
  it("reports the repair pass by name during an ordinary re-cache", async () => {
    const user = userEvent.setup();
    const gate = pendingPrecache();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("recache-emails"));
    emitProgress({ phase: "repairing", current: 400, total: 400, percent: 5 });

    expect(screen.getByTestId("recache-progress")).toBeInTheDocument();
    expect(screen.getByTestId("recache-progress-label")).toHaveTextContent(/Repairing stored emails/i);
    // The row counter reaches the user — otherwise the label sits motionless for
    // the whole pass, which is barely better than a blank panel.
    expect(screen.getByTestId("recache-progress-label")).toHaveTextContent("400");

    gate.release({ success: true, emailsStored: 0, emailsFetched: 0 });
  });

  it("names the swap phase, which only a force run reaches", async () => {
    const user = userEvent.setup();
    const gate = pendingPrecache();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("force-recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("force-recache-emails"));
    await user.click(screen.getByTestId("force-recache-confirm"));
    emitProgress({ phase: "swapping", current: 487, total: 487, percent: 95 });

    expect(screen.getByTestId("recache-progress-label")).toHaveTextContent(/Replacing your cached emails/i);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "95");

    gate.release({ success: true, forceSwap: { emailsInserted: 487, providers: ["gmail"] } });
  });

  /**
   * THE ANTI-STRAND GUARANTEE, terminal-event half.
   *
   * MUTATION: stop clearing on `phase === "done"` -> RED.
   */
  it("clears the bar on the terminal event", async () => {
    const user = userEvent.setup();
    const gate = pendingPrecache();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("recache-emails"));
    emitProgress({ phase: "fetching", current: 10, total: 10, percent: 50 });
    expect(screen.getByTestId("recache-progress")).toBeInTheDocument();

    emitProgress({ phase: "done", current: 10, total: 10, percent: 100, outcome: "success" });
    expect(screen.queryByTestId("recache-progress")).not.toBeInTheDocument();

    gate.release({ success: true, emailsStored: 10, emailsFetched: 10 });
  });

  /**
   * THE ANTI-STRAND GUARANTEE, response half — the path no event can settle.
   *
   * A run rejected because another was already in flight gets NO progress
   * events by design (a terminal broadcast on the shared channel would settle
   * the running run's bar). If the panel only cleared on `done`, a bar raised by
   * the live run would be the one left behind. Clearing on promise resolution is
   * what makes the bar belong to this invocation.
   *
   * MUTATION: remove `setRecacheProgress(null)` from the handler's `finally`
   * -> RED.
   */
  it("clears the bar when the run resolves even if no terminal event arrives", async () => {
    const user = userEvent.setup();
    const gate = pendingPrecache();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("recache-emails"));
    emitProgress({ phase: "fetching", current: 3, total: 3, percent: 10 });
    expect(screen.getByTestId("recache-progress")).toBeInTheDocument();

    // Resolves with no terminal event, as the already-in-progress path does.
    gate.release({ success: false, error: "Precache already in progress" });

    await waitFor(() => expect(screen.queryByTestId("recache-progress")).not.toBeInTheDocument());
  });
});

describe("BACKLOG-2856 — the Cancel control", () => {
  it("appears only while a run is in flight, and reaches the main process", async () => {
    const user = userEvent.setup();
    const gate = pendingPrecache();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("recache-emails")).toBeInTheDocument());
    expect(screen.queryByTestId("cancel-recache")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("recache-emails"));
    emitProgress({ phase: "fetching", current: 5, total: 5, percent: 10 });

    await user.click(screen.getByTestId("cancel-recache"));
    expect(mockCancelPrecache).toHaveBeenCalledTimes(1);

    gate.release({ success: false, cancelled: true });
    await waitFor(() => expect(screen.queryByTestId("cancel-recache")).not.toBeInTheDocument());
  });

  /**
   * Reachable during the REPAIR pass specifically — the earliest phase, and the
   * one most likely to be missed when wiring a signal, because it runs before
   * the fetch loop the abort checks naturally cluster around.
   */
  it("is reachable during the repair pass", async () => {
    const user = userEvent.setup();
    const gate = pendingPrecache();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("recache-emails"));
    emitProgress({ phase: "repairing", current: 200, total: 200, percent: 5 });

    await user.click(screen.getByTestId("cancel-recache"));
    expect(mockCancelPrecache).toHaveBeenCalledTimes(1);

    gate.release({ success: false, cancelled: true });
  });

  /**
   * A cancel is the user getting what they asked for. Painting it red would
   * report their own decision as a failure.
   *
   * MUTATION: delete the `result.cancelled` branch in `handleRecacheEmails`
   * -> RED (the message becomes the generic failure copy, in red).
   */
  it("reports a cancelled force run in neutral terms, and says nothing changed", async () => {
    const user = userEvent.setup();
    mockPrecacheEmails.mockResolvedValue({ success: false, cancelled: true });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("force-recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("force-recache-emails"));
    await user.click(screen.getByTestId("force-recache-confirm"));

    const result = await screen.findByTestId("recache-result");
    expect(result).toHaveTextContent(/cancelled/i);
    expect(result).toHaveTextContent(/left unchanged/i);
    expect(result).toHaveClass("text-gray-600");
    expect(result).not.toHaveClass("text-red-600");
  });
});

describe("BACKLOG-2856 — the confirmation enumerates what is destroyed", () => {
  /**
   * THE FOUNDER'S THIRD REPORT.
   *
   * The old copy named the transaction links and stopped. He read it, accepted
   * it, ran the re-cache, lost his Needs Review queue and reported the section
   * as broken. Every category the blast-radius suite proves is destroyed must
   * appear here — and vaguely gesturing at "some data" would fail the same way
   * the original text did.
   *
   * MUTATION: remove any entry from FORCE_RECACHE_LOSSES -> RED here and in
   * `emailSyncService.forceRecacheBlastRadius-2856`.
   */
  it("shows every declared loss in the dialog the user actually reads", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("force-recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("force-recache-emails"));

    const list = screen.getByTestId("force-recache-losses");
    expect(FORCE_RECACHE_LOSSES.length).toBe(3);
    for (const loss of FORCE_RECACHE_LOSSES) {
      expect(list).toHaveTextContent(loss.text);
    }
    // The three losses named in the founder's own terms.
    expect(list).toHaveTextContent(/unlinked from their transactions/i);
    expect(list).toHaveTextContent(/Needs Review queue will be emptied/i);
    expect(list).toHaveTextContent(/decisions you already made/i);
  });

  it("still lets the user back out, and does not run anything on cancel", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("force-recache-emails")).toBeInTheDocument());

    await user.click(screen.getByTestId("force-recache-emails"));
    await user.click(screen.getByTestId("force-recache-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("force-recache-confirm-modal")).not.toBeInTheDocument(),
    );
    expect(mockPrecacheEmails).not.toHaveBeenCalled();
  });
});
