/**
 * BACKLOG-4219 PR2 — P9: every line the "Help improve Keepr" switch
 * changes is true in BOTH states, and each state's line is pinned.
 *
 *   Learn settings, the Learn mode row:  OFF "Nothing leaves …"  /  ON "Diagnostic numbers are shared with Keepr."
 *   The score dialog:                    OFF "never sent anywhere" / ON "Diagnostic numbers are shared" / unknown: neither claim
 *   Data & Privacy, Learn mode answers:  ON adds "also shared" and "Delete all" says the shared numbers go too
 *   The description is the founder's final wording (2026-11-10).
 *
 * get-state replies are the handler's real shape (learnFixtures-4120 STATE_ON,
 * transcribed from the real handlers; the three pilot fields as the handler
 * returns them).
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { PlatformProvider } from "@/contexts/PlatformContext";
import { LearnSettings } from "../LearnSettings";
import { LearnScoreHost } from "../LearnSessionHost";
import { LearnAnswersPrivacyRow } from "../LearnAnswersPrivacyRow";
import { PILOT_CONSENT_TEXT } from "../learnPilotCopy";
import type { LearnStateResult } from "../../../../../electron/types/ipc/window-api-learn";
import { SCORE, STATE_ON } from "./learnFixtures-4120";

type State = Extract<LearnStateResult, { success: true }>;
let state: LearnStateResult;
let api: Record<string, jest.Mock>;

function install(s: LearnStateResult): void {
  state = s;
  api = {
    getState: jest.fn(async () => state),
    setEnabled: jest.fn(async ({ enabled }: { enabled: boolean }) => ({ success: true, enabled })),
    setPilotReport: jest.fn(async ({ enabled }: { enabled: boolean }) => {
      state = { ...(state as State), pilotReport: enabled, pilotPending: !enabled };
      return { success: true, pilotReport: enabled, pilotPending: !enabled };
    }),
    run: jest.fn(async () => ({ success: true, summary: { runId: "run-x", detectionIds: [], rowsScanned: 1 } })),
    onRunProgress: jest.fn(() => () => undefined),
    sampleDraw: jest.fn(async () => ({ success: true, result: { sampleSize: 0, drawn: 0 } })),
    score: jest.fn(async () => SCORE),
    listAnswers: jest.fn(async () => ({ success: true, answers: [] })),
    deleteAnswers: jest.fn(async () => ({ success: true, removed: { deal: 1, bulk: 0 } })),
  };
  (window.api as unknown as { learn: unknown }).learn = api;
}

const on = (extra: Partial<State> = {}): LearnStateResult => ({ ...(STATE_ON as State), pilotReport: true, ...extra });
const off = (extra: Partial<State> = {}): LearnStateResult => ({ ...(STATE_ON as State), pilotReport: false, ...extra });

function renderSettings() {
  return render(
    <PlatformProvider>
      <LearnSettings onStart={() => undefined} onSeeScore={() => undefined} />
    </PlatformProvider>,
  );
}

describe("P9 Learn settings: the Learn mode row is true with sharing OFF and ON", () => {
  it("OFF: 'Nothing leaves', no sharing claim; the switch is off", async () => {
    install(off());
    renderSettings();
    const sw = await screen.findByRole("switch", { name: "Help improve Keepr" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    const copy = screen.getByTestId("learn-mode-copy");
    expect(copy.textContent).toMatch(/Nothing leaves (this Mac|this computer)\.$/);
    expect(copy.textContent).not.toMatch(/shared with Keepr/);
  });

  it("ON: answers stay, only the numbers are shared; no 'Nothing leaves'", async () => {
    install(on());
    renderSettings();
    const sw = await screen.findByRole("switch", { name: "Help improve Keepr" });
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    const copy = screen.getByTestId("learn-mode-copy");
    expect(copy.textContent).toMatch(/Your answers stay on (this Mac|this computer)\. Diagnostic numbers are shared with Keepr\.$/);
    expect(copy.textContent).not.toMatch(/Nothing leaves/);
  });

  it("the switch asks main and the row's copy follows; turning it off shows the owed delete", async () => {
    install(off());
    renderSettings();
    const sw = await screen.findByRole("switch", { name: "Help improve Keepr" });
    await waitFor(() => expect(sw).not.toBeDisabled());
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(api.setPilotReport).toHaveBeenLastCalledWith({ enabled: true });
    expect(screen.getByTestId("learn-mode-copy").textContent).toMatch(/Diagnostic numbers are shared with Keepr\./);
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(api.setPilotReport).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.getByTestId("learn-pilot-status").textContent).toMatch(/^Deleting… finishes when (this Mac|this computer) is online\.$/);
    expect(screen.getByTestId("learn-mode-copy").textContent).toMatch(/Nothing leaves/);
  });

  it("the description is the founder's final wording", async () => {
    install(off());
    renderSettings();
    expect((await screen.findByTestId("learn-pilot-consent")).textContent).toBe(PILOT_CONSENT_TEXT);
    expect(PILOT_CONSENT_TEXT).toBe(
      "Share diagnostic numbers about how Learn mode performs. Turn it off any time to delete what was shared.",
    );
    expect(screen.getByRole("switch", { name: "Help improve Keepr" })).toBeInTheDocument();
    expect(screen.getByText("Help improve Keepr")).toBeInTheDocument();
  });

  it("Last shared: shown when main reports a send", async () => {
    install(on({ pilotLastSentAt: "2026-11-10T12:00:00.000Z" }));
    renderSettings();
    expect((await screen.findByTestId("learn-pilot-status")).textContent).toMatch(/^Last shared: /);
  });
});

describe("P9 the score dialog's privacy line, both states", () => {
  async function line(): Promise<string> {
    render(<LearnScoreHost onClose={() => undefined} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(api.getState).toHaveBeenCalled());
    return (dialog.textContent ?? "").replace(/\s+/g, " ");
  }

  it("OFF: 'never sent anywhere'", async () => {
    install(off());
    const t = await line();
    expect(t).toContain("Your answers are kept on this computer and are never sent anywhere.");
    expect(t).not.toContain("shared with Keepr");
  });

  it("ON: 'Diagnostic numbers are shared with Keepr.'; never 'never sent anywhere'", async () => {
    install(on());
    const t = await line();
    expect(t).toContain("Your answers are kept on this computer. Diagnostic numbers are shared with Keepr.");
    expect(t).not.toContain("never sent anywhere");
  });

  it("state unreadable: neither claim", async () => {
    install({ success: false, error: "Learn mode could not be reached." });
    const t = await line();
    expect(t).toContain("Your answers are kept on this computer.");
    expect(t).not.toContain("never sent anywhere");
    expect(t).not.toContain("shared with Keepr");
  });
});

describe("P9 Data & Privacy: the answers row, both states", () => {
  it("OFF: no sharing sentence; Delete all says nothing about shared numbers", async () => {
    install(off({ answers: { deal: 2, bulk: 0 } }));
    render(<LearnAnswersPrivacyRow />);
    const row = await screen.findByTestId("learn-answers-privacy");
    expect(row.textContent).not.toContain("shared with Keepr");
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(screen.getByTestId("learn-delete-all-confirm").textContent).not.toContain("shared with Keepr");
  });

  it("ON: 'Diagnostic numbers about Learn mode are shared with Keepr.'; Delete all says what was shared goes too", async () => {
    install(on({ answers: { deal: 2, bulk: 0 } }));
    render(<LearnAnswersPrivacyRow />);
    const row = await screen.findByTestId("learn-answers-privacy");
    await waitFor(() => expect(row.textContent).toContain("Diagnostic numbers about Learn mode are shared with Keepr."));
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));
    expect(screen.getByTestId("learn-delete-all-confirm").textContent).toContain(
      "What was shared with Keepr is deleted too.",
    );
  });
});
