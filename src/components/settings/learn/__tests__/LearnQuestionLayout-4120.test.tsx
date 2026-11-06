/**
 * BACKLOG-4120 hotfix (2.46.1) — a wide email can never push the answer panel
 * out of the Learn mode question dialog.
 *
 * Founder QA (unsigned build of ebf884dc9): on an email question the email
 * filled the dialog and the Yes / No buttons on the right were not visible.
 * Traced by laying the real rendered DOM out in Chromium with the built CSS:
 * a 1400px email table measured the preview column at 2737px and put the
 * answer button at x=3093 in a 1120px dialog. The column was `1fr` (minimum
 * auto = the content's min-content width) with no min-w-0 down the chain.
 * After the fix, the same measurement with this file's fixtures (2000px
 * table, 500-character URL) keeps the column at 700px and the buttons inside.
 *
 * jsdom has no layout, so this asserts the structure that layout rests on:
 * the containment classes along the chain, the wrap rules on the email body,
 * and that the answer buttons sit in a sibling of the preview column, never
 * inside it.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LearnSessionHost } from "../LearnSessionHost";
import type { LearnPreviewResult } from "../../../../../electron/types/ipc/window-api-learn";
import { CLEANUP_NEXT, PREVIEW_BULK, PREVIEW_CLEANUP } from "./learnFixtures-4120";

const URL_500 = "https://example.test/" + "a".repeat(500);
const WIDE_HTML = `<table width="2000" style="width:2000px"><tr><td>Wide newsletter table</td></tr></table><p>${URL_500}</p>`;

function classes(el: Element): string[] {
  return el.className.split(/\s+/);
}

function installMain(kind: "mail" | "deal"): void {
  const bulk = PREVIEW_BULK as Extract<LearnPreviewResult, { success: true }>;
  const wide: LearnPreviewResult = { ...bulk, emails: [{ ...bulk.emails[0], bodyHtml: WIDE_HTML, attachments: [] }] };
  (window.api as unknown as { learn: unknown }).learn = {
    cleanupNext: jest.fn(async () => ({
      success: true,
      question: kind === "deal" ? (CLEANUP_NEXT as { question: unknown }).question : null,
    })),
    sampleNext: jest.fn(async () => ({ success: true, question: kind === "mail" ? { rowId: "row-wide" } : null })),
    preview: jest.fn(async () => (kind === "mail" ? wide : PREVIEW_CLEANUP)),
    attachmentOpen: jest.fn(async () => ({ success: true, dataUrl: "data:application/pdf;base64,JVBERi0=", downloadedNow: true })),
    score: jest.fn(async () => ({ success: false, error: "not needed" })),
  };
}

/** The preview column is width- and height-bounded, and the answer panel is its sibling. */
function expectContainedLayout(dialog: HTMLElement, answerName: RegExp): HTMLElement {
  const body = within(dialog).getByTestId("learn-question-body");
  expect(classes(body)).toEqual(
    expect.arrayContaining(["grid", "min-h-0", "grid-cols-[minmax(0,1fr)_420px]", "grid-rows-[minmax(0,1fr)]"]),
  );
  const column = within(dialog).getByTestId("learn-preview-column");
  const panel = within(dialog).getByTestId("learn-answer-panel");
  expect(classes(column)).toEqual(expect.arrayContaining(["min-w-0", "min-h-0", "overflow-hidden"]));
  expect(classes(panel)).toEqual(expect.arrayContaining(["min-w-0", "min-h-0", "overflow-y-auto"]));
  // Siblings in the grid; the answer buttons live in the panel, never in the preview.
  expect(column.parentElement).toBe(body);
  expect(panel.parentElement).toBe(body);
  const answer = within(dialog).getByRole("button", { name: answerName });
  expect(panel).toContainElement(answer);
  expect(column).not.toContainElement(answer);
  return column;
}

describe("Learn mode question layout (BACKLOG-4120 2.46.1)", () => {
  it("an email question with a 2000px table and a 500-character URL: preview contained, buttons outside it", async () => {
    installMain("mail");
    render(<LearnSessionHost total={1} onClose={() => undefined} />);
    const dialog = await screen.findByRole("dialog", { name: "Learn mode question" });
    const emailBody = await within(dialog).findByTestId("learn-email-body");
    // The fixture reached the DOM as written (the sanitizer keeps the width).
    expect(emailBody.querySelector("table")?.getAttribute("width")).toBe("2000");
    expect(emailBody.textContent).toContain(URL_500);

    const column = expectContainedLayout(dialog, /Real estate business/);
    expect(column).not.toContainElement(within(dialog).getByRole("button", { name: /Newsletter or spam/ }));

    const pane = within(column).getByTestId("learn-email-pane");
    expect(classes(pane)).toEqual(expect.arrayContaining(["min-w-0", "min-h-0", "flex-1"]));
    const scroller = within(column).getByTestId("learn-email-scroll");
    expect(classes(scroller)).toEqual(
      expect.arrayContaining(["min-w-0", "min-h-0", "flex-1", "overflow-y-auto", "overflow-x-auto"]),
    );
    expect(scroller).toContainElement(emailBody);
    expect(classes(emailBody)).toEqual(
      expect.arrayContaining([
        "[overflow-wrap:anywhere]",
        "[word-break:break-word]",
        "[&_table]:max-w-full",
        "[&_img]:max-w-full",
        "[&_pre]:max-w-full",
        "[&_pre]:whitespace-pre-wrap",
      ]),
    );
  });

  it("a deal question with its PDF: preview contained, buttons outside it", async () => {
    installMain("deal");
    render(<LearnSessionHost total={1} onClose={() => undefined} />);
    const dialog = await screen.findByRole("dialog", { name: "Learn mode question" });
    const pdf = await within(dialog).findByTestId("learn-pdf-pane");
    const column = expectContainedLayout(dialog, /Yes, my deal/);
    expect(column).toContainElement(pdf);
    expect(classes(pdf)).toEqual(expect.arrayContaining(["min-w-0", "min-h-0", "flex-1"]));
    expect(classes(within(pdf).getByTestId("learn-pdf-scroll"))).toEqual(
      expect.arrayContaining(["min-w-0", "min-h-0", "overflow-auto"]),
    );
  });
});
