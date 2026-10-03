/**
 * Live (founder): the page box's "Open Keepr" button, and the eyes' poll.
 *
 * Mutations (each turns a test red):
 *   O1 the box relabels itself "Open Keepr from the taskbar"   → "never from the taskbar"
 *   O2 the page's Open Keepr without the keepr://open fallback  → "falls back to keepr://open"
 *   O3 launchKeepr taking any URL                              → "only keepr://open / link"
 *   O4 the eyes asking every 2 s while refused                 → "the eyes back off"
 */
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const job = require("../../chrome-extension/job.js") as Record<string, any>;
const EXT = path.join(__dirname, "..", "..", "chrome-extension");

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  document.body.innerHTML = "";
});

describe("the box's Open Keepr (live)", () => {
  it("never from the taskbar: a failed focus leaves the button as it is", async () => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    const focus = jest.fn(async () => false);
    job.renderOverlay(box, job.DONE_LINE, false, { details: "d", copy: "c" }, { copy: async () => true, focus, theme: "light" });
    const open = box.querySelector('[data-keepr="open-keepr"]') as HTMLButtonElement;
    open.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(open.textContent).toBe("Open Keepr");
    expect(fs.readFileSync(path.join(EXT, "job.js"), "utf8")).not.toContain("from the taskbar");
  });

  it("falls back to keepr://open from the page when /focus fails", () => {
    const src = fs.readFileSync(path.join(EXT, "job.js"), "utf8").replace(/\r\n/g, "\n");
    const fn = /function focusKeepr\(\) \{[\s\S]*?\n {2}\}/.exec(src)![0];
    expect(fn).toContain('type: "keepr-focus"');
    expect(fn).toContain("if (r && r.ok) return true;");
    expect((fn.match(/launchKeepr\(document, "keepr:\/\/open"\)/g) || []).length).toBe(2);
  });

  it("launchKeepr: only keepr://open / link, a link clicked in the page (no tab, nothing left behind)", () => {
    const launched: string[] = [];
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      launched.push(this.getAttribute("href") || "");
    });
    expect(job.launchKeepr(document, "keepr://callback?x=1")).toBe(false);
    expect(job.launchKeepr(document, "javascript:alert(1)")).toBe(false);
    expect(job.launchKeepr(document, "keepr://open")).toBe(true);
    expect(job.launchKeepr(document, "keepr://link")).toBe(true);
    expect(launched).toEqual(["keepr://open", "keepr://link"]);
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });
});

describe("the eyes back off when refused (live)", () => {
  it("2 s, 4 s, 8 s … not a 2-second spin", async () => {
    jest.useFakeTimers();
    document.body.innerHTML = "<div mwskeynavigation></div>";
    const sent: string[] = [];
    const chromeStub = {
      runtime: {
        id: "ext",
        lastError: undefined,
        onMessage: { addListener: () => undefined },
        sendMessage: (m: { type: string }, cb: (r: unknown) => void) => {
          sent.push(m.type);
          cb({ ok: false, status: 401, body: { error: "not_linked_here" } });
        },
      },
    };
    const g = globalThis as Record<string, unknown>;
    delete g.__keeprEyesInstalled;
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function("chrome", "module", fs.readFileSync(path.join(EXT, "eyes.js"), "utf8"))(chromeStub, undefined);
    for (let t = 0; t < 20; t++) {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    }
    const asks = sent.filter((t) => t === "keepr-exclusions-list").length;
    expect(asks).toBeGreaterThanOrEqual(2);
    expect(asks).toBeLessThanOrEqual(4); // a 2 s spin would be 10
    delete g.__keeprEyesInstalled;
  });
});
