/**
 * (Linked case — its own file: one page-glue instance per jsdom page.)
 * Founder (live 0.3.57): × on the "Link this browser" card collapsed it to
 * the K tab; a tap on the tab opened a card with NO × to collapse it again.
 * Rule: every card opened from the K tab shows × back to the tab — the same
 * on the first open and on every re-open. (Syncing / stop confirm keep their
 * own controls.) The page glue of job.js, run with a stub worker.
 *
 * Mutations: the idle card without × ; × not collapsing; the tab not
 * reopening the guide when not linked → red.
 */
import * as fs from "fs";
import * as path from "path";

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const job = require("../../chrome-extension/job.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

async function boot(paired: boolean) {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-keepr-job-owner");
  const chromeStub = {
    runtime: {
      id: "ext",
      lastError: undefined,
      getManifest: () => ({ version: "0.3.60" }),
      onMessage: { addListener: () => undefined },
      sendMessage: (m: { type: string }, cb: (r: unknown) => void) => {
        const reply = m.type === "keepr-pair-status" ? { ok: true, paired } : m.type === "keepr-check-pending" ? { ok: false } : { ok: true };
        setTimeout(() => cb(reply), 0);
      },
    },
    storage: { local: { get: (_k: unknown, cb: (r: unknown) => void) => cb({}), set: () => undefined } },
  };
  // The glue runs only when `module` is absent (a content script).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("chrome", "module", SOURCE)(chromeStub, undefined);
  await flush();
  return () => document.getElementById(job.OVERLAY_ID) as HTMLElement;
}

const q = (box: HTMLElement, key: string) => box.querySelector(`[data-keepr="${key}"]`) as HTMLElement | null;

/** A tap on the K tab (no movement: the drag code calls it a tap). */
function tapTab(box: HTMLElement): void {
  const tab = q(box, "drag-handle")!;
  for (const type of ["pointerdown", "pointerup"]) tab.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5, button: 0 }));
}

describe("every card opened from the K tab has × back to it (linked)", () => {
  it("linked: tap → 'Sync from Keepr' with × → tab; the same on the re-open", async () => {
    const box = await boot(true);
    expect(box().getAttribute("data-keepr-state")).toBe("idle");
    for (let round = 0; round < 2; round++) {
      tapTab(box());
      await flush();
      expect([round, q(box(), "line")?.textContent]).toEqual([round, "Sync from Keepr"]);
      const x = q(box(), "close");
      expect([round, !!x]).toEqual([round, true]);
      x!.click();
      await flush();
      expect([round, q(box(), "line")]).toEqual([round, null]);
    }
  });

});
