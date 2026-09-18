/**
 * BACKLOG-3229 — dismissal is keyed on issue IDENTITY, not array position.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SUITE IS FOR
 * ---------------------------------------------------------------------------
 * `SystemHealthMonitor` kept dismissals in a `Set` of array INDICES and filtered
 * with `issues.filter((_, index) => !dismissed.has(index))`. The list is rebuilt
 * on every health check, so a dismissal did not attach to an issue — it attached
 * to a SLOT.
 *
 * Before this suite the component had 17 tests and not one of them dismissed
 * anything. Measured, not assumed: an execution counter placed in
 * `handleDismiss` at develop `a6fe128aa` was reached exactly ONCE across all 17,
 * incidentally, from the Reconnect click in "clicking Reconnect opens Settings".
 * `grep -c Dismiss` on that suite returns 0 — no test ever reached the Dismiss
 * button. That is why this survived.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES ARE TRANSCRIBED, NOT INVENTED
 * ---------------------------------------------------------------------------
 * Permission rows come from `tests/fixtures/fdaDeniedIssue-3219.ts`, which a
 * transcription suite pins against the real `permissionService`.
 *
 * Connection rows use `TOKEN_REFRESH_FAILED`. `connectionStatusService` writes
 * only `NOT_CONNECTED` (:130, :262), `TOKEN_REFRESH_FAILED` (:193, :325) and
 * `CONNECTION_CHECK_FAILED` (:230, :362) — `TOKEN_EXPIRED` is declared in the
 * union and emitted by NO producer, and `NOT_CONNECTED` never reaches the banner
 * because `diagnosticHandlers` filters on BROKEN_TOKEN_TYPES. A fixture built on
 * `TOKEN_EXPIRED` would describe a state the code cannot produce.
 */

import { render, screen, act } from "@testing-library/react";
import SystemHealthMonitor from "../SystemHealthMonitor";
import {
  FDA_DENIED_BANNER_ISSUE,
  FDA_COLLAPSED_TITLE_TEXT,
} from "../../../tests/fixtures/fdaDeniedIssue-3219";

const mockHealthCheck = jest.fn();
jest.mock("../../services", () => ({
  systemService: {
    healthCheck: (...args: unknown[]) => mockHealthCheck(...args),
    openPrivacyPane: jest.fn(),
    openFullDiskAccessSettings: jest.fn(),
    checkMessagesPermission: jest.fn().mockResolvedValue({
      success: true,
      data: { hasPermission: false, reason: "EPERM" },
    }),
  },
  authService: {
    googleConnectMailbox: jest.fn(),
    microsoftConnectMailbox: jest.fn(),
    onMailboxConnected: jest.fn(),
  },
}));

/** A broken mailbox, as `connectionStatusService` + `diagnosticHandlers` emit it. */
const brokenMailbox = (provider: "google" | "microsoft") => ({
  type: "TOKEN_REFRESH_FAILED",
  provider,
  severity: "error",
  userMessage:
    provider === "google"
      ? "Your Gmail connection expired. Reconnect to keep capturing email."
      : "Your Outlook connection expired. Reconnect to keep capturing email.",
  action: "Reconnect",
  actionHandler: `reconnect-${provider}`,
});

/** `checkContactsLoading()` reporting an unreadable address book. */
const CONTACTS_UNREADABLE_ROW = {
  type: "CONTACTS_LOADING_FAILED",
  title: "Cannot Load Contacts",
  message: "Could not load contacts from Contacts app",
  details: "",
  action: "Grant Full Disk Access",
  actionHandler: "open-system-settings",
  severity: "warning",
};

/**
 * A row carrying none of the three identity fields. Not emitted by any producer
 * today — `errorCode` is optional in `PermissionResult`, so this is the shape a
 * future path could produce, and the component must fail toward SHOWING it.
 */
const IDENTITY_LESS_ROW = {
  hasPermission: false,
  userMessage: "Something is wrong and we cannot name it.",
};

const healthResult = (issues: unknown[]) => ({
  success: true,
  data: { healthy: issues.length === 0, issues },
});

const TWO_MINUTES = 2 * 60 * 1000;

/** Render and fire the 3s initial check. */
async function renderAndFirstCheck() {
  const utils = render(
    <SystemHealthMonitor userId="user-1" provider="google" onOpenSettings={jest.fn()} />,
  );
  await act(async () => {
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
  });
  return utils;
}

/** Fire one more 2-minute poll. */
async function nextPoll() {
  await act(async () => {
    jest.advanceTimersByTime(TWO_MINUTES);
    await Promise.resolve();
  });
}

function dismissButtons() {
  return screen.queryAllByRole("button", { name: "Dismiss" });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("BACKLOG-3229 — dismissal follows the issue, not the slot", () => {
  /**
   * C0 — the baseline the old code also passed, and the one control that
   * catches a prune written with a stale closure.
   *
   * `checkSystemHealth` is a `useCallback` keyed on [userId, provider] and
   * `setInterval` holds ONE closure for the life of the effect. A prune that
   * read `dismissed` from scope would read the empty set captured on first
   * render and wipe every dismissal every two minutes — and EVERY other control
   * in this file passes that build, because they all assert that some OTHER row
   * stayed visible. This is the only one that would go red.
   */
  it("C0 — a dismissal SURVIVES a poll that changes nothing", async () => {
    mockHealthCheck.mockResolvedValue(healthResult([FDA_DENIED_BANNER_ISSUE]));
    await renderAndFirstCheck();

    expect(screen.getByText(FDA_COLLAPSED_TITLE_TEXT)).toBeInTheDocument();
    act(() => {
      dismissButtons()[0].click();
    });
    expect(screen.queryByText(FDA_COLLAPSED_TITLE_TEXT)).not.toBeInTheDocument();

    // Same issue, same list, next poll. It must STAY dismissed.
    await nextPoll();
    expect(screen.queryByText(FDA_COLLAPSED_TITLE_TEXT)).not.toBeInTheDocument();
  });

  /**
   * C1 — the live defect, and the sharpest form of it.
   *
   * The list goes 1 -> 1 and never passes through empty, so the old
   * "clear the set when the list is empty" mitigation structurally cannot fire.
   * Under index keying the reconnect row inherits slot 0 and is filtered out by
   * a dismissal of the Full Disk Access notice, which the user never connected
   * to her mailbox.
   */
  it("C1 — dismissing one issue does NOT suppress a different issue that takes its slot", async () => {
    mockHealthCheck
      .mockResolvedValueOnce(healthResult([FDA_DENIED_BANNER_ISSUE]))
      .mockResolvedValue(healthResult([brokenMailbox("google")]));

    await renderAndFirstCheck();
    act(() => {
      dismissButtons()[0].click();
    });

    // FDA granted; a mailbox breaks. One row out, one row in, same slot.
    await nextPoll();

    expect(
      screen.getByText("Your Gmail connection expired. Reconnect to keep capturing email."),
    ).toBeInTheDocument();
  });

  /**
   * C2 — the item's own stated verification bar: reorder the list between polls
   * and the row that was not dismissed must still be visible.
   */
  it("C2 — reordering the list does not move a dismissal onto another row", async () => {
    mockHealthCheck
      .mockResolvedValueOnce(
        healthResult([FDA_DENIED_BANNER_ISSUE, CONTACTS_UNREADABLE_ROW]),
      )
      .mockResolvedValue(
        healthResult([CONTACTS_UNREADABLE_ROW, FDA_DENIED_BANNER_ISSUE]),
      );

    await renderAndFirstCheck();
    // Dismiss the FDA row (first), leaving the contacts row.
    act(() => {
      dismissButtons()[0].click();
    });
    expect(screen.getByText("Cannot Load Contacts")).toBeInTheDocument();

    // Same two issues, opposite order.
    await nextPoll();

    expect(screen.getByText("Cannot Load Contacts")).toBeInTheDocument();
    expect(screen.queryByText(FDA_COLLAPSED_TITLE_TEXT)).not.toBeInTheDocument();
  });

  /**
   * C3 — two providers, one `type`.
   *
   * Both mailboxes emit `TOKEN_REFRESH_FAILED`, so `type` alone cannot tell the
   * rows apart. This is what makes `provider` load-bearing in the identity.
   */
  it("C3 — dismissing one provider's mailbox row leaves the other provider's visible", async () => {
    mockHealthCheck.mockResolvedValue(
      healthResult([brokenMailbox("google"), brokenMailbox("microsoft")]),
    );
    await renderAndFirstCheck();

    expect(dismissButtons()).toHaveLength(2);
    act(() => {
      dismissButtons()[0].click();
    });

    expect(
      screen.queryByText("Your Gmail connection expired. Reconnect to keep capturing email."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Your Outlook connection expired. Reconnect to keep capturing email."),
    ).toBeInTheDocument();
  });

  /**
   * C4 — recurrence, WITHOUT the list ever reaching empty.
   *
   * Routing this through an empty list would prove nothing: the old
   * clear-on-empty mitigation handles that case too. Going [A] -> [B] -> [A, B]
   * keeps the list non-empty throughout, which is precisely where the old code
   * could not recover.
   */
  it("C4 — an issue that is resolved and later recurs comes BACK", async () => {
    mockHealthCheck
      .mockResolvedValueOnce(healthResult([FDA_DENIED_BANNER_ISSUE]))
      .mockResolvedValueOnce(healthResult([brokenMailbox("google")]))
      .mockResolvedValue(
        healthResult([brokenMailbox("google"), FDA_DENIED_BANNER_ISSUE]),
      );

    await renderAndFirstCheck();
    act(() => {
      dismissButtons()[0].click();
    });
    expect(screen.queryByText(FDA_COLLAPSED_TITLE_TEXT)).not.toBeInTheDocument();

    await nextPoll(); // FDA resolved, mailbox broken. Never empty.
    await nextPoll(); // FDA comes back.

    expect(screen.getByText(FDA_COLLAPSED_TITLE_TEXT)).toBeInTheDocument();
  });

  /**
   * C5 — a row with no derivable identity cannot be dismissed, and is never
   * filtered out. It fails toward showing the user information.
   */
  it("C5 — an issue with no identity renders NO Dismiss button and stays visible", async () => {
    mockHealthCheck.mockResolvedValue(
      healthResult([IDENTITY_LESS_ROW, FDA_DENIED_BANNER_ISSUE]),
    );
    await renderAndFirstCheck();

    expect(screen.getByText("Something is wrong and we cannot name it.")).toBeInTheDocument();
    // Only the FDA row offers one.
    expect(dismissButtons()).toHaveLength(1);

    await nextPoll();
    expect(screen.getByText("Something is wrong and we cannot name it.")).toBeInTheDocument();
  });
});
