/**
 * C1 (UX redesign) — Keepr's "Enter the code from your browser" panel. One
 * short line per state; the code is typed here (Keepr never makes one).
 * Mutations: the code not sent → red; a 5-digit code sent → red; the
 * intrusion warning not shown → red; "linked" not reported → red.
 */
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

type Link =
  | { state: "none"; intrusion: boolean }
  | { state: "waiting"; expiresAt: number; triesLeft: number; intrusion: boolean }
  | { state: "locked"; until: number; intrusion: boolean };
let mockLink: Link = { state: "none", intrusion: false };
let mockLinked = false;
const mockEnter = jest.fn(async (_code: string) => ({ success: true }) as { success: boolean; error?: string });
const mockLinkForget = jest.fn(async () => undefined);
const mockOpenMessages = jest.fn(async () => undefined);
jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    linkState: async () => ({ success: true, data: { link: mockLink, linked: mockLinked } }),
    linkEnterCode: (code: string) => mockEnter(code),
    linkDismissWarning: async () => undefined,
    linkForget: () => mockLinkForget(),
    openGoogleMessages: () => mockOpenMessages(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LinkBrowserPanel, LINK_COPY, cleanLinkCode } = require("../LinkBrowserPanel") as typeof import("../LinkBrowserPanel");

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

beforeEach(() => {
  jest.useFakeTimers();
  mockLink = { state: "none", intrusion: false };
  mockLinked = false;
  mockEnter.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("LinkBrowserPanel", () => {
  // Founder (LinkFlow step 4, 2026-10-04): no Link button — the 6th digit
  // (typed or pasted, with or without a space) submits by itself, once.
  // Checking: a spinner in the field. Mutations: 5 digits sent; no
  // auto-submit; a second submit while checking; no spinner → red.
  it("the 6th digit submits by itself (typed or pasted); 5 digits never", async () => {
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    render(<LinkBrowserPanel />);
    await flush();
    expect(screen.getByText(LINK_COPY.enter)).toBeInTheDocument();
    expect(screen.queryByTestId("gm-link-submit")).toBeNull();
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12345" } });
    await flush();
    expect(mockEnter).not.toHaveBeenCalled();
    let release: (v: { success: boolean }) => void = () => undefined;
    mockEnter.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await act(async () => {
      fireEvent.change(input, { target: { value: "123 456" } }); // a paste
    });
    expect(input.value).toBe("123456");
    expect(mockEnter).toHaveBeenCalledTimes(1);
    expect(mockEnter).toHaveBeenCalledWith("123456");
    expect(screen.getByTestId("gm-link-checking")).toBeInTheDocument();
    expect(input.readOnly).toBe(true);
    await act(async () => {
      release({ success: true });
    });
  });

  // Mutations: success not shown green with ✓ / "Linked" / "Sync now";
  // Sync now not starting the Sync → red.
  it("linked: a green field with ✓, 'Linked', and 'Sync now' starts the Sync", async () => {
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    const onSyncNow = jest.fn();
    const onJustLinked = jest.fn();
    render(<LinkBrowserPanel onSyncNow={onSyncNow} onJustLinked={onJustLinked} />);
    await flush();
    await act(async () => {
      fireEvent.change(screen.getByTestId("gm-link-code"), { target: { value: "482913" } });
    });
    mockLink = { state: "none", intrusion: false };
    mockLinked = true;
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();
    const input = screen.getByTestId("gm-link-code");
    expect(input.className.split(" ")).toContain("border-[#15803D]");
    expect(screen.getByTestId("gm-link-ok")).toHaveTextContent("✓");
    expect(screen.getByTestId("gm-link-just-linked")).toHaveTextContent("Linked");
    expect(onJustLinked).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("gm-link-open-messages")).toBeNull();
    const sync = screen.getByTestId("gm-link-sync-now");
    expect(sync).toHaveTextContent("Sync now");
    for (const c of ["min-h-[48px]", "bg-[#4F46E5]", "text-white", "font-bold", "rounded-[10px]"]) expect(sync.className.split(" ")).toContain(c);
    fireEvent.click(sync);
    expect(onSyncNow).toHaveBeenCalledTimes(1);
  });

  // Mutations: a wrong code not said with the tries left; the field not
  // cleared; 5 tries not "used up" → red.
  it("wrong: a red field, 'Code didn't match — N tries left', cleared; used up after the last", async () => {
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    render(<LinkBrowserPanel />);
    await flush();
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "111111" } });
    });
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 4, intrusion: false };
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();
    expect(screen.getByTestId("gm-link-error")).toHaveTextContent("Code didn't match — 4 tries left");
    expect(input.className.split(" ")).toContain("border-[#B42318]");
    expect(input.value).toBe("");
    expect(input.readOnly).toBe(false);
    await act(async () => {
      fireEvent.change(input, { target: { value: "222222" } });
    });
    expect(mockEnter).toHaveBeenCalledTimes(2);
    mockLink = { state: "none", intrusion: false }; // the 5th try burned the session
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await flush();
    expect(screen.getByTestId("gm-link-error")).toHaveTextContent("Code used up. Get a new code in Chrome.");
  });

  it("a refused code says why, and the field is cleared", async () => {
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    mockEnter.mockResolvedValueOnce({ success: false, error: "That code expired. Click Link in the extension for a new one." });
    render(<LinkBrowserPanel />);
    await flush();
    await act(async () => {
      fireEvent.change(screen.getByTestId("gm-link-code"), { target: { value: "123456" } });
    });
    await flush();
    expect(screen.getByTestId("gm-link-error")).toHaveTextContent("That code expired.");
    expect((screen.getByTestId("gm-link-code") as HTMLInputElement).value).toBe("");
  });

  it("another app tried to link: said plainly", async () => {
    mockLink = { state: "locked", until: Date.now() + 60_000, intrusion: true };
    render(<LinkBrowserPanel />);
    await flush();
    expect(screen.getByTestId("gm-link-intrusion")).toHaveTextContent(LINK_COPY.locked);
  });

  it("linked: the parent is told", async () => {
    mockLinked = true;
    const onLinked = jest.fn();
    render(<LinkBrowserPanel onLinked={onLinked} />);
    await flush();
    expect(screen.getByTestId("gm-link-linked")).toHaveTextContent(LINK_COPY.linked);
    expect(onLinked).toHaveBeenCalledTimes(1);
  });

  // Live (B2): a code from the browser gets its field even when Keepr already
  // counts a link; "Link a browser" is always there. Mutations: linked
  // hiding the field → red; no "Link a browser" → red.
  it("linked AND a code waiting: the field is shown (a new link replaces the old)", async () => {
    mockLinked = true;
    mockLink = { state: "waiting", expiresAt: Date.now() + 90_000, triesLeft: 5, intrusion: false };
    render(<LinkBrowserPanel />);
    await flush();
    expect(screen.getByTestId("gm-link-code")).toBeInTheDocument();
  });

  // SR (B1): "Forget link" is Keepr's own way to delete a link.
  // Mutation: the button not calling linkForget → red.
  it("linked: 'Forget link' forgets it", async () => {
    mockLinked = true;
    render(<LinkBrowserPanel />);
    await flush();
    fireEvent.click(screen.getByTestId("gm-link-forget"));
    await flush();
    expect(mockLinkForget).toHaveBeenCalledTimes(1);
  });

  // The approved mockup (KeeprLinkPrompt, founder 2026-10-04): ONE minimal
  // card — "Link your browser", (1) a 48px "Open Google Messages" (works
  // without a link), (2) "Type the code from Chrome" (52px field) + a dark
  // Link. No paragraphs, no illustration, no Cancel. Mutations: a step
  // missing or reordered; Open Google Messages not wired; a token off the
  // mockup; a paragraph back → red.
  it("not linked: the two-step card of the mockup", async () => {
    render(<LinkBrowserPanel />);
    await flush();
    const panel = screen.getByTestId("gm-link-panel");
    for (const c of ["max-w-[520px]", "p-7", "gap-5", "rounded-2xl", "border-[#D6D9E4]", "bg-white"]) expect(panel.className.split(" ")).toContain(c);
    expect(Array.from(panel.children).map((c) => c.getAttribute("data-testid"))).toEqual(["gm-link-title", "gm-link-step-1", "gm-link-step-2"]);
    expect(screen.getByTestId("gm-link-title")).toHaveTextContent("Link your browser");
    const one = screen.getByTestId("gm-link-step-1");
    expect(one.firstElementChild).toHaveTextContent("1");
    for (const c of ["w-7", "h-7", "rounded-full", "bg-[#EEF0FF]", "text-[#312E81]"]) expect((one.firstElementChild as HTMLElement).className.split(" ")).toContain(c);
    const open = screen.getByTestId("gm-link-open-messages");
    expect(open).toHaveTextContent("Open Google Messages");
    for (const c of ["flex-grow", "min-h-[48px]", "rounded-[10px]", "bg-[#4F46E5]", "text-white", "text-[15px]", "font-bold"]) expect(open.className.split(" ")).toContain(c);
    fireEvent.click(open);
    expect(mockOpenMessages).toHaveBeenCalledTimes(1);
    const two = screen.getByTestId("gm-link-step-2");
    expect(two.firstElementChild).toHaveTextContent("2");
    expect(two).toHaveTextContent("Type the code from Chrome");
    const input = screen.getByTestId("gm-link-code");
    expect(input.getAttribute("placeholder")).toBe("000 000");
    for (const c of ["min-h-[52px]", "border-2", "border-[#CDD1DE]", "rounded-[10px]", "font-mono", "text-[26px]", "tracking-[0.2em]"]) {
      expect(input.className.split(" ")).toContain(c);
    }
    // No Link button (the code submits itself) and no Cancel.
    expect(screen.queryByTestId("gm-link-submit")).toBeNull();
    expect(screen.queryByTestId("gm-link-cancel")).toBeNull();
    expect(panel.querySelectorAll("p")).toHaveLength(0);
  });

  it("linked: 'Link a browser' shows the two steps", async () => {
    mockLinked = true;
    render(<LinkBrowserPanel />);
    await flush();
    expect(screen.queryByTestId("gm-link-step-1")).toBeNull();
    fireEvent.click(screen.getByTestId("gm-link-another"));
    expect(screen.getByTestId("gm-link-step-1")).toBeInTheDocument();
    expect(screen.getByTestId("gm-link-step-2")).toBeInTheDocument();
  });

  it("cleanLinkCode: digits only, at most 6", () => {
    expect(cleanLinkCode("12-34 56789")).toBe("123456");
  });
});

// C4 (founder): Keepr never makes a pairing code any more. Mutation: the
// old IPC brought back → red.
describe("no Keepr-made codes (C4)", () => {
  // SR: the link screen has no Cancel any more, and its IPC is gone too
  // (rcs-import:link-cancel, linkCancel, cancelLink). Mutation: any of them back → red.
  it("no pair-code / pair-cancel / link-cancel IPC in the preload, the handlers or the services", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const root = path.join(__dirname, "..", "..", "..", "..", "..");
    for (const f of [
      "electron/preload/rcsImportBridge.ts",
      "electron/handlers/rcsImportHandlers.ts",
      "src/services/rcsImportService.ts",
      "electron/types/ipc/window-api-rcs-import.ts",
      "electron/services/rcsPairingAuth.ts",
    ]) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect([f, /rcs-import:pair-(code|cancel)|pairCode\(/.test(src)]).toEqual([f, false]);
      expect([f, /rcs-import:link-cancel|\blinkCancel\b|\bcancelLink\b/.test(src)]).toEqual([f, false]);
    }
  });
});
