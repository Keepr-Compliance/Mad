/**
 * BACKLOG-3768: HTTP breadcrumbs lose their query string.
 *
 * Input shape MEASURED with @sentry/electron main in Electron 38.8.6
 * (scratchpad 3768-eng/probe-bc.js): net.fetch and net.request each record
 *   { category: "electron.net", type: "http",
 *     data: { url: "<full url incl. query>", method: "GET", status_code: 200 } }
 */

import { scrubHttpBreadcrumb } from "../httpBreadcrumbScrub";

describe("scrubHttpBreadcrumb", () => {
  it("B1: electron.net breadcrumb keeps origin + path, drops the query", () => {
    const out = scrubHttpBreadcrumb({
      category: "electron.net",
      type: "http",
      data: { url: "http://127.0.0.1:57422/rest/v1/users?email=eq.jane@example.com", method: "GET", status_code: 200 },
    });
    expect(out.data).toEqual({ url: "http://127.0.0.1:57422/rest/v1/users", method: "GET", status_code: 200 });
    expect(JSON.stringify(out)).not.toContain("jane@example.com");
  });

  it("B1: fragment dropped; Node-style http.query / http.fragment removed", () => {
    const out = scrubHttpBreadcrumb({
      category: "http",
      type: "http",
      data: { url: "https://x.co/p#frag", "http.query": "email=eq.a@b.c", "http.fragment": "f", "http.method": "GET" },
    });
    expect(out.data).toEqual({ url: "https://x.co/p", "http.method": "GET" });
  });

  it("non-http breadcrumbs are unchanged", () => {
    const b = { category: "electron", type: "ui", data: { url: "x?y=1" } };
    expect(scrubHttpBreadcrumb(b)).toBe(b);
  });
});
