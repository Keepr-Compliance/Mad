/**
 * BACKLOG-3668 L1: the #keepr-job token is removed from the page URL once
 * job.js has read it (same history.replaceState pattern as #keepr-link).
 *
 * Mutation controls (each turns a test red):
 *   H1 the keepr-job token kept by withoutJobHash         → "only the keepr-job token goes"
 *   H2 the replaceState call after reading the hash gone  → "cleared once read"
 */
export {};

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs") as typeof import("fs");
const path = require("path") as typeof import("path");
const job = require("../../chrome-extension/job.js") as {
  withoutJobHash: (hash: string) => string;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const ID = "00000000-0000-4000-8000-000000000000"; // pii-allow-uuid: invented

describe("#keepr-job leaves the URL once read (L1)", () => {
  it("only the keepr-job token goes", () => {
    expect(job.withoutJobHash(`#keepr-job=${ID}`)).toBe("");
    expect(job.withoutJobHash(`#a=1&keepr-job=${ID}`)).toBe("#a=1");
    expect(job.withoutJobHash(`#keepr-job=${ID}&b=2`)).toBe("#b=2");
    expect(job.withoutJobHash("#keepr-link")).toBe("#keepr-link");
    expect(job.withoutJobHash("")).toBe("");
  });

  it("cleared once read: replaceState right after the hash is read and kept for the tab", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "chrome-extension", "job.js"), "utf8");
    const at = src.indexOf("var hashJob = jobIdFromHash(location.hash);");
    expect(at).toBeGreaterThan(0);
    const next = src.slice(at, at + 700);
    expect(next).toMatch(/sessionStorage\.setItem\(STORAGE_KEY, hashJob\)/);
    expect(next).toMatch(/history\.replaceState\(history\.state, "", location\.pathname \+ location\.search \+ withoutJobHash\(location\.hash\)\)/);
  });
});
