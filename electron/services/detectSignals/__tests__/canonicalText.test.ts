/**
 * BACKLOG-4257 R3 — canonical text bounds. The body is sender-controlled and
 * the quote strippers run synchronously in the main process.
 *
 * Unbounded times (measured on the moved stripHtmlQuotedContent, M-series Mac):
 *   20k-char dash run        ~1.4 s
 *   20k chars of "<div"      ~1.0 s   (100k: ~25 s)
 *   12k-char unclosed style  ~1.8 s   (cubic; 8k: 0.55 s)
 * Bounded: each under 25 ms. The bound below is PERF_BOUND_MS.
 */
import { MAX_BODY_CHARS, canonicalizeEmail } from "../canonicalText";
import { extractEmailSignals } from "../extractSignals";
import { CTX } from "./fixtures";

const PERF_BOUND_MS = 300;

function timeIt(html: string): number {
  const t = performance.now();
  canonicalizeEmail({ subject: "x", bodyHtml: html, bodyPlain: null });
  return performance.now() - t;
}

describe("R3 — body cap", () => {
  it("text past MAX_BODY_CHARS is not read", () => {
    const filler = "<div>" + "lorem ".repeat(Math.ceil(MAX_BODY_CHARS / 6)) + "</div>";
    const html = `<html><body>${filler}<div>We are under contract.</div></body></html>`;
    const c = canonicalizeEmail({ subject: "x", bodyHtml: html, bodyPlain: null });
    expect(c.truncated).toBe(true);
    const r = extractEmailSignals({ subject: "x", bodyHtml: html, bodyPlain: null, sender: null }, CTX);
    expect(r.signals.stage.underContract).toBe(false);
    expect(r.bodyTruncated).toBe(true);
  });

  it("a long data: URI tag does not use up the cap", () => {
    const img = `<img src="data:image/png;base64,${"A".repeat(MAX_BODY_CHARS)}">`;
    const html = `<html><body>${img}<div>We are under contract.</div></body></html>`;
    const r = extractEmailSignals({ subject: "x", bodyHtml: html, bodyPlain: null, sender: null }, CTX);
    expect(r.bodyTruncated).toBe(false);
    expect(r.signals.stage.underContract).toBe(true);
  });

  it("control: the same sentence inside the cap is read", () => {
    const html = "<html><body><div>We are under contract.</div></body></html>";
    expect(canonicalizeEmail({ subject: "x", bodyHtml: html, bodyPlain: null }).truncated).toBe(false);
    expect(extractEmailSignals({ subject: "x", bodyHtml: html, bodyPlain: null, sender: null }, CTX).signals.stage.underContract).toBe(
      true,
    );
  });
});

describe("R3 — speed on hostile bodies", () => {
  it(`20k-char dash run under ${PERF_BOUND_MS} ms`, () => {
    expect(timeIt("<div>a</div>" + "-".repeat(20_000))).toBeLessThan(PERF_BOUND_MS);
  });

  it(`20k chars of unterminated "<div" under ${PERF_BOUND_MS} ms`, () => {
    expect(timeIt("<div>a</div>" + "<div".repeat(5_000))).toBeLessThan(PERF_BOUND_MS);
  });

  it(`12k-char unclosed style attribute under ${PERF_BOUND_MS} ms`, () => {
    expect(timeIt("<p>a</p><hr style='" + "border-top display:inline-block ".repeat(375))).toBeLessThan(PERF_BOUND_MS);
  });

  it("the bounds keep the quote patterns working", () => {
    const html =
      "<div>Own text.</div>" +
      "-".repeat(40) +
      "<div>-----Original Message-----</div><div>Quoted: inspection booked.</div>";
    const c = canonicalizeEmail({ subject: "x", bodyHtml: html, bodyPlain: null });
    expect(c.ownLines.join("\n")).not.toContain("inspection");
    expect(c.fullLines.join("\n")).toContain("inspection");
  });
});
