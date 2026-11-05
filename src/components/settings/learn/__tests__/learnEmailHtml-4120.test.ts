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

/**
 * CSS-borne resources while images are off. Synthetic hostile mail only
 * (h.example.test). Every inline style that survives images-off must call no
 * CSS function but a colour, carry no escape, and name no URL.
 */
const HOST = "h.example.test";

function styleValues(html: string): string[] {
  return Array.from(parse(html).querySelectorAll("[style]")).map((n) => (n.getAttribute("style") ?? "").toLowerCase());
}

function expectNothingLoads(html: string): void {
  expect(html).not.toContain(HOST);
  for (const v of styleValues(html)) {
    expect(v).not.toMatch(/\\|url\s*\(|http|@|\/\//);
    for (const m of v.matchAll(/([a-z0-9_-]*)\s*\(/g)) expect(["rgb", "rgba", "hsl", "hsla"]).toContain(m[1]);
  }
}

describe("CSS images off: declarations that can load something", () => {
  // [label, inline style]. Each one asks the renderer for HOST.
  const VECTORS: Array<[string, string]> = [
    ["hex escape inside url", `background:u\\72 l(https://${HOST}/p1.png)`],
    ["hex escape for the u", `background-image:\\75rl(https://${HOST}/p2.png)`],
    ["image-set", `background-image:image-set("https://${HOST}/p3.png" 1x)`],
    ["-webkit-image-set", `background-image:-webkit-image-set("https://${HOST}/p4.png" 1x)`],
    ["uppercase IMAGE-SET", `BACKGROUND-IMAGE:IMAGE-SET( "https://${HOST}/p5.png" 1X )`],
    ["uppercase escape U\\52 L", `BACKGROUND:U\\52 L(https://${HOST}/p6.png)`],
    ["newline and tab inside -webkit-image-set", `background:\n -webkit-image-set(\t'https://${HOST}/p7.png' 1x)`],
    ["escaped property name", `b\\61 ckground-image:url(https://${HOST}/p8.png)`],
    ["escaped scheme", `background:url(h\\74tps://${HOST}/p9.png)`],
    ["escaped paren", `background:url\\28 https://${HOST}/p10.png)`],
    ["whitespace before url paren", `background:url (https://${HOST}/p11.png)`],
    ["list-style-image", `list-style-image:url(https://${HOST}/l.png)`],
    ["list-style shorthand", `list-style:square url(https://${HOST}/l2.png)`],
    ["content", `content:url(https://${HOST}/c.png)`],
    ["border-image", `border-image:url(https://${HOST}/b.png) 30 round`],
    ["border-image-source", `border-image-source:url(https://${HOST}/b2.png)`],
    ["cursor", `cursor:url(https://${HOST}/cur.png),auto`],
    ["mask-image", `mask-image:url(https://${HOST}/m.png)`],
    ["-webkit-mask", `-webkit-mask:url(https://${HOST}/m2.png)`],
    ["filter", `filter:url(https://${HOST}/f.svg#x)`],
    ["clip-path", `clip-path:url(https://${HOST}/cp.svg#x)`],
    ["shape-outside", `shape-outside:url(https://${HOST}/so.png)`],
    ["custom property", `--x:url(https://${HOST}/v.png);background:var(--x)`],
    ["cross-fade", `background-image:cross-fade(url(https://${HOST}/x1.png),url(https://${HOST}/x2.png),50%)`],
  ];

  it.each(VECTORS)("%s: dropped, counted, and named by hasRemoteImages", (_label, style) => {
    const raw = `<div style="${style.replace(/"/g, "&quot;")}">Canarycss</div>`;
    const off = sanitizeLearnEmailHtml(raw, { showImages: false });
    expectNothingLoads(off.html);
    expect(off.html).toContain("Canarycss");
    expect(off.blockedImages).toBeGreaterThanOrEqual(1);
    expect(hasRemoteImages(raw)).toBe(true);
  });

  it.each(VECTORS.slice(0, 7))("%s: kept once Show images is pressed", (_label, style) => {
    const raw = `<div style="${style.replace(/"/g, "&quot;")}">Canarycss</div>`;
    const on = sanitizeLearnEmailHtml(raw, { showImages: true });
    expect(on.html).toContain(HOST);
    expect(on.blockedImages).toBe(0);
  });

  it.each([
    ["@import", `<style>@import url(https://${HOST}/a.css);</style>`],
    ["@import string", `<style>@import "https://${HOST}/a2.css";</style>`],
    ["@font-face", `<style>@font-face{font-family:x;src:url(https://${HOST}/f.woff)}</style>`],
    ["style rule", `<style>body{background:URL( "https://${HOST}/b.png" )}</style>`],
    ["uppercase STYLE", `<STYLE>p{list-style-image:url(https://${HOST}/l.png)}</STYLE>`],
  ])("<style> block with %s: never kept, and no Show images bar for it", (_label, block) => {
    const raw = `${block}<p>Canarycss</p>`;
    for (const showImages of [false, true]) {
      const { html, blockedImages } = sanitizeLearnEmailHtml(raw, { showImages });
      expect(html).not.toContain(HOST);
      expect(html).not.toMatch(/<style|@import|@font-face/i);
      expect(html).toContain("Canarycss");
      expect(blockedImages).toBe(0);
    }
    expect(hasRemoteImages(raw)).toBe(false);
  });

  it("plain formatting survives images off and needs no Show images bar", () => {
    const raw = `<td style="color:#333;font-family:'Helvetica Neue',Arial;background-color:rgb(1,2,3);background:#fff;padding:4px 8px;border:1px solid hsl(0,0%,80%);list-style:disc;cursor:pointer">Canarycss</td>`;
    const { html, blockedImages } = sanitizeLearnEmailHtml(`<table><tr>${raw}</tr></table>`, { showImages: false });
    const style = styleValues(html)[0];
    for (const kept of ["color:#333", "font-family:'helvetica neue',arial", "background-color:rgb(1,2,3)", "background:#fff", "padding:4px 8px", "border:1px solid hsl(0,0%,80%)", "list-style:disc", "cursor:pointer"]) {
      expect(style).toContain(kept);
    }
    expect(blockedImages).toBe(0);
    expect(hasRemoteImages(raw)).toBe(false);
  });
});

describe("RD the email cannot cover the question", () => {
  const RAW =
    `<div class="fixed inset-0 z-50" style="position:fixed;inset:0;z-index:99999;top:0;left:0;right:0;bottom:0;inset-inline:0;color:#111">Canaryredress</div>` +
    `<div style="POSITION : ABSOLUTE; Z-INDEX:9;p\\6fsition:fixed">x</div>`;

  it.each([false, true])("images %s: no position, offsets, z-index or class survive; colour does", (showImages) => {
    const { html } = sanitizeLearnEmailHtml(RAW, { showImages });
    expect(html).toContain("Canaryredress");
    expect(html).not.toMatch(/class=/i);
    for (const v of styleValues(html)) {
      expect(v).not.toMatch(/position|p\\6fsition|z-index|inset|(^|;)\s*(top|left|right|bottom)\s*:/);
    }
    expect(styleValues(html)).toContain("color:#111");
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
