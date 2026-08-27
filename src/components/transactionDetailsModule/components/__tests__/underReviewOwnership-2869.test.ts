/**
 * BACKLOG-2869 — `under_review` belongs to the broker portal. The desktop app
 * may READ it, MIRROR it and LABEL it. It may not ORIGINATE it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS GUARD EXISTS
 * ---------------------------------------------------------------------------
 * The founder asked that a submitted deal awaiting review should say "under
 * review". The tempting reading is to move the ROW — flip `submitted` to
 * `under_review` on submit. That would be wrong: in the portal `under_review`
 * means a human opened the file, and `submissionSyncService` treats an inbound
 * change to it as a real event (it raises the "Submission Under Review"
 * notification). An app that wrote the value itself would manufacture that
 * event for a deal nobody had looked at. BACKLOG-2869 is satisfied by the
 * LABEL alone — see SUBMISSION_STATUS_BADGE in TransactionHeader.tsx.
 *
 * ---------------------------------------------------------------------------
 * ORIGINATES, NOT WRITES — THE DISTINCTION IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * The app DOES write `under_review` into the local SQLite row, legitimately:
 * `submissionSyncService` reads `cloud.status` from Supabase and passes it to
 * `submissionDbService.updateTransactionSubmissionStatus(id, cloudStatus, …)`.
 * That is a mirror of the portal's decision, and the value arrives as a
 * VARIABLE. What this guard forbids is the app naming the string itself in a
 * write position — a literal `"under_review"` being assigned, passed to a
 * writer, or set as a property value.
 *
 * So the detector below is deliberately LITERAL-based. A pass-through of a
 * variable is invisible to it, and that is the correct behaviour, not a gap.
 *
 * ---------------------------------------------------------------------------
 * THE SCAN IS FALSIFIABLE
 * ---------------------------------------------------------------------------
 * A source scan that finds nothing proves nothing until it has been shown to
 * find something. `findUnderReviewOriginations` is a pure
 * (filename, contents) function, so the four write shapes are fed to it as
 * synthetic positives and the six read shapes as synthetic negatives, in this
 * file, before it is ever pointed at the repo. A scan that silently stopped
 * matching would fail those cases first.
 *
 * KNOWN LIMIT, STATED: this reads text, not a syntax tree. A write assembled
 * from a variable (`const s = "under" + "_review"`), or reached through a
 * template literal, is not caught. It is a guard against the obvious change
 * someone would make while implementing the founder's ask, not a proof of
 * impossibility.
 */
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");

export interface Origination {
  file: string;
  line: number;
  text: string;
}

const LITERAL = /(["'])under_review\1/;

/** `status: "under_review"` — the value half of a property or object literal. */
const AS_PROPERTY_VALUE = /\b(?:submission_status|submissionStatus|status|newStatus|new_status)\s*:\s*(["'])under_review\1/;

/**
 * `x = "under_review"` — a plain assignment. The lookbehind keeps `===`, `!==`,
 * `==` and `<=`/`>=` out; `=>` cannot match because a quote never follows the
 * `=` directly.
 */
const AS_ASSIGNMENT = /(?<![=!<>])=\s*(["'])under_review\1/;

/** `updateSomething(…, "under_review", …)` — handed to a writer by name. */
const AS_WRITER_ARGUMENT = /\b(?:update|set|write|insert|save|patch|upsert|apply)[A-Za-z_]*\s*\([^)]*(["'])under_review\1/i;

/** `"a" | "under_review"` — a type union, which declares nothing and writes nothing. */
const IN_TYPE_UNION = /\|\s*(["'])under_review\1|(["'])under_review\2\s*\|/;

export function findUnderReviewOriginations(file: string, contents: string): Origination[] {
  const found: Origination[] = [];

  contents.split("\n").forEach((raw, index) => {
    // Line comments and doc-comment bodies describe; they do not execute.
    const line = raw.replace(/\/\/.*$/, "");
    if (/^\s*\*/.test(raw)) return;
    if (!LITERAL.test(line)) return;
    if (IN_TYPE_UNION.test(line)) return;

    if (AS_PROPERTY_VALUE.test(line) || AS_ASSIGNMENT.test(line) || AS_WRITER_ARGUMENT.test(line)) {
      found.push({ file, line: index + 1, text: raw.trim() });
    }
  });

  return found;
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "dist-electron", "build", "coverage", "__tests__", "__mocks__", "fixtures"].includes(entry.name)) {
        continue;
      }
      collectSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("BACKLOG-2869 — the detector finds what it claims to find", () => {
  it.each([
    ['a property value', 'await supabase.from("submissions").update({ status: "under_review" });'],
    ['a submission_status field', '  const updates = { submission_status: "under_review", notes: null };'],
    ['a plain assignment', '  transaction.submission_status = "under_review";'],
    ['a writer argument', '  updateTransactionSubmissionStatus(tx.id, "under_review", null);'],
  ])("flags %s", (_shape, snippet) => {
    expect(findUnderReviewOriginations("synthetic.ts", snippet)).toHaveLength(1);
  });

  it.each([
    ['a switch case', '    case "under_review":'],
    ['a strict comparison', '  if (transaction.submission_status === "under_review") {'],
    ['a negated comparison', '  if (status !== "under_review") return;'],
    ['a membership list', 'export const BLOCKED = ["submitted", "under_review", "approved"] as const;'],
    ['a type union', '  submission_status?: "not_submitted" | "under_review" | "approved";'],
    ['a portal pass-through', '  updateTransactionSubmissionStatus(local.id, cloud.status, cloud.review_notes);'],
  ])("does not flag %s", (_shape, snippet) => {
    expect(findUnderReviewOriginations("synthetic.ts", snippet)).toHaveLength(0);
  });

  it("reports the line number it found, so a failure is actionable", () => {
    const found = findUnderReviewOriginations(
      "synthetic.ts",
      ['const a = 1;', 'const b = 2;', 'row.submission_status = "under_review";'].join("\n"),
    );

    expect(found).toEqual([
      { file: "synthetic.ts", line: 3, text: 'row.submission_status = "under_review";' },
    ]);
  });
});

describe("BACKLOG-2869 — nothing in the desktop app originates under_review", () => {
  it("finds no origination in electron/ or src/", () => {
    const files = [
      ...collectSourceFiles(path.join(REPO_ROOT, "electron")),
      ...collectSourceFiles(path.join(REPO_ROOT, "src")),
    ];

    // The sweep is not vacuous: it read a real tree, and that tree really does
    // mention the status (in comparisons, unions and labels) — so an empty
    // result below is the detector passing over reads, not the walker missing
    // the files.
    expect(files.length).toBeGreaterThan(500);
    const mentioning = files.filter((f) => LITERAL.test(fs.readFileSync(f, "utf8")));
    expect(mentioning.length).toBeGreaterThan(0);

    const originations = mentioning.flatMap((f) =>
      findUnderReviewOriginations(path.relative(REPO_ROOT, f), fs.readFileSync(f, "utf8")),
    );

    expect(originations).toEqual([]);
  });
});
