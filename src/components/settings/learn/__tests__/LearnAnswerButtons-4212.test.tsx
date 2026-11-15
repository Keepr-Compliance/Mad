/**
 * BACKLOG-4212 QA fix — Learn answer buttons never wrap their label.
 *
 * Founder QA: "Newsletter or spam" and "Real estate business" broke onto two
 * lines inside the buttons, icon far left. jsdom has no layout, so this asserts
 * the classes the layout rests on: whitespace-nowrap on every answer button,
 * icon and label inline together, and a flex-wrap row whose children grow to
 * full width when they cannot sit side by side.
 */
import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import userEvent from "@testing-library/user-event";
import { LearnSessionHost } from "../LearnSessionHost";
import { LearnScoreDialog } from "../LearnScoreDialog";
import { CLEANUP_NEXT, PREVIEW_BULK, PREVIEW_CLEANUP } from "./learnFixtures-4120";

function classes(el: Element): string[] {
  return el.className.split(/\s+/);
}

function installMain(kind: "mail" | "deal"): void {
  (window.api as unknown as { learn: unknown }).learn = {
    cleanupNext: jest.fn(async () => ({
      success: true,
      question: kind === "deal" ? (CLEANUP_NEXT as { question: unknown }).question : null,
    })),
    sampleNext: jest.fn(async () => ({ success: true, question: kind === "mail" ? { rowId: "row-1" } : null })),
    preview: jest.fn(async () => (kind === "mail" ? PREVIEW_BULK : PREVIEW_CLEANUP)),
    attachmentOpen: jest.fn(async () => ({ success: true, dataUrl: "data:application/pdf;base64,JVBERi0=", downloadedNow: true })),
    score: jest.fn(async () => ({ success: false, error: "not needed" })),
    sampleAnswer: jest.fn(async () => ({ success: true })),
    cleanupAnswer: jest.fn(async () => ({ success: true })),
  };
}

async function openDialog(kind: "mail" | "deal", names: RegExp[]): Promise<HTMLElement[]> {
  installMain(kind);
  render(<LearnSessionHost total={1} onClose={() => undefined} />);
  const dialog = await screen.findByRole("dialog", { name: "Learn mode question" });
  return Promise.all(names.map((n) => within(dialog).findByRole("button", { name: n })));
}

function expectOneLine(buttons: HTMLElement[]): void {
  const row = buttons[0].parentElement as HTMLElement;
  expect(row).toBe(buttons[1].parentElement);
  expect(classes(row)).toEqual(expect.arrayContaining(["flex", "flex-wrap"]));
  for (const b of buttons) {
    expect(classes(b)).toContain("whitespace-nowrap");
    expect(classes(b)).toContain("inline-flex");
    expect(classes(b)).toContain("grow");
    const icon = b.querySelector("svg") as SVGElement;
    expect(icon.getAttribute("class")).toContain("shrink-0");
  }
}

describe("Learn answer buttons keep their label on one line (BACKLOG-4212)", () => {
  it("mail question: Newsletter or spam / Real estate business", async () => {
    expectOneLine(await openDialog("mail", [/automated or mass mail/i, /real estate work/i]));
  });
  it("deal question: No / Yes, my deal", async () => {
    expectOneLine(await openDialog("deal", [/^no$/i, /yes, my deal/i]));
  });
});

describe("Learn mail question: info tip and Skip placement (BACKLOG-4212)", () => {
  it("info tip is a labelled keyboard-focusable button; focus and click show the three lines", async () => {
    await openDialog("mail", [/automated or mass mail/i]);
    const tip = screen.getByRole("button", { name: "What do these answers mean?" });
    expect(tip.tagName).toBe("BUTTON");
    expect(screen.queryByTestId("learn-answer-help-panel")).toBeNull();
    fireEvent.focus(tip);
    const panel = screen.getByTestId("learn-answer-help-panel");
    // Exact copy, in order: intro, then the three rules, matched top-down.
    expect(panel).not.toHaveTextContent(/check in this order/i);
    expect(panel.children[0].tagName).toBe("UL");
    const lis = Array.from(panel.querySelectorAll("li"));
    expect(lis.map((li) => li.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Real estate work (\u2190): a person wrote to you about real estate (a client, lead, agent, lender, title or escrow), or a deal service (e-sign, showing, title portal) wrote about one of your deals.",
      "Automated or mass mail (\u2192): an automated email or newsletter, like a listing alert, promotion, receipt, or bank or app alert, even when it's about real estate.",
      "Other (\u2193): a person wrote to you about something else, or you can't tell.",
    ]);
    // Label colours match the buttons: green, red, neutral gray.
    expect(lis.map((li) => classes(li.querySelector("strong") as Element).find((c) => c.startsWith("text-")))).toEqual([
      "text-green-800",
      "text-red-700",
      "text-gray-700",
    ]);
    // Not inside the clipping dialog / answer panel: portalled, fixed, above the dialog.
    expect(screen.getByTestId("learn-answer-panel")).not.toContainElement(panel);
    expect(screen.getByRole("dialog")).not.toContainElement(panel);
    expect(classes(panel)).toEqual(expect.arrayContaining(["fixed", "z-[100]"]));
    expect(screen.getByTestId("learn-answer-help-keys")).toHaveTextContent(
      "U undoes your last answer.",
    );
    fireEvent.blur(tip);
    expect(screen.queryByTestId("learn-answer-help-panel")).toBeNull();
    fireEvent.click(tip);
    expect(screen.getByTestId("learn-answer-help-panel")).toBeInTheDocument();
  });

  it.each([
    ["mail", [/real estate work/i, /automated or mass mail/i]],
    ["deal", [/yes, my deal/i, /^no$/i]],
  ] as const)("%s question: Skip for now sits in the answer panel after the answers, bordered", async (kind, names) => {
    const answers = await openDialog(kind, [...names]);
    const skip = screen.getByRole("button", { name: kind === "mail" ? /^other$/i : /skip for now/i });
    const panel = screen.getByTestId("learn-answer-panel");
    expect(panel).toContainElement(skip);
    for (const a of answers) {
      expect(a.compareDocumentPosition(skip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(classes(skip)).toEqual(expect.arrayContaining(["border", "whitespace-nowrap", "w-full"]));
    expect(classes(skip)).not.toContain("bg-transparent");
  });
});

function learnApi(): { sampleAnswer: jest.Mock; cleanupAnswer: jest.Mock } {
  return (window.api as unknown as { learn: { sampleAnswer: jest.Mock; cleanupAnswer: jest.Mock } }).learn;
}

describe("Learn shortcuts, wide layout and score container (BACKLOG-4212)", () => {
  it("labels carry the arrow hint on the same one-line button; green (real estate) is FIRST in DOM order", async () => {
    const [no, yes] = await openDialog("mail", [/automated or mass mail/i, /real estate work/i]);
    expect(no).toHaveTextContent("Automated or mass mail (\u2192)");
    expect(yes).toHaveTextContent("Real estate work (\u2190)");
    const row = screen.getByTestId("learn-answer-row");
    expect(row.children[0]).toBe(yes);
    expect(row.children[1]).toBe(no);
    const other = screen.getByRole("button", { name: /^other$/i });
    expect(other).toHaveTextContent("Other (\u2193)");
    expect(no).toHaveAttribute("aria-keyshortcuts", "ArrowRight");
    expect(yes).toHaveAttribute("aria-keyshortcuts", "ArrowLeft");
    expect(other).toHaveAttribute("aria-keyshortcuts", "ArrowDown");
  });

  it.each([
    ["ArrowLeft", { rowId: "row-1", answer: "real_estate" }],
    ["ArrowRight", { rowId: "row-1", answer: "newsletter_spam" }],
    ["ArrowDown", { rowId: "row-1", answer: "skip" }],
  ])("mail: %s fires the right answer and is preventDefault-ed", async (key, expected) => {
    await openDialog("mail", [/automated or mass mail/i]);
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await waitFor(() => expect(learnApi().sampleAnswer).toHaveBeenCalledWith(expected));
  });

  it("deal: ArrowLeft = yes (first button), and Yes is first in DOM order", async () => {
    const [yes] = await openDialog("deal", [/yes, my deal/i]);
    expect(screen.getByTestId("learn-answer-row").children[0]).toBe(yes);
    fireEvent.keyDown(document.body, { key: "ArrowLeft" });
    await waitFor(() => expect(learnApi().cleanupAnswer).toHaveBeenCalledWith({ detectionId: expect.anything(), answer: "yes" }));
  });

  it("deal: ArrowRight answers no", async () => {
    await openDialog("deal", [/yes, my deal/i]);
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    await waitFor(() => expect(learnApi().cleanupAnswer).toHaveBeenCalledWith({ detectionId: expect.anything(), answer: "no" }));
  });

  it("deal keeps Skip for now (\u2193); mail shows Other", async () => {
    await openDialog("deal", [/yes, my deal/i]);
    expect(screen.getByRole("button", { name: /skip for now/i })).toHaveTextContent("Skip for now (\u2193)");
    expect(screen.queryByRole("button", { name: /^other$/i })).toBeNull();
  });

  it("old letter keys no longer fire", async () => {
    await openDialog("mail", [/automated or mass mail/i]);
    for (const key of ["n", "r", "o", "s", "y"]) fireEvent.keyDown(document.body, { key });
    await new Promise((r) => setTimeout(r, 20));
    expect(learnApi().sampleAnswer).not.toHaveBeenCalled();
  });

  it("arrows are ignored while typing in an input, and with Ctrl/Cmd held", async () => {
    await openDialog("mail", [/automated or mass mail/i]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const ev = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    fireEvent.keyDown(document.body, { key: "ArrowRight", metaKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(learnApi().sampleAnswer).not.toHaveBeenCalled();
    input.remove();
  });

  it("a real mouse click (focus then click) opens the info tip and a second click closes it", async () => {
    await openDialog("mail", [/automated or mass mail/i]);
    const tip = screen.getByRole("button", { name: "What do these answers mean?" });
    await userEvent.click(tip);
    expect(screen.getByTestId("learn-answer-help-panel")).toBeInTheDocument();
    await userEvent.click(tip);
    expect(screen.queryByTestId("learn-answer-help-panel")).toBeNull();
  });

  it("arrows do not answer while the reader is inside the email preview; they answer from elsewhere", async () => {
    await openDialog("mail", [/automated or mass mail/i]);
    const preview = screen.getByTestId("learn-preview-column");
    fireEvent.keyDown(preview, { key: "ArrowDown" });
    await new Promise((r) => setTimeout(r, 20));
    expect(learnApi().sampleAnswer).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("learn-answer-panel"), { key: "ArrowDown" });
    await waitFor(() => expect(learnApi().sampleAnswer).toHaveBeenCalledWith({ rowId: "row-1", answer: "skip" }));
  });

  it("wide windows widen the answer panel; the row wraps so the pair sits side by side when it fits", async () => {
    await openDialog("mail", [/automated or mass mail/i]);
    const body = screen.getByTestId("learn-question-body");
    expect(classes(body)).toContain("xl:grid-cols-[minmax(0,1fr)_600px]");
    expect(classes(screen.getByTestId("learn-answer-row"))).toContain("flex-wrap");
  });

  it("score dialog: viewport max-height, scrolling details, action row outside the scroller", () => {
    render(
      <LearnScoreDialog open answered={3} score={null} copyBlock={null} more={12} onMore={() => undefined} onClose={() => undefined} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(classes(dialog)).toEqual(expect.arrayContaining(["max-h-[calc(100vh-32px)]", "overflow-hidden"]));
    const scroller = screen.getByTestId("learn-score-scroll");
    expect(classes(scroller)).toEqual(expect.arrayContaining(["overflow-y-auto", "min-h-0", "flex-1"]));
    expect(scroller).not.toContainElement(screen.getByRole("button", { name: "Done" }));
    expect(scroller).not.toContainElement(screen.getByRole("button", { name: "12 more" }));
  });
});
