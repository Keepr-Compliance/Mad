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
    expectOneLine(await openDialog("mail", [/newsletter or spam/i, /real estate business/i]));
  });
  it("deal question: No / Yes, my deal", async () => {
    expectOneLine(await openDialog("deal", [/^no$/i, /yes, my deal/i]));
  });
});

describe("Learn mail question: info tip and Skip placement (BACKLOG-4212)", () => {
  it("info tip is a labelled keyboard-focusable button; focus and click show the three lines", async () => {
    await openDialog("mail", [/newsletter or spam/i]);
    const tip = screen.getByRole("button", { name: "What do these answers mean?" });
    expect(tip.tagName).toBe("BUTTON");
    expect(screen.queryByTestId("learn-answer-help-panel")).toBeNull();
    fireEvent.focus(tip);
    const panel = screen.getByTestId("learn-answer-help-panel");
    expect(panel).toHaveTextContent("Real estate business: work mail about real estate, even when it isn't one of your deals.");
    expect(panel).toHaveTextContent("Newsletter or spam: marketing, promotions and mass mailings.");
    expect(panel).toHaveTextContent("Other business: any other work or personal mail, like software notices.");
    // Not inside the clipping dialog / answer panel: portalled, fixed, above the dialog.
    expect(screen.getByTestId("learn-answer-panel")).not.toContainElement(panel);
    expect(screen.getByRole("dialog")).not.toContainElement(panel);
    expect(classes(panel)).toEqual(expect.arrayContaining(["fixed", "z-[100]"]));
    fireEvent.blur(tip);
    expect(screen.queryByTestId("learn-answer-help-panel")).toBeNull();
    fireEvent.click(tip);
    expect(screen.getByTestId("learn-answer-help-panel")).toBeInTheDocument();
  });

  it.each([
    ["mail", [/newsletter or spam/i, /real estate business/i]],
    ["deal", [/^no$/i, /yes, my deal/i]],
  ] as const)("%s question: Skip for now sits in the answer panel after the answers, bordered", async (kind, names) => {
    const answers = await openDialog(kind, [...names]);
    const skip = screen.getByRole("button", { name: kind === "mail" ? /other business/i : /skip for now/i });
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
  it("labels carry the shortcut hint on the same one-line button", async () => {
    const [no, yes] = await openDialog("mail", [/newsletter or spam/i, /real estate business/i]);
    expect(no).toHaveTextContent("Newsletter or spam (N)");
    expect(yes).toHaveTextContent("Real estate business (R)");
    expect(screen.getByRole("button", { name: /other business/i })).toHaveTextContent("Other business (O)");
  });

  it("mail: R stores real_estate", async () => {
    await openDialog("mail", [/newsletter or spam/i]);
    fireEvent.keyDown(document.body, { key: "r" });
    await waitFor(() => expect(learnApi().sampleAnswer).toHaveBeenCalledWith({ rowId: "row-1", answer: "real_estate" }));
  });

  it("mail: N stores newsletter_spam", async () => {
    await openDialog("mail", [/newsletter or spam/i]);
    fireEvent.keyDown(document.body, { key: "N" });
    await waitFor(() => expect(learnApi().sampleAnswer).toHaveBeenCalledWith({ rowId: "row-1", answer: "newsletter_spam" }));
  });

  it("mail: O skips (stored as skip); S does nothing on mail", async () => {
    await openDialog("mail", [/newsletter or spam/i]);
    fireEvent.keyDown(document.body, { key: "s" });
    await new Promise((r) => setTimeout(r, 20));
    expect(learnApi().sampleAnswer).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "o" });
    await waitFor(() => expect(learnApi().sampleAnswer).toHaveBeenCalledWith({ rowId: "row-1", answer: "skip" }));
  });

  it("deal keeps Skip for now (S); mail shows Other business", async () => {
    await openDialog("deal", [/yes, my deal/i]);
    expect(screen.getByRole("button", { name: /skip for now/i })).toHaveTextContent("Skip for now (S)");
    expect(screen.queryByRole("button", { name: /other business/i })).toBeNull();
  });

  it("deal: Y answers yes", async () => {
    await openDialog("deal", [/yes, my deal/i]);
    fireEvent.keyDown(document.body, { key: "y" });
    await waitFor(() => expect(learnApi().cleanupAnswer).toHaveBeenCalledWith({ detectionId: expect.anything(), answer: "yes" }));
  });

  it("shortcuts are ignored while typing in an input, and with Ctrl/Cmd held", async () => {
    await openDialog("mail", [/newsletter or spam/i]);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "r" });
    fireEvent.keyDown(document.body, { key: "r", metaKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(learnApi().sampleAnswer).not.toHaveBeenCalled();
    input.remove();
  });

  it("wide windows widen the answer panel; the row wraps so the pair sits side by side when it fits", async () => {
    await openDialog("mail", [/newsletter or spam/i]);
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
