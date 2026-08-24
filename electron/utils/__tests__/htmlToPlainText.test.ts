/**
 * @jest-environment node
 *
 * BACKLOG-2855 — unit proofs for the main-process HTML→text converter.
 *
 * This suite is the boundary SWEEP. The mapper-level proof (that
 * `outlookFetchService` actually calls this) and the consequence proof (that a
 * term past the preview cutoff becomes findable by search) live in
 * `electron/services/__tests__/outlookFetchService.bodyPlain-2855.test.ts`.
 * Passing here says the converter is correct; it does NOT say anything is
 * wired to it. Both halves are required.
 *
 * FIXTURE PROVENANCE
 * ------------------
 * The Outlook document skeleton used below is TRANSCRIBED, not invented, from
 * Microsoft Graph v1.0 `Get message` Example 4 ("Get MIME content"), which
 * returns a real message's raw MIME. Its `text/html` part is quoted-printable
 * encoded in the doc (`=3D` for `=`, soft `=` line breaks); it is decoded here.
 * Source: https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0
 *
 * That skeleton is why the `<style>` case is not hypothetical: every Outlook
 * message carries `<style type="text/css" style="display:none;"><!-- P
 * {margin-top:0;margin-bottom:0;} --></style>` in its head. Without stripping,
 * `margin-top` and `margin-bottom` would be indexed as message text in
 * `emails.body_plain` for every Outlook email.
 */

import { htmlToPlainText } from "../htmlToPlainText";

/**
 * Graph `Get message` Example 4, `text/html` MIME part, quoted-printable decoded.
 * Reproduced verbatim apart from that decoding.
 */
const OUTLOOK_SKELETON = `<html>
<head>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">
<style type="text/css" style="display:none;"><!-- P {margin-top:0;margin-bottom:0;} --></style>
</head>
<body dir="ltr">
<div id="divtagdefaultwrapper" style="font-size:12pt;color:#000000;font-family:Calibri,Helvetica,sans-serif;" dir="ltr">
<p>The attachment is an email.</p>
</div>
</body>
</html>`;

describe("htmlToPlainText — empty and non-string input", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
  ])("returns an empty string for %s", (_label, input) => {
    expect(htmlToPlainText(input as string | null | undefined)).toBe("");
  });

  it("returns an empty string for a non-string value", () => {
    // Graph is typed, but `message.body.content` crosses an `any` axios boundary.
    expect(htmlToPlainText(42 as unknown as string)).toBe("");
  });

  it("returns an empty string for markup carrying no text", () => {
    expect(htmlToPlainText("<div><span></span></div>")).toBe("");
  });
});

describe("htmlToPlainText — a real Outlook document", () => {
  it("yields exactly the message text, with no markup and no CSS", () => {
    expect(htmlToPlainText(OUTLOOK_SKELETON)).toBe("The attachment is an email.");
  });

  it("does not leak the head <style> rule body into the text", () => {
    const out = htmlToPlainText(OUTLOOK_SKELETON);
    // The exact tokens that would otherwise be indexed for EVERY Outlook email.
    expect(out).not.toContain("margin-top");
    expect(out).not.toContain("margin-bottom");
    expect(out).not.toContain("text/css");
  });

  it("does not leak head metadata (charset, content-type) into the text", () => {
    const out = htmlToPlainText(OUTLOOK_SKELETON);
    expect(out).not.toContain("iso-8859-1");
    expect(out).not.toContain("Content-Type");
  });
});

describe("htmlToPlainText — script and style blocks", () => {
  it("drops a <script> block INCLUDING its contents", () => {
    const html =
      '<p>Before</p><script type="text/javascript">var secret = "doNotIndexMe";</script><p>After</p>';
    const out = htmlToPlainText(html);
    expect(out).toContain("Before");
    expect(out).toContain("After");
    expect(out).not.toContain("doNotIndexMe");
    expect(out).not.toContain("var secret");
  });

  it("drops a <style> block INCLUDING its contents", () => {
    const html = "<style>.hdr { color: #ff0000; }</style><p>Visible</p>";
    const out = htmlToPlainText(html);
    expect(out).toBe("Visible");
    expect(out).not.toContain("ff0000");
  });

  it("drops an UNTERMINATED <style> block to the end of the document", () => {
    // A browser also swallows this to end-of-document. Without the second pass
    // a truncated block would dump its whole rule set into body_plain.
    const out = htmlToPlainText("<p>Kept</p><style>.a { color: red; }");
    expect(out).toContain("Kept");
    expect(out).not.toContain("color");
  });

  it("is case-insensitive about the block tag name", () => {
    const out = htmlToPlainText("<P>Text</P><SCRIPT>bad()</SCRIPT>");
    expect(out).toContain("Text");
    expect(out).not.toContain("bad()");
  });
});

describe("htmlToPlainText — structural whitespace", () => {
  it("turns <br> into a newline, in every spelling", () => {
    expect(htmlToPlainText("A<br>B<br/>C<br />D")).toBe("A\nB\nC\nD");
  });

  it("collapses a run of <br> into at most one blank line", () => {
    expect(htmlToPlainText("A<br><br><br><br>B")).toBe("A\n\nB");
  });

  it("turns closing block tags into newlines", () => {
    // ONE newline per closing block tag, not a blank line. Verified by
    // execution, not assumed: the first draft of this test asserted "One\n\nTwo"
    // and went red. Paragraph spacing is a rendering concern; this column is
    // read by LIKE matching, where a single separator is what matters.
    expect(htmlToPlainText("<p>One</p><p>Two</p>")).toBe("One\nTwo");
    expect(htmlToPlainText("<div>One</div><div>Two</div>")).toBe("One\nTwo");
    expect(htmlToPlainText("<ul><li>One</li><li>Two</li></ul>")).toBe("One\nTwo");
    expect(htmlToPlainText("<h1>Title</h1><p>Body</p>")).toBe("Title\nBody");
    expect(htmlToPlainText("<tr><td>A</td></tr><tr><td>B</td></tr>")).toBe("A\nB");
  });

  it("separates table cells with a SPACE, not a newline", () => {
    // `<td>123 Main</td><td>Street</td>` must not glue into "123 MainStreet",
    // nor split "123 Main Street" across lines — either breaks a LIKE match.
    expect(htmlToPlainText("<table><tr><td>123 Main</td><td>Street</td></tr></table>")).toBe(
      "123 Main Street",
    );
  });

  it("does NOT insert a newline where the SOURCE merely soft-wrapped", () => {
    // Outlook wraps long lines in the HTML source. A newline inserted mid-phrase
    // here would defeat `body_plain LIKE '%123 Main Street%'`.
    const html = "<p>The property at 123 Main\n   Street closes on Friday.</p>";
    expect(htmlToPlainText(html)).toBe("The property at 123 Main Street closes on Friday.");
  });

  it("drops HTML comments, including Outlook's MSO conditional blocks", () => {
    const html = "<p>Real text</p><!--[if mso]><p>MSO only</p><![endif]-->";
    const out = htmlToPlainText(html);
    expect(out).toContain("Real text");
    expect(out).not.toContain("MSO only");
  });

  it("trims leading and trailing whitespace from the whole result", () => {
    expect(htmlToPlainText("   <p>  Padded  </p>   ")).toBe("Padded");
  });
});

describe("htmlToPlainText — entity decoding", () => {
  it("decodes the named entities that occur in mail bodies", () => {
    expect(htmlToPlainText("Smith &amp; Jones")).toBe("Smith & Jones");
    expect(htmlToPlainText("a &lt; b &gt; c")).toBe("a < b > c");
    expect(htmlToPlainText("&quot;quoted&quot;")).toBe('"quoted"');
    expect(htmlToPlainText("it&apos;s")).toBe("it's");
  });

  it("decodes &nbsp; to a REGULAR space, not U+00A0", () => {
    // A non-breaking space stored in body_plain silently defeats
    // `body_plain LIKE '%two words%'` — the exact failure this module removes.
    const out = htmlToPlainText("two&nbsp;words");
    expect(out).toBe("two words");
    expect(out).not.toContain(" ");
  });

  it("decodes decimal numeric entities", () => {
    expect(htmlToPlainText("it&#39;s a &#8212; dash")).toBe("it's a — dash");
  });

  it("decodes hexadecimal numeric entities", () => {
    expect(htmlToPlainText("it&#x27;s a &#x2014; dash")).toBe("it's a — dash");
  });

  it("leaves a malformed numeric entity as literal text rather than throwing", () => {
    // One bad entity must never cost the whole message body.
    expect(htmlToPlainText("&#999999999;")).toBe("&#999999999;");
    expect(htmlToPlainText("&#xD800;")).toBe("&#xD800;");
  });

  it("decodes entities AFTER stripping tags, so escaped markup stays text", () => {
    // The sender typed the characters `<b>`. They are content, not markup, and
    // decoding before stripping would turn them into a tag and delete them.
    expect(htmlToPlainText("<p>Use &lt;b&gt; for bold</p>")).toBe("Use <b> for bold");
  });

  it("does not double-decode &amp;lt;", () => {
    expect(htmlToPlainText("&amp;lt;")).toBe("&lt;");
  });
});

describe("htmlToPlainText — plain text passed through", () => {
  it("returns tag-free input essentially unchanged", () => {
    expect(htmlToPlainText("Just a sentence with no markup.")).toBe(
      "Just a sentence with no markup.",
    );
  });
});
