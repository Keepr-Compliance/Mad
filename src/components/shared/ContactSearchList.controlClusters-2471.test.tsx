/**
 * A label never wraps away from the controls it names — BACKLOG-2471, point 4
 * of the founder's 7 Aug spec (`pm_comments` `43f9a8a6`).
 *
 * WHAT HE SAW. The controls row is `flex-wrap`. Narrow the window and the word
 * `Filter:` was left stranded alone on the first line while its two dropdowns
 * dropped to the second. `Sort:` had the same shape. The labels were bare
 * siblings of their controls, so each was an independent wrap candidate and the
 * browser was free to break the line between a label and the thing it names.
 *
 * WHAT THESE TESTS CAN AND CANNOT SEE. jsdom has no layout engine: every element
 * here is 0x0 and nothing ever wraps, so a test that asserted "it looks right at
 * 480px" would pass against ANY markup and mean nothing. So none of this
 * measures pixels. It asserts the STRUCTURE that makes the orphan impossible at
 * every width, which is what the founder actually asked for — *"put them all as
 * a part of the same wrap component so they all move together"*:
 *
 *   1. IDENTITY — the label and every one of its controls resolve to the SAME
 *      cluster element. One flex item cannot be split across two lines, so the
 *      break can only fall between clusters.
 *   2. NO INNER WRAP — nothing between a control and its cluster re-enables
 *      wrapping, which would reintroduce the split inside the unit.
 *   3. THE ROW STILL WRAPS — `contact-controls` keeps `flex-wrap`, so the whole
 *      group can still move to line two. Deleting that would trade the orphan
 *      for horizontal overflow, and rule 1 alone would not notice.
 *   4. EXHAUSTIVENESS — every element child of the row IS a cluster, and every
 *      control inside it has a cluster ancestor. This is the rule that catches
 *      the regression the founder named: a control appended NEXT TO the clusters
 *      instead of inside one. Without it the grouping is a wrap tweak wearing a
 *      component's name, and the next control to arrive orphans its label again
 *      exactly as `Autolinked` (BACKLOG-2626) arrived into this row.
 *
 * @see BACKLOG-2471 point 4 — the wrap spec
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import { ContactSearchList, ContactSearchListProps } from "./ContactSearchList";
import type { ExtendedContact } from "../../types/components";

// The rows are irrelevant here — only the controls row is under test. Mocking
// keeps a ContactRow change from ever reddening a layout-structure test.
jest.mock("./ContactRow", () => ({
  BADGE_LABELS: { autolinked: "Autolinked", user_linked: "You linked these" },
  ContactRow: ({ contact }: { contact: ExtendedContact }) => (
    <div data-testid={`contact-row-${contact.id}`}>{contact.display_name}</div>
  ),
}));

const CLUSTER_SELECTOR = "[data-control-cluster]";

/**
 * One contact carrying an `autolinked` badge, because `filter-autolinked` is
 * hidden at a zero count — without this the Sort cluster would be asserted with
 * one of its three controls absent, and the spec says EVERY control.
 */
const autolinkedContact = (): ExtendedContact =>
  ({
    id: "c-autolinked",
    name: "Madison Reyes",
    display_name: "Madison Reyes",
    email: "madison@example.com",
    user_id: "user-1",
    source: "email",
    review_state: {
      columns: 2,
      records: 2,
      needsReview: false,
      openQuestions: 0,
      badge: "autolinked",
    },
  }) as ExtendedContact;

const renderList = (overrides: Partial<ContactSearchListProps> = {}) =>
  render(
    <ContactSearchList
      contacts={[autolinkedContact()]}
      selectedIds={[]}
      onSelectionChange={jest.fn()}
      filterMode="off"
      {...overrides}
    />,
  );

/** Every element from `start` up to (and including) `cluster`. */
const chainToCluster = (start: HTMLElement, cluster: Element): Element[] => {
  const chain: Element[] = [];
  let node: Element | null = start;
  while (node) {
    chain.push(node);
    if (node === cluster) return chain;
    node = node.parentElement;
  }
  throw new Error("element is not inside the cluster it was expected in");
};

describe("ContactSearchList — a label and its controls are ONE wrappable unit (BACKLOG-2471)", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
  });

  describe("identity: the label and its controls share one cluster element", () => {
    it("Sort: travels with the sort toggle AND with Autolinked", () => {
      renderList();

      const cluster = screen.getByTestId("contact-sort-cluster");

      // The label is not merely inside SOME cluster — it is inside THIS one,
      // the same node every control resolves to. `toBe` (node identity) is the
      // assertion; `toEqual` would pass on any two structurally-alike divs.
      expect(screen.getByText("Sort:").closest(CLUSTER_SELECTOR)).toBe(cluster);
      expect(screen.getByTestId("contact-sort-control").closest(CLUSTER_SELECTOR)).toBe(cluster);
      expect(screen.getByTestId("sort-recent").closest(CLUSTER_SELECTOR)).toBe(cluster);
      expect(screen.getByTestId("sort-alphabetical").closest(CLUSTER_SELECTOR)).toBe(cluster);
      expect(screen.getByTestId("filter-autolinked").closest(CLUSTER_SELECTOR)).toBe(cluster);
    });

    it("Filter: travels with both the Source and the Role dropdown", () => {
      renderList({ filterMode: "ephemeral" });

      const cluster = screen.getByTestId("contact-filter-cluster");

      expect(screen.getByText("Filter:").closest(CLUSTER_SELECTOR)).toBe(cluster);
      expect(screen.getByTestId("source-filter").closest(CLUSTER_SELECTOR)).toBe(cluster);
      expect(screen.getByTestId("role-filter").closest(CLUSTER_SELECTOR)).toBe(cluster);
    });

    it("the two clusters are DIFFERENT elements (they wrap independently of each other)", () => {
      renderList({ filterMode: "ephemeral" });

      // The spec permits — and expects — the break to fall BETWEEN clusters.
      // If both labels resolved to one node the row could never wrap at all.
      expect(screen.getByTestId("contact-sort-cluster")).not.toBe(
        screen.getByTestId("contact-filter-cluster"),
      );
    });
  });

  describe("no wrap inside a cluster", () => {
    it("neither cluster enables wrapping, at any level between a control and its cluster", () => {
      renderList({ filterMode: "ephemeral" });

      const cases: Array<[string, string]> = [
        ["contact-sort-cluster", "filter-autolinked"],
        ["contact-sort-cluster", "contact-sort-control"],
        ["contact-filter-cluster", "source-filter"],
        ["contact-filter-cluster", "role-filter"],
      ];

      for (const [clusterId, controlId] of cases) {
        const cluster = screen.getByTestId(clusterId);
        for (const node of chainToCluster(screen.getByTestId(controlId), cluster)) {
          expect(`${clusterId} > ${controlId} :: ${node.className}`).not.toMatch(/flex-wrap/);
        }
      }
    });

    it("the ROW itself still wraps, so a whole cluster can move to line two", () => {
      renderList({ filterMode: "ephemeral" });

      // Guards the opposite failure: "fixing" the orphan by deleting the row's
      // flex-wrap would satisfy every other test here and give overflow instead.
      expect(screen.getByTestId("contact-controls").className).toMatch(/\bflex-wrap\b/);
    });
  });

  describe("exhaustiveness: a control cannot be added BESIDE a cluster", () => {
    it.each([
      ["filter UI on", "ephemeral"],
      ["filter UI off", "off"],
    ])("every element child of the controls row is a cluster (%s)", (_label, filterMode) => {
      renderList({ filterMode: filterMode as ContactSearchListProps["filterMode"] });

      const strays = Array.from(screen.getByTestId("contact-controls").children)
        .filter((child) => !child.hasAttribute("data-control-cluster"))
        .map((child) => child.getAttribute("data-testid") ?? child.outerHTML.slice(0, 120));

      expect(strays).toEqual([]);
    });

    it.each([
      ["filter UI on", "ephemeral"],
      ["filter UI off", "off"],
    ])("every control in the row has a cluster ancestor (%s)", (_label, filterMode) => {
      renderList({ filterMode: filterMode as ContactSearchListProps["filterMode"] });

      const row = screen.getByTestId("contact-controls");
      const controls = Array.from(
        row.querySelectorAll<HTMLElement>('button, input, select, [role="group"]'),
      );

      // Sanity: the query must actually find controls, or an empty list would
      // make this assertion vacuously true and the test worthless.
      expect(controls.length).toBeGreaterThan(0);

      const orphans = controls
        .filter((control) => control.closest(CLUSTER_SELECTOR) === null)
        .map((control) => control.getAttribute("data-testid") ?? control.textContent);

      expect(orphans).toEqual([]);
    });
  });
});
