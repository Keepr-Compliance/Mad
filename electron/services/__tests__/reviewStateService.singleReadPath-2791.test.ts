/**
 * @jest-environment node
 *
 * BACKLOG-2791 — ONE source of trust, enforced structurally.
 *
 * Founder ruling, 2026-08-22: "both text messages and emails that need review
 * should have ONE source of trust... the data and state should be the same in
 * the backend, and it all counts toward the needs-review required for completing
 * the transaction."
 *
 * A ruling that lives only in prose gets undone by the next person who needs a
 * count in a hurry and writes their own SELECT. This suite fails when a SECOND
 * read path appears, which is the only version of that rule that survives.
 *
 * It greps the shipped source rather than exercising behaviour on purpose: the
 * failure mode being prevented is a NEW call site, and no behavioural test can
 * see a query that a future surface has not written yet.
 */

import fs from "fs";
import path from "path";

const ROOT = path.join(__dirname, "../../..");

/** Files allowed to touch the review stores directly. */
const OWNERS = [
  "electron/services/reviewStateService.ts",
  // The migration and the schema create the table; they do not read state.
  "electron/services/databaseService.ts",
  "electron/database/schema.sql",
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "dist-electron", "build", "__tests__"].includes(entry.name)) {
          continue;
        }
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(ROOT, "electron"));
  walk(path.join(ROOT, "src"));
  return out;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

describe("BACKLOG-2791 — review state has exactly one read path", () => {
  const files = sourceFiles();

  it("finds the source tree (guards against the walker silently matching nothing)", () => {
    // A grep-based guard that scans zero files passes forever while proving
    // nothing. This is the control on the control.
    expect(files.length).toBeGreaterThan(200);
    expect(files.map(relative)).toContain("electron/services/reviewStateService.ts");
  });

  it("only reviewStateService queries pending_review_communications", () => {
    const offenders = files
      .filter((f) => fs.readFileSync(f, "utf8").includes("pending_review_communications"))
      .map(relative)
      .filter((f) => !OWNERS.includes(f));

    expect(offenders).toEqual([]);
  });

  it("only reviewStateService reads the legacy address_missing population as review state", () => {
    // `address_missing` is legitimately WRITTEN by autoLinkService and rendered
    // as a value by the tab components. What must not spread is a second place
    // deciding what counts as needs-review by SELECTing on it.
    const offenders = files
      .filter((f) => {
        const src = fs.readFileSync(f, "utf8");
        return /match_reason\s*=\s*'address_missing'/.test(src);
      })
      .map(relative)
      .filter((f) => !OWNERS.includes(f));

    expect(offenders).toEqual([]);
  });

  it("no renderer file names the pending store at all", () => {
    // The renderer's only route to review state is the review:get-state channel.
    //
    // NOT asserted here: that no renderer file mentions `address_missing`. The
    // tab components legitimately CLASSIFY on that value to render the existing
    // needs-review sections, which the founder's ruling explicitly permits
    // ("displayed ... separately in the needs-review sections of the emails/texts
    // tabs"). What the ruling forbids is a second place DECIDING what counts,
    // which is what the SELECT-shaped assertion above pins.
    const offenders = files
      .filter((f) => relative(f).startsWith("src/"))
      .filter((f) => fs.readFileSync(f, "utf8").includes("pending_review_communications"))
      .map(relative);

    expect(offenders).toEqual([]);
  });
});
