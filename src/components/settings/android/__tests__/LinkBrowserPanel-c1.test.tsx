/**
 * C1 (UX redesign) — Keepr's link card (storyboards D01–D05, F01–F02): the
 * code is typed here (Keepr never makes one); the 6th digit submits by
 * itself; the field says the state and its colour always wins over focus.
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
const mockOpenMessages = jest.fn(async () => undefined);
let mockOpenLinkScreen: (() => void) | null = null;
jest.mock("../../../../services/rcsImportService", () => ({
  rcsImportService: {
    linkState: async () => ({ success: true, data: { link: mockLink, linked: mockLinked } }),
    linkEnterCode: (code: string) => mockEnter(code),
    linkDismissWarning: async () => undefined,
    openGoogleMessages: () => mockOpenMessages(),
    onOpenLinkScreen: (cb: () => void) => {
      mockOpenLinkScreen = cb;
      return () => {
        mockOpenLinkScreen = null;
      };
    },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { LinkBrowserPanel, LINK_COPY, FIELD_COLORS, cleanLinkCode } = require("../LinkBrowserPanel") as typeof import("../LinkBrowserPanel");

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};
const tick = async () => {
  await act(async () => {
    jest.advanceTimersByTime(1000);
  });
  await flush();
};
/** jsdom keeps a hex border-color as written (lower case), a background as rgb(). */
const rgb = (hex: string) => hex.toLowerCase();
const bg = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const waiting = (triesLeft = 5): Link => ({ state: "waiting", expiresAt: Date.now() + 90_000, triesLeft, intrusion: false });

beforeEach(() => {
  jest.useFakeTimers();
  mockLink = { state: "none", intrusion: false };
  mockLinked = false;
  mockEnter.mockClear();
  mockOpenMessages.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("LinkBrowserPanel", () => {
  // Mutations: a step missing or reordered; Open Google Messages not wired;
  // a paragraph back → red.
  it("the two-step card (D01): title, 1 Open Google Messages, 2 Type the code from Chrome", async () => {
    render(<LinkBrowserPanel />);
    await flush();
    const panel = screen.getByTestId("gm-link-panel");
    expect(Array.from(panel.children).map((c) => c.getAttribute("data-testid"))).toEqual(["gm-link-title", "gm-link-step-1", "gm-link-step-2"]);
    expect(screen.getByTestId("gm-link-title")).toHaveTextContent("Link your browser");
    const open = screen.getByTestId("gm-link-open-messages");
    for (const c of ["flex-grow", "min-h-[48px]", "rounded-[10px]", "bg-[#4F46E5]", "text-white", "font-bold"]) expect(open.className.split(" ")).toContain(c);
    fireEvent.click(open);
    expect(mockOpenMessages).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("gm-link-step-2")).toHaveTextContent("Type the code from Chrome");
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    expect(input.placeholder).toBe("000 000");
    for (const c of ["min-h-[52px]", "border-2", "rounded-[10px]", "font-mono", "text-[26px]", "tracking-[0.2em]"]) expect(input.className.split(" ")).toContain(c);
    // Founder Option 1: focused on arrival (the focus ring is indigo).
    expect(document.activeElement).toBe(input);
    expect(input.style.borderColor).toBe(rgb(FIELD_COLORS.idle.focus));
    fireEvent.blur(input);
    expect(input.style.borderColor).toBe(rgb("#CDD1DE"));
    expect(screen.queryByTestId("gm-link-submit")).toBeNull();
    expect(panel.querySelectorAll("p")).toHaveLength(0);
  });

  // Mutations: 5 digits sent; no auto-submit; a second submit while checking; no spinner → red.
  it("the 6th digit submits by itself (typed or pasted); 5 digits never", async () => {
    mockLink = waiting();
    render(<LinkBrowserPanel />);
    await flush();
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

  // D05 (founder): the green border + ✓ INSIDE the field only (no "✓ Linked"
  // line, no Sync now here); the parent is told. Mutations: an outside line
  // back; not green; the parent not told → red.
  it("linked: green border + tint, ✓ inside the field — nothing outside; the parent is told", async () => {
    mockLink = waiting();
    const onJustLinked = jest.fn();
    render(<LinkBrowserPanel onJustLinked={onJustLinked} />);
    await flush();
    await act(async () => {
      fireEvent.change(screen.getByTestId("gm-link-code"), { target: { value: "482913" } });
    });
    mockLink = { state: "none", intrusion: false };
    mockLinked = true;
    await tick();
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    expect(input.style.borderColor).toBe(rgb("#15803D"));
    expect(input.style.background).toBe(bg("#F0FDF4"));
    expect(screen.getByTestId("gm-link-ok")).toHaveTextContent("✓");
    expect(onJustLinked).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("gm-link-just-linked")).toBeNull();
    expect(screen.queryByTestId("gm-link-sync-now")).toBeNull();
    expect(screen.getByTestId("gm-link-step-2").textContent).not.toMatch(/Linked/);
  });

  // F01 / F02. Mutations: not red; the red cleared before typing; a
  // "Retype the code" placeholder; used up not disabled / grey → red.
  it("wrong: RED border until the user types, 'Code didn't match · N tries left', placeholder 000 000; used up: disabled + grey", async () => {
    mockLink = waiting();
    render(<LinkBrowserPanel />);
    await flush();
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "111111" } });
    });
    mockLink = waiting(4);
    await tick();
    expect(screen.getByTestId("gm-link-error")).toHaveTextContent("Code didn't match · 4 tries left");
    expect(input.style.borderColor).toBe(rgb("#B42318"));
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("000 000");
    await tick(); // still red with time passing
    expect(input.style.borderColor).toBe(rgb("#B42318"));
    fireEvent.change(input, { target: { value: "2" } });
    expect(input.style.borderColor).not.toBe(rgb("#B42318"));
    await act(async () => {
      fireEvent.change(input, { target: { value: "222222" } });
    });
    mockLink = { state: "none", intrusion: false }; // the last try burned the code
    await tick();
    expect(screen.getByTestId("gm-link-error")).toHaveTextContent(LINK_COPY.usedUp);
    expect(input.disabled).toBe(true);
    expect(input.tabIndex).toBe(-1);
    expect(input.placeholder).toBe("");
    expect(input.style.background).toBe(bg("#F9FAFB"));
    expect(input.style.borderColor).toBe(rgb("#E5E7EB"));
    // A new code from Chrome: the field is back.
    mockLink = waiting();
    await tick();
    expect(input.disabled).toBe(false);
  });

  // (a) live D5 / F1: a focus outline overrode the state colour. Mutations:
  // the outline back; focus taking over the state border → red.
  it("focused: the state colour wins — no outline; the ring is the state's own colour", async () => {
    mockLink = waiting();
    render(<LinkBrowserPanel />);
    await flush();
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    fireEvent.focus(input);
    expect(input.style.outline).toBe("none");
    expect(input.style.borderColor).toBe(rgb(FIELD_COLORS.idle.focus));
    expect(input.style.boxShadow).toContain(FIELD_COLORS.idle.focus);
    await act(async () => {
      fireEvent.change(input, { target: { value: "111111" } });
    });
    mockLink = waiting(4);
    await tick();
    fireEvent.focus(input);
    expect(input.style.outline).toBe("none");
    expect(input.style.borderColor).toBe(rgb("#B42318"));
    expect(input.style.boxShadow).toContain("#B42318");
  });

  // Founder Option 1: the extension brings Keepr forward with a code waiting
  // (/focus → the link screen): the field takes focus again. Mutations: not
  // focused on arrival; the open-link-screen signal ignored → red.
  it("the extension brings Keepr forward: the code field is focused again", async () => {
    mockLink = waiting();
    render(<LinkBrowserPanel />);
    await flush();
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    input.blur();
    expect(document.activeElement).not.toBe(input);
    expect(mockOpenLinkScreen).not.toBeNull();
    await act(async () => {
      mockOpenLinkScreen!();
      jest.advanceTimersByTime(1);
    });
    expect(document.activeElement).toBe(input);
  });

  // Live (0.3.57, Windows): the DOM focus ran before the window had keyboard
  // focus. After the open-link signal the field is focused again when the
  // WINDOW reports focus (one retry), with any value selected. Mutations: no
  // window-focus retry; the retry kept forever; nothing selected → red.
  it("after the open-link signal: focused again on the window's focus event (once), value selected", async () => {
    mockLink = waiting();
    render(<LinkBrowserPanel />);
    await flush();
    const input = screen.getByTestId("gm-link-code") as HTMLInputElement;
    // Elsewhere on the page (another control takes focus, as a click would).
    const other = document.createElement("button");
    document.body.appendChild(other);
    fireEvent.change(input, { target: { value: "12" } });
    await act(async () => {
      mockOpenLinkScreen!();
      jest.advanceTimersByTime(1);
    });
    other.focus();
    expect(document.activeElement).not.toBe(input);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2]);
    // One retry only: a later window focus leaves focus where the user put it.
    other.focus();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).not.toBe(input);
  });

  it("a refused code says why, and the field is cleared", async () => {
    mockLink = waiting();
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
    expect(onLinked).toHaveBeenCalledTimes(1);
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
