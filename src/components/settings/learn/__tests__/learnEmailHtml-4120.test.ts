/**
 * BACKLOG-4120 PR3 — the Learn mode email sanitizer (images blocked by
 * default, "Show images" per email) and the "what Keepr read" highlight.
 * Synthetic data only (example.test, Canarytest).
 */
import {
  INLINE_IMAGE_PLACEHOLDER,
  displayAddress,
  hasRemoteImages,
  highlightHtml,
  highlightPdfText,
  sanitizeLearnEmailHtml,
  streetPhraseRegex,
  streetTokenRegex,
} from "../learnEmailHtml";

/** Every way the corpus found a message can pull a remote image. */
const REMOTE = [
  `<p>Canaryhtml</p>`,
  `<img src="https://tracker.example.test/pixel.gif" width="1" height="1">`,
  `<img src='http://tracker.example.test/plain.gif'>`,
  `<img src="https://tracker.example.test/a.png" srcset="https://tracker.example.test/b.png 2x">`,
  `<table background="https://tracker.example.test/bg.png"><tr><td style="background-image:url('https://tracker.example.test/td.png')">cell</td></tr></table>`,
  `<div style="background: #fff url(https://tracker.example.test/div.png) no-repeat">box</div>`,
].join("");

function parse(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

function remoteRefs(html: string): string[] {
  const el = parse(html);
  const out: string[] = [];
  el.querySelectorAll("*").forEach((n) => {
    for (const attr of Array.from(n.attributes)) {
      if (/https?:/i.test(attr.value)) out.push(`${n.tagName.toLowerCase()}[${attr.name}]`);
    }
  });
  return out;
}

describe("IMG images are blocked until Show images", () => {
  it("images off: no http(s) src, no srcset, no background attribute, no url() in style", () => {
    const { html, blockedImages } = sanitizeLearnEmailHtml(REMOTE, { showImages: false });
    expect(remoteRefs(html)).toEqual([]);
    expect(html).not.toMatch(/url\s*\(/i);
    expect(html).not.toMatch(/srcset|background=/i);
    expect(blockedImages).toBeGreaterThanOrEqual(5);
    expect(html).toContain("Canaryhtml");
    expect(hasRemoteImages(REMOTE)).toBe(true);
  });

  it("images on: the remote img sources come back (srcset and background attributes stay out)", () => {
    const { html, blockedImages } = sanitizeLearnEmailHtml(REMOTE, { showImages: true });
    const imgs = Array.from(parse(html).querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(imgs).toEqual([
      "https://tracker.example.test/pixel.gif",
      "http://tracker.example.test/plain.gif",
      "https://tracker.example.test/a.png",
    ]);
    expect(html).toMatch(/url\(/i);
    expect(blockedImages).toBe(0);
  });

  it("embedded data: images display either way; cid: parts become a placeholder", () => {
    const raw = `<img src="data:image/png;base64,iVBORw0KGgo="><img src="cid:part1.abc@example.test">`;
    for (const showImages of [false, true]) {
      const { html } = sanitizeLearnEmailHtml(raw, { showImages });
      const imgs = Array.from(parse(html).querySelectorAll("img")).map((i) => i.getAttribute("src"));
      expect(imgs).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
      expect(html).toContain(INLINE_IMAGE_PLACEHOLDER);
      expect(html).not.toContain("cid:");
    }
  });

  it("links are inert and script / handlers never survive", () => {
    const raw = `<a href="https://phish.example.test/x">Click</a><script>alert(1)</script><img src="x" onerror="alert(2)"><p onclick="x()">t</p>`;
    const { html } = sanitizeLearnEmailHtml(raw, { showImages: true });
    expect(html).toContain("Click");
    expect(html).not.toMatch(/href|script|onerror|onclick|alert/i);
  });

  it("an email with no remote image needs no Show images button", () => {
    expect(hasRemoteImages(`<p>plain</p><img src="data:image/png;base64,AAAA">`)).toBe(false);
  });
});

describe("HL what Keepr read", () => {
  // The detection address as analyzeEmail/groupByProperty produce it (learnModeHandlers-4120 dump).
  const ADDRESS = "4120 canarytest lane, testville, zz 00000";

  it("marks the street line as one phrase, across whitespace and case", () => {
    const html = highlightHtml(`<p>Offer on 4120 Canarytest\n  Lane, Testville today</p>`, streetPhraseRegex(ADDRESS));
    expect(Array.from(parse(html).querySelectorAll("mark")).map((m) => m.textContent)).toEqual([
      "4120 Canarytest\n  Lane",
    ]);
  });

  it("marks the PDF text-layer pieces and escapes the rest", () => {
    expect(highlightPdfText("Property: 4120 <Canarytest> Ln", streetTokenRegex(ADDRESS))).toBe(
      'Property: <mark class="rounded-sm bg-yellow-100 px-0.5">4120</mark> &lt;<mark class="rounded-sm bg-yellow-100 px-0.5">Canarytest</mark>&gt; Ln',
    );
  });

  it("shows the address with capitals", () => {
    expect(displayAddress(ADDRESS)).toBe("4120 Canarytest Lane, Testville, ZZ 00000");
  });
});
