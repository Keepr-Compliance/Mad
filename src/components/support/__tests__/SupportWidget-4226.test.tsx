/**
 * BACKLOG-4226: the support "?" works while a Radix modal (Learn mode) is open.
 *
 * Real LearnSessionHost / LearnScoreHost (real @keepr/ui Dialog), real
 * SupportWidget and real SupportTicketDialog, mounted side by side the way
 * App.tsx (SupportWidget) and AppModals (Learn hosts) mount them. Only
 * window.api is faked. Clicks are driven by user-event (pointerdown, pointerup,
 * click), never fireEvent.click, which skips the pointerdown that dismisses
 * a Radix modal.
 *
 *   S1  "?" over Learn: exactly one screenshot, taken while the Learn dialog
 *       is in the DOM and before the form exists; Learn is not ended (the
 *       score is never asked for, the score dialog never appears) and the
 *       form opens.
 *   S2  The form is usable over Learn: typing works and keeps focus, Escape
 *       closes only the form, focus returns inside Learn, and Learn is still
 *       open and clickable afterwards.
 *   S3  With no modal open, the form opens without a modal layer and body
 *       pointer-events are untouched.
 *
 * Learn replies are the transcribed fixtures in learnFixtures-4120.ts.
 */
import React from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import { LearnScoreHost, LearnSessionHost } from "../../settings/learn/LearnSessionHost";
import { SupportWidget } from "../SupportWidget";
import {
  CLEANUP_NEXT,
  PREVIEW_CLEANUP,
  SCORE,
  STATE_ON,
} from "../../settings/learn/__tests__/learnFixtures-4120";

jest.mock("../../../contexts/PlatformContext", () => ({
  usePlatform: jest.fn(() => ({ isMacOS: true, isWindows: false, isLinux: false, platform: "macos" })),
}));

const QUESTION = "Learn mode question";
const SCORE_TITLE = /How Keepr is doing|answers? saved/;

let learn: Record<string, jest.Mock>;
let captures: Array<{ question: boolean; score: boolean; form: boolean }>;

function installApi(): void {
  captures = [];
  learn = {
    getState: jest.fn(async () => STATE_ON),
    cleanupNext: jest.fn(async () => CLEANUP_NEXT),
    sampleNext: jest.fn(async () => ({ success: true, question: null })),
    preview: jest.fn(async () => PREVIEW_CLEANUP),
    attachmentOpen: jest.fn(async () => ({
      success: true,
      dataUrl: "data:application/pdf;base64,JVBERi0=",
      downloadedNow: true,
    })),
    cleanupAnswer: jest.fn(async () => ({ success: true })),
    sampleAnswer: jest.fn(async () => ({ success: true })),
    score: jest.fn(async () => SCORE),
  };
  const api = window.api as unknown as Record<string, unknown>;
  api.learn = learn;
  api.support = {
    collectDiagnostics: jest.fn().mockResolvedValue({ success: true, diagnostics: null }),
    captureScreenshot: jest.fn().mockImplementation(async () => {
      captures.push({
        question: !!dialogTitled(QUESTION),
        score: !!dialogTitled(SCORE_TITLE),
        form: !!document.querySelector('[data-testid="support-ticket-dialog"]'),
      });
      return { success: true, screenshot: "iVBORw0KGgo=" };
    }),
    getCategories: jest.fn().mockResolvedValue({ success: true, categories: [] }),
    submitTicket: jest.fn().mockResolvedValue({ success: true, ticket_number: 1 }),
  };
  api.auth = {
    ...(api.auth as Record<string, unknown>),
    getCurrentUser: jest.fn().mockResolvedValue({ success: false }),
  };
}

beforeEach(installApi);

// Radix adds its outside-pointerdown listener on a timeout after the dialog mounts.
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

/**
 * A dialog by its title, read from aria-labelledby directly. Once the support
 * layer is on top, Radix aria-hides Learn, and the accessible-name lookup
 * returns "" for hidden content, so getByRole(..., { name }) cannot see it.
 */
function dialogTitled(name: string | RegExp): HTMLElement | null {
  for (const d of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))) {
    const id = d.getAttribute("aria-labelledby");
    const title = (id && document.getElementById(id)?.textContent) || "";
    if (typeof name === "string" ? title === name : name.test(title)) return d;
  }
  return null;
}

const supportButton = () => screen.getByRole("button", { name: "Open support dialog", hidden: true });

type Host = "session" | "score";

async function mountLearn(host: Host) {
  const onClose = jest.fn();
  render(
    <>
      {host === "session" ? <LearnSessionHost total={2} onClose={onClose} /> : <LearnScoreHost onClose={onClose} />}
      <SupportWidget />
    </>,
  );
  const name = host === "session" ? QUESTION : SCORE_TITLE;
  const dialog = await screen.findByRole("dialog", { name });
  if (host === "session") await within(dialog).findAllByText(/canarytest/i);
  await settle();
  // Precondition: Learn has the body pointer lock, as in the app.
  expect(document.body.style.pointerEvents).toBe("none");
  const scoreCallsAtStart = learn.score.mock.calls.length;
  return { onClose, name, scoreCallsAtStart };
}

/** Learn is still on screen and was not ended. */
function expectLearnStillOpen(host: Host, ctx: { onClose: jest.Mock; scoreCallsAtStart: number }) {
  if (host === "session") {
    expect(dialogTitled(QUESTION)).not.toBeNull();
    // finish() asks main for the score and mounts the score dialog; neither happened.
    expect(learn.score).toHaveBeenCalledTimes(ctx.scoreCallsAtStart);
    expect(dialogTitled(SCORE_TITLE)).toBeNull();
  } else {
    expect(dialogTitled(SCORE_TITLE)).not.toBeNull();
  }
  expect(ctx.onClose).not.toHaveBeenCalled();
}

describe.each<Host>(["session", "score"])("BACKLOG-4226 over Learn (%s dialog)", (host) => {
  it("S1: '?' opens the form with one screenshot of Learn, and Learn stays open", async () => {
    const ctx = await mountLearn(host);
    const user = userEvent.setup();

    await user.click(supportButton());

    expect(await screen.findByTestId("support-ticket-dialog")).toBeInTheDocument();
    expect(window.api.support.captureScreenshot).toHaveBeenCalledTimes(1);
    expect(captures).toEqual([
      host === "session"
        ? { question: true, score: false, form: false }
        : { question: false, score: true, form: false },
    ]);
    expectLearnStillOpen(host, ctx);
  });

  it("S2: the form takes typing; Escape closes only the form; focus and clicks return to Learn", async () => {
    const ctx = await mountLearn(host);
    const user = userEvent.setup();

    await user.click(supportButton());
    const subject = (await screen.findByLabelText(/Subject/)) as HTMLInputElement;
    await user.click(subject);
    await user.keyboard("hello");
    expect(subject.value).toBe("hello");
    expect(document.activeElement).toBe(subject);
    expectLearnStillOpen(host, ctx);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("support-ticket-dialog")).toBeNull());
    expectLearnStillOpen(host, ctx);

    // Learn's focus scope resumes: focus is back inside the Learn dialog.
    const learnDialog = screen.getByRole("dialog", { name: ctx.name });
    await waitFor(() => expect(learnDialog.contains(document.activeElement)).toBe(true));
    await user.tab();
    expect(learnDialog.contains(document.activeElement)).toBe(true);

    // Learn's pointer lock is back, and a click inside Learn does not end it.
    expect(document.body.style.pointerEvents).toBe("none");
    await user.click(within(learnDialog).getAllByRole("button")[0].parentElement as HTMLElement);
    expectLearnStillOpen(host, ctx);
  });
});

describe("BACKLOG-4226 with no modal open", () => {
  it("S3: the form opens without a modal layer and body pointer-events are untouched", async () => {
    render(<SupportWidget />);
    expect(document.body.style.pointerEvents).not.toBe("none");
    const user = userEvent.setup();

    await user.click(supportButton());

    expect(await screen.findByTestId("support-ticket-dialog")).toBeInTheDocument();
    expect(window.api.support.captureScreenshot).toHaveBeenCalledTimes(1);
    expect(dialogTitled("Contact Support")).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(document.body.style.pointerEvents).not.toBe("none");
  });
});
