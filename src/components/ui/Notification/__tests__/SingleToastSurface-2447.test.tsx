/**
 * Single toast surface (BACKLOG-2447)
 *
 * The app had TWO notification systems with different screen positions:
 *
 *   useToast        -> Toast.tsx:125                  fixed bottom-4 right-4   (9 files)
 *   useNotification -> NotificationContainer.tsx:28   fixed top-16 right-4     (8 files)
 *
 * So which corner a message appeared in depended on which screen you were on.
 * The founder reported "toast showed up at the top right not the bottom right"
 * three separate times in one QA session — grant, upload failure, delete — and
 * asked whether there was "some main system ... so you don't have to go change
 * them one by one". There was not; there were two.
 *
 * `NotificationContainer.tsx` also contradicted itself: lines 3 and 16 both
 * said "bottom-right" while line 28 rendered `top-16`. Anyone reading the file
 * to check would have concluded it was already correct. (See BACKLOG-2439 for
 * the wider pattern of documentation asserting things the code does not do.)
 *
 * These tests are deliberately structural as well as behavioural. Asserting
 * only that THIS container renders bottom-right would not have caught the
 * original bug, because the original bug was a SECOND container existing
 * somewhere else. So the invariant enforced here is:
 *
 *   1. the notification container renders bottom-right, and
 *   2. there is exactly one notification container in src/, and
 *   3. the deleted system cannot come back.
 *
 * A future second toast system fails (2) or (3) by construction, without
 * anyone having to remember this file exists.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import * as fs from "fs";
import * as path from "path";
import { NotificationContainer } from "../NotificationContainer";
import type { Notification } from "../types";

const SRC_ROOT = path.resolve(__dirname, "../../../..");

/** Every .ts/.tsx file under src/, excluding test files. */
function sourceFiles(dir: string = SRC_ROOT, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const rel = (f: string) => path.relative(SRC_ROOT, f);

describe("BACKLOG-2447 — notifications render bottom-right", () => {
  const one: Notification[] = [
    { id: "n1", type: "success", message: "Saved", duration: 5000 },
  ];

  it("anchors the container to the bottom-right, not the top", () => {
    render(<NotificationContainer notifications={one} onDismiss={jest.fn()} />);

    const container = screen.getByTestId("notification-container");
    const cls = container.className;

    expect(cls).toContain("fixed");
    expect(cls).toContain("bottom-4");
    expect(cls).toContain("right-4");

    // The actual regression: a top anchor. `top-16` was the shipped value.
    expect(cls).not.toMatch(/\btop-\d/);
    expect(cls).not.toMatch(/\bleft-\d/);
  });
});

describe("BACKLOG-2447 — exactly one toast system exists", () => {
  it("has exactly one notification container in src/", () => {
    // Identified by the container's own test id rather than by a Tailwind
    // string, so a second system that picks different classes is still caught.
    const withContainer = sourceFiles()
      .filter((f) =>
        fs.readFileSync(f, "utf8").includes('data-testid="notification-container"')
      )
      .map(rel);

    expect(withContainer).toEqual([
      "components/ui/Notification/NotificationContainer.tsx",
    ]);
  });

  it("has no second module exporting a toast stack container", () => {
    // `ToastContainer` was the export that made the parallel system reachable.
    const offenders = sourceFiles()
      .filter((f) => /export\s+(function|const)\s+ToastContainer\b/.test(fs.readFileSync(f, "utf8")))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it("has no useToast hook to import", () => {
    const offenders = sourceFiles()
      .filter((f) => /export\s+function\s+useToast\b/.test(fs.readFileSync(f, "utf8")))
      .map(rel);

    expect(offenders).toEqual([]);
  });

  it("routes every notification caller through useNotification", () => {
    // If any file still imports the deleted hook or component, it either fails
    // to compile or silently renders into a container that no longer exists.
    const offenders = sourceFiles()
      .filter((f) => {
        const src = fs.readFileSync(f, "utf8");
        return (
          /from\s+["'][^"']*hooks\/useToast["']/.test(src) ||
          /from\s+["'][^"']*components\/Toast["']/.test(src) ||
          /from\s+["']\.\.?\/Toast["']/.test(src)
        );
      })
      .map(rel);

    expect(offenders).toEqual([]);

    // And the surviving system is actually in use — this guards against the
    // assertions above passing trivially because everything was deleted.
    const users = sourceFiles().filter((f) =>
      /useNotification\s*\(/.test(fs.readFileSync(f, "utf8"))
    );
    expect(users.length).toBeGreaterThan(5);
  });
});
