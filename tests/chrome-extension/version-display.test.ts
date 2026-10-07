/**
 * Founder request (2026-10-02): the extension version is shown in the Keepr
 * box (a muted footer of the details), heads Copy details, and is on the
 * first-run options page.
 *
 * Mutations that turn this red: no footer; the Copy header without the
 * version; the options page not reading the manifest version.
 */
import * as fs from "fs";
import * as path from "path";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const job = require("../../chrome-extension/job.js") as Record<string, any>;
const scan = require("../../chrome-extension/scan.js") as Record<string, any>;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const SUMMARY = {
  listed: 1, checked: 1, matched: 1, chats: 1, messages: 1, images: 0, notChecked: 0, contactsWithoutPhone: 0,
  removedByUser: 0, imagesNotKept: 0, notText: 0, noMessagesYet: 0, notSynced: 0, notReached: [], notReachedMore: 0,
};

describe("the extension version", () => {
  it("heads Copy details", () => {
    const copy = job.copyText(SUMMARY, {}, ["step"], "0.3.10") as string;
    expect(copy.split("\n")[0]).toBe("Keepr Sync diagnostics · extension 0.3.10");
    expect((job.copyText(SUMMARY, {}, [], "") as string).split("\n")[0]).toBe("Keepr Sync diagnostics");
  });

  // Founder (2026-10-03): no version line in the box — Copy details and the
  // popup carry it. Mutation: the footer back → red.
  it("is NOT shown in the box (Copy details and the popup carry it)", () => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    job.renderOverlay(box, job.DONE_LINE, false, { details: "Scanned 1 chats", copy: "x", version: "0.3.10" }, {
      copy: async () => true,
      theme: "light",
    });
    expect(box.querySelector('[data-keepr="version"]')).toBeNull();
    expect(box.textContent).not.toContain("0.3.10");
  });

  it("runJob puts env.extensionVersion into the box's extras", async () => {
    const shown: Array<{ version?: string; copy?: string } | undefined> = [];
    const env = {
      doc: document,
      extensionVersion: "0.3.10",
      getLocation: () => ({ pathname: "/web/welcome", href: "https://messages.google.com/web/welcome" }),
      api: async () => ({ ok: true, status: 200, body: { ok: true } }),
      overlay: { show: (_t: string, _e: boolean, x?: { version?: string; copy?: string }) => shown.push(x) },
      sleep: async () => {},
      pageTimeoutMs: 0,
      scan,
    };
    document.body.innerHTML = "";
    await job.runJob("11111111-2222-4333-8444-555555555555", env); // pii-allow-uuid: invented, not from any live row
    const last = shown[shown.length - 1]!;
    expect(last.version).toBe("0.3.10");
    expect(last.copy).toMatch(/^Keepr Sync diagnostics · extension 0\.3\.10/);
  });

  it("is on the first-run options page, from the manifest", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "options.html"), "utf8");
    document.body.innerHTML = /<main>[\s\S]*<\/main>/.exec(html)![0];
    (globalThis as unknown as { chrome: unknown }).chrome = { runtime: { getManifest: () => ({ version: "0.3.10" }) } };
    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../chrome-extension/options.js");
      });
      expect(document.getElementById("keepr-version")!.textContent).toBe("Keepr extension 0.3.10");
    } finally {
      delete (globalThis as unknown as { chrome?: unknown }).chrome;
    }
  });
});
