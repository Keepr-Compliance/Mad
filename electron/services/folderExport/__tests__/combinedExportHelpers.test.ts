/**
 * @jest-environment node
 *
 * Unit tests for combinedExportHelpers (BACKLOG-1584).
 * Focus on the load-bearing CSS-scoping and index-link-injection logic that
 * keeps section styles from cross-contaminating in the single combined document.
 */

import {
  scopeCss,
  extractStyleAndBody,
  injectIndexLinks,
  buildCombinedHTML,
  EMAIL_INDEX_ANCHOR,
  TEXT_INDEX_ANCHOR,
  emailThreadSectionId,
  textThreadSectionId,
  textIndexRowId,
  type CombinedSection,
} from "../combinedExportHelpers";

describe("scopeCss", () => {
  it("prefixes ordinary rule selectors with the container class", () => {
    const out = scopeCss(".header { color: red; }", "doc-summary");
    expect(out).toContain(".doc-summary .header");
    expect(out).toContain("color: red");
  });

  it("drops the universal reset so the global reset stays authoritative", () => {
    const out = scopeCss("* { margin: 0; } .x { color: blue; }", "doc-email-thread");
    // The scoped output must NOT re-scope the '*' reset.
    expect(out).not.toMatch(/\.doc-email-thread\s+\*/);
    expect(out).toContain(".doc-email-thread .x");
  });

  it("rewrites body selectors to the container itself", () => {
    const out = scopeCss("body { padding: 40px; }", "doc-summary");
    expect(out).toMatch(/\.doc-summary\s*\{\s*padding: 40px/);
    // Not ".doc-summary body"
    expect(out).not.toContain(".doc-summary body");
  });

  it("scopes comma-separated selector lists element-by-element", () => {
    const out = scopeCss(".a, .b { color: green; }", "doc-text-thread");
    expect(out).toContain(".doc-text-thread .a");
    expect(out).toContain(".doc-text-thread .b");
  });

  it("scopes rules inside @media but keeps the wrapper", () => {
    const out = scopeCss("@media print { body { padding: 20px; } }", "doc-summary");
    expect(out).toContain("@media print");
    expect(out).toMatch(/\.doc-summary\s*\{\s*padding: 20px/);
  });

  it("passes @page through unscoped", () => {
    const out = scopeCss("@page { margin: 1cm; }", "doc-summary");
    expect(out).toContain("@page");
    expect(out).toContain("margin: 1cm");
    expect(out).not.toContain(".doc-summary @page");
  });

  it("handles nested braces in rule bodies without breaking scoping", () => {
    const css = ".msg { background: url('data:image/svg+xml;{}') ; } .next { color: red; }";
    const out = scopeCss(css, "doc-text-thread");
    expect(out).toContain(".doc-text-thread .msg");
    expect(out).toContain(".doc-text-thread .next");
  });
});

describe("extractStyleAndBody", () => {
  it("pulls inner <style> and <body> from a full document", () => {
    const html = `<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body><div>hi</div></body></html>`;
    const parts = extractStyleAndBody(html);
    expect(parts.style).toContain(".a{color:red}");
    expect(parts.body).toContain("<div>hi</div>");
    expect(parts.body).not.toContain("<style>");
  });

  it("falls back to full html as body when <body> is missing", () => {
    const parts = extractStyleAndBody("<div>no body tag</div>");
    expect(parts.style).toBe("");
    expect(parts.body).toContain("no body tag");
  });
});

describe("injectIndexLinks", () => {
  // BACKLOG-2161 founder QA refinement: email rows carry data-multi="true|false"
  // (emitted by summaryHelpers.renderThreadEmailIndex) so the injector can label
  // a multi-email thread row "View Thread →" and a single-email row "View →".
  const summary = `
    <h3>Email Threads Index (2 conversations (3 emails))</h3>
    <div class="email-list">
      <div class="email-item" data-multi="true">
        <div class="header-row">
          <span class="index">001</span>
          <span class="subject">Alpha (2 emails)</span>
        </div>
        <div class="from">a@test.com</div>
      </div>
      <div class="email-item" data-multi="false">
        <div class="header-row">
          <span class="index">002</span>
          <span class="subject">Beta</span>
        </div>
        <div class="from">b@test.com</div>
      </div>
    </div>
    <h3>Text Threads Index (1)</h3>
    <div class="email-list">
      <div class="text-item">
        <div class="header-row">
          <span class="index">001</span>
          <span class="contact">+15551110000 (1 msg)</span>
        </div>
      </div>
    </div>`;

  it("adds heading anchor ids and per-row links (non-summaryOnly)", () => {
    const out = injectIndexLinks(
      summary,
      [emailThreadSectionId(0), emailThreadSectionId(1)],
      [textThreadSectionId(0)],
      false
    );
    expect(out).toContain(`id="${EMAIL_INDEX_ANCHOR}"`);
    expect(out).toContain(`id="${TEXT_INDEX_ANCHOR}"`);
    // Email rows: clickable title + a view link, each to its thread section.
    expect(out).toContain(`href="#${emailThreadSectionId(0)}"`);
    expect(out).toContain(`href="#${emailThreadSectionId(1)}"`);
    // Text row gets a per-row id AND a "View Full" link to its section.
    expect(out).toContain(`id="${textIndexRowId(0)}"`);
    expect(out).toContain(`href="#${textThreadSectionId(0)}"`);
    expect(out).toContain("View Full");
  });

  it("labels a multi-email thread row (data-multi=true) 'View Thread →'", () => {
    const out = injectIndexLinks(
      summary,
      [emailThreadSectionId(0), emailThreadSectionId(1)],
      [textThreadSectionId(0)],
      false
    );
    // Row 1 (Alpha, data-multi="true") gets the thread-specific label.
    const alphaRow = out.slice(out.indexOf("Alpha"), out.indexOf("Alpha") + 200);
    expect(alphaRow).toContain("View Thread &rarr;");
    expect(alphaRow).not.toContain(">View &rarr;<");
  });

  it("labels a single-email group row (data-multi=false) 'View →' (not 'View Thread →')", () => {
    const out = injectIndexLinks(
      summary,
      [emailThreadSectionId(0), emailThreadSectionId(1)],
      [textThreadSectionId(0)],
      false
    );
    // Row 2 (Beta, data-multi="false") gets the plain "View" label.
    const betaRow = out.slice(out.indexOf("Beta"), out.indexOf("Beta") + 200);
    expect(betaRow).toContain('class="view-full-link" href="#email-thread-1">View &rarr;');
    expect(betaRow).not.toContain("View Thread");
  });

  it("text rows keep the unchanged 'View Full →' label", () => {
    const out = injectIndexLinks(
      summary,
      [emailThreadSectionId(0), emailThreadSectionId(1)],
      [textThreadSectionId(0)],
      false
    );
    const textRow = out.slice(out.indexOf("+15551110000"), out.indexOf("+15551110000") + 200);
    expect(textRow).toContain("View Full &rarr;");
  });

  it("summaryOnly adds heading ids but NO links or row ids", () => {
    const out = injectIndexLinks(summary, [], [], true);
    expect(out).toContain(`id="${EMAIL_INDEX_ANCHOR}"`);
    expect(out).toContain(`id="${TEXT_INDEX_ANCHOR}"`);
    expect(out).not.toContain("View Full");
    expect(out).not.toContain("View Thread");
    expect(out).not.toContain('href="#');
    expect(out).not.toContain(`id="${textIndexRowId(0)}"`);
  });
});

describe("buildCombinedHTML", () => {
  it("emits one global reset and scopes each section's styles under its container", () => {
    const indexHtml = `<!DOCTYPE html><html><head><style>body{padding:40px}.header{color:red}</style></head><body><div class="header">Index</div></body></html>`;
    const sections: CombinedSection[] = [
      {
        id: emailThreadSectionId(0),
        html: `<!DOCTYPE html><html><head><style>.header{color:blue}</style></head><body><div class="header">Email</div></body></html>`,
        backHref: `#${EMAIL_INDEX_ANCHOR}`,
        backLabel: "Back to Email Threads Index",
      },
    ];

    const doc = buildCombinedHTML(indexHtml, sections);

    // One global reset.
    expect(doc.match(/\* \{ margin: 0; padding: 0; box-sizing: border-box; \}/g)).toHaveLength(1);
    // Summary .header scoped to doc-summary; email .header scoped to doc-email-thread.
    expect(doc).toContain(".doc-summary .header");
    expect(doc).toContain(".doc-email-thread .header");
    // Section wrapper carries the id and page-break class.
    expect(doc).toContain(`id="${emailThreadSectionId(0)}"`);
    expect(doc).toContain("doc-page-break");
    // Back-link anchor emitted twice (top + bottom of the section).
    expect(doc.match(/class="doc-back-link"/g)).toHaveLength(2);
  });
});
