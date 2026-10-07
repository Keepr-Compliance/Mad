/**
 * @jest-environment node
 *
 * BACKLOG-3774 — differential proof that the linear-time `htmlToPlainText`
 * returns EXACTLY what the previous implementation returned, for every input.
 *
 * The oracle below is the pre-3774 implementation, FROZEN verbatim (code only;
 * comments dropped, identifiers prefixed `legacy`). It is deliberately NOT
 * imported from source: if it were, any change to the module would change the
 * oracle with it and this test could never go red.
 *
 * Why this ships rather than being run once: the most likely wrong
 * implementation of the step-1 tail handling (deciding "the block ran to the
 * end" without checking that its close tag was absent) is linear, passes every
 * test in `htmlToPlainText.test.ts`, and differs only on inputs shaped like
 * `<style></style>x`. Only an input sweep like this one sees it.
 *
 * Corpus (deterministic, no randomness between runs):
 *   1. every string literal in the existing htmlToPlainText suites;
 *   2. character-level exhaustive strings over a small markup alphabet;
 *   3. token-level exhaustive strings to depth 3;
 *   4. seeded pseudo-random token strings, with forced boundary shapes.
 *
 * Timeouts are explicit (60 s per test): the corpus is a few seconds locally
 * and must not trip jest's 5 s default on a slower Windows runner.
 */

import { readFileSync } from "fs";
import * as path from "path";
import { htmlToPlainText } from "../htmlToPlainText";

// ---------------------------------------------------------------------------
// Frozen oracle — pre-BACKLOG-3774 implementation. DO NOT EDIT.
// ---------------------------------------------------------------------------
function legacyDecodeHtmlEntities(input: string): string {
  let out = input;

  out = out.replace(/&nbsp;/gi, " ");
  out = out.replace(/&lt;/gi, "<");
  out = out.replace(/&gt;/gi, ">");
  out = out.replace(/&quot;/gi, '"');
  out = out.replace(/&apos;/gi, "'");

  const fromCodePoint = (code: number, original: string): string => {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return original;
    if (code >= 0xd800 && code <= 0xdfff) return original;
    try {
      return String.fromCodePoint(code);
    } catch {
      return original;
    }
  };
  out = out.replace(/&#x([0-9a-f]+);/gi, (m, hex: string) =>
    fromCodePoint(parseInt(hex, 16), m),
  );
  out = out.replace(/&#(\d+);/g, (m, dec: string) =>
    fromCodePoint(parseInt(dec, 10), m),
  );

  out = out.replace(/&amp;/gi, "&");

  return out;
}

const LEGACY_BLOCK_CLOSE_TAGS =
  /<\/(?:p|div|tr|li|h[1-6]|blockquote|table|ul|ol|section|article|pre|address|figure|dd|dt|dl)\s*>/gi;

const LEGACY_CELL_CLOSE_TAGS = /<\/(?:td|th)\s*>/gi;

const LEGACY_LINE_BREAK_TAGS = /<br\s*\/?\s*>/gi;

function legacyHtmlToPlainText(html: string | null | undefined): string {
  if (!html || typeof html !== "string") return "";

  let text = html;

  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ");

  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  text = text.replace(/\s+/g, " ");

  text = text.replace(LEGACY_LINE_BREAK_TAGS, "\n");
  text = text.replace(LEGACY_CELL_CLOSE_TAGS, " ");
  text = text.replace(LEGACY_BLOCK_CLOSE_TAGS, "\n");

  text = text.replace(/<[^>]*>/g, "");

  text = legacyDecodeHtmlEntities(text);

  text = text.replace(/\r\n?/g, "\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00A0]+/g, " ").trim())
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 60_000;

interface Tally {
  total: number;
  mismatches: number;
  examples: string[];
}

function newTally(): Tally {
  return { total: 0, mismatches: 0, examples: [] };
}

function check(t: Tally, input: string): void {
  t.total++;
  if (legacyHtmlToPlainText(input) !== htmlToPlainText(input)) {
    t.mismatches++;
    if (t.examples.length < 5) t.examples.push(JSON.stringify(input));
  }
}

function expectNoMismatch(t: Tally, minTotal: number): void {
  // A zero-input sweep would pass vacuously; assert the corpus actually ran.
  expect(t.total).toBeGreaterThanOrEqual(minTotal);
  expect({ mismatches: t.mismatches, examples: t.examples }).toEqual({
    mismatches: 0,
    examples: [],
  });
}

/** Deterministic LCG, so a failure reproduces exactly. */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function exhaustive(t: Tally, alphabet: readonly string[], depth: number, prefix = ""): void {
  check(t, prefix);
  if (depth === 0) return;
  for (const piece of alphabet) exhaustive(t, alphabet, depth - 1, prefix + piece);
}

const CHAR_ALPHABET = ["<", ">", "!", "-", "/", "s", " "] as const;

const TOKENS = [
  "<", ">", "!", "-", "/", " ", "\n", "\r", "\t", "a", "S", "x",
  "<script", "<SCRIPT ", "<script>", "</script>", "</script", "</Script >", "</SCRIPT  >",
  "<style>", "<STYLE", "<Style>", "</style>", "</STYLE\n>", "</style\t>", "</sTyLe>",
  "<style/>", "<scripts>", "<scriptx", "<style-x>", "<style >", "<script<", "</scr", "ipt>",
  "<!--", "-->", "<!---->", "<!-->", "--->", "<!-", "--!>", "<![CDATA[", "]]>",
  "<!-- <script> -->", "<script><!--", "--></script>", "<style><!--",
  "<br", "<br/>", "<br\n/>", "</p>", "</p\r\n>", "</td>", "</div  >", "<a href='>'>",
  "&", "#", "1", ";", "&lt;", "&amp;", "&#x41;", "&#65;", "&#x3c;", "&#60;", "&nbsp;",
  "&lt;script&gt;", " ", " ", "ſ", "K", "ı", "İ",
  "é", "😀", "\uD83D", "\uDE00", ">x", "> ",
] as const;

const DEPTH3_TOKENS = [
  "<", ">", "!", "-", "/", " ", "\n", "a", "S", "<script", "<SCRIPT ", "<style>",
  "</script", "</style>", "</Script >", "<!--", "-->", "<br", "<br/>", "</p>",
  "</td>", "</div  >", "&", "#", "x", "1", ";", "&lt;", "&amp;", "&#x41;", "&#65;",
  "&nbsp;", "\r", " ", " ", "ſ", "K", "ı", "İ",
  "<scriptx", ">x",
] as const;

/** Every string literal in a source file (the existing suites' fixtures). */
function stringLiterals(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const found: string[] = [];
  for (const m of src.matchAll(/`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
    if (m[1] !== undefined) {
      found.push(m[1]);
      continue;
    }
    const raw = (m[2] ?? m[3]) as string;
    try {
      found.push(JSON.parse('"' + raw.replace(/\\'/g, "'") + '"') as string);
    } catch {
      found.push(raw);
    }
  }
  return found;
}

describe("htmlToPlainText — identical output to the pre-BACKLOG-3774 implementation", () => {
  it(
    "matches on every string literal in the existing converter suites",
    () => {
      const repo = path.resolve(__dirname, "../../..");
      const files = [
        "electron/utils/__tests__/htmlToPlainText.test.ts",
        "electron/services/__tests__/outlookFetchService.bodyPlain-2855.test.ts",
        "src/components/transactionDetailsModule/components/modals/__tests__/EmailThreadViewModal.threadBubble-2862.test.tsx",
      ];
      const t = newTally();
      for (const f of files) for (const s of stringLiterals(path.join(repo, f))) check(t, s);
      expectNoMismatch(t, 100);
    },
    TIMEOUT_MS,
  );

  it(
    "matches on every string over a markup alphabet up to length 7",
    () => {
      const t = newTally();
      exhaustive(t, CHAR_ALPHABET, 7);
      expectNoMismatch(t, 960_000);
    },
    TIMEOUT_MS,
  );

  it(
    "matches on every sequence of up to 3 markup tokens",
    () => {
      const t = newTally();
      exhaustive(t, DEPTH3_TOKENS, 3);
      expectNoMismatch(t, 70_000);
    },
    TIMEOUT_MS,
  );

  it(
    "matches on seeded random token strings, including forced boundary shapes",
    () => {
      const t = newTally();
      const rnd = makeRng(987654321);
      const pick = (): string => TOKENS[Math.floor(rnd() * TOKENS.length)];
      for (let i = 0; i < 150_000; i++) {
        let s = "";
        const len = 1 + Math.floor(rnd() * (i % 3 === 0 ? 120 : 25));
        for (let j = 0; j < len; j++) s += pick();
        check(t, s);
        if (i % 5 === 0) {
          // The last `>` is a close tag / an opener / no `-->` follows.
          check(t, s + "</style>" + (rnd() < 0.5 ? "tail<" : ""));
          check(t, s + "</script >x");
          check(t, "<style>" + s);
          check(t, s + "<!--");
          check(t, s + "-->x");
        }
      }
      expectNoMismatch(t, 300_000);
    },
    TIMEOUT_MS,
  );
});
