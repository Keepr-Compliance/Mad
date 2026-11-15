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
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { LearnSessionHost } from "../LearnSessionHost";
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
