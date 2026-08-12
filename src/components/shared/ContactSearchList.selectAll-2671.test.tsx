/**
 * A SELECT-ALL ROW AT THE TOP OF BOTH FILTER PANELS — BACKLOG-2671
 *
 * ===========================================================================
 * WHAT WAS THERE BEFORE, READ OUT OF THE CODE
 * ===========================================================================
 * Both filters were already MULTI-select (two `Set<string>`, `setChildSelected`
 * copies and adds/deletes) and their GROUP headers were already tri-state, with
 * `indeterminate` set imperatively via ref in `GroupedMultiSelect`. Nothing here
 * converts a single-select into a multi-select; there was nothing to convert.
 *
 * What was missing was a GLOBAL row. "All" existed only as trigger summary text
 * and as the "Show all" escape hatch OUTSIDE the dropdown, which is reachable
 * only once the filters have already hidden everything.
 *
 * So the new row copies the mechanism one level up rather than inventing a
 * second one: same tri-state rule, same imperative `indeterminate`, same
 * enabled-children-only scope as `toggleGroup`.
 *
 * ===========================================================================
 * WHICH "ALL" IT MEANS — THE DECISION THIS SUITE PINS
 * ===========================================================================
 * There are two candidate meanings live in this file already: the DEFAULT
 * selection (`defaultSourceSelection`, which leaves the Inferred group off), and
 * EVERY ENABLED LEAF (`trueSelectAll`, what "Show all" does).
 *
 * The row means EVERY ENABLED LEAF. A checkbox that reads "checked = everything
 * is on" cannot toggle into a state where two sources are off, and the group
 * headers directly beneath it already mean exactly this. The consequence — that
 * clicking it turns the Inferred sources ON, which the default leaves off — is
 * asserted below rather than left to be discovered.
 *
 * Both panels are driven through the real `ContactSearchList`, and both are
 * tested. They are two instances of one component, but "it is the same
 * component" is a claim about the source, not a measurement of the wiring: Role
 * gets no counts and a different label, so its props differ at the call site.
 */

import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContactSearchList } from "./ContactSearchList";
import type { ExtendedContact } from "../../types/components";
import {
  ALL_ROLE_LEAF_IDS,
  ALL_SOURCE_LEAF_IDS,
  INFERRED_SOURCE_LEAF_IDS,
  ROLE_GROUPS,
  ROLE_LEAF,
  SOURCE_LEAF,
} from "../../utils/contactFilterModel";

jest.mock("./ContactRow", () => ({
  BADGE_LABELS: { autolinked: "Autolinked", user_linked: "You linked these" },
  ContactRow: ({ contact }: { contact: { id: string } }) => (
    <div data-testid={`row-${contact.id}`} data-contact-id={contact.id} />
  ),
}));

const FILTER_STORAGE_KEY = "contactModal.filterModel.v1";

const contact = (
  id: string,
  source: string,
  extra: Partial<ExtendedContact> = {},
): ExtendedContact =>
  ({
    id,
    name: id,
    display_name: id,
    email: `${id}@example.com`,
    user_id: "user-1",
    source,
    created_at: "2024-01-01",
    updated_at: "2024-01-01",
    is_message_derived: source === "messages",
    ...extra,
  }) as ExtendedContact;

/**
 * Rows spanning a default-ON source, a default-OFF (Inferred) source, and two
 * different roles — so "some but not all" is reachable on BOTH panels and the
 * Inferred consequence is observable rather than theoretical.
 */
const rows = (): ExtendedContact[] => [
  contact("c-book", "contacts_app", { default_role: "buyer" }),
  contact("c-outlook", "outlook", { default_role: "seller" }),
  contact("c-text", "messages"),
];

const renderList = (filterMode: "persistent" | "ephemeral" = "persistent") =>
  render(
    <ContactSearchList
      contacts={rows()}
      selectedIds={[]}
      onSelectionChange={jest.fn()}
      filterMode={filterMode}
    />,
  );

const renderedIds = (): string[] =>
  screen
    .queryAllByTestId(/^row-/)
    .map((el) => el.getAttribute("data-contact-id") as string)
    .sort();

const selectAllBox = (panel: "source" | "role"): HTMLInputElement =>
  screen.getByTestId(`${panel}-filter-select-all-checkbox`) as HTMLInputElement;

const storedFilters = (): { sources: string[]; roles: string[] } =>
  JSON.parse(localStorage.getItem(FILTER_STORAGE_KEY) ?? '{"sources":[],"roles":[]}');

describe.each([
  {
    panel: "source" as const,
    label: "All sources",
    allLeaves: ALL_SOURCE_LEAF_IDS as readonly string[],
    someLeaf: SOURCE_LEAF.CONTACTS_APP as string,
  },
  {
    panel: "role" as const,
    label: "All roles",
    allLeaves: ALL_ROLE_LEAF_IDS as readonly string[],
    someLeaf: ROLE_LEAF.BUYERS as string,
  },
])("$panel filter — the select-all row", ({ panel, label, allLeaves, someLeaf }) => {
  beforeEach(() => localStorage.clear());

  it("is labelled for its own panel", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByTestId(`${panel}-filter-trigger`));
    expect(screen.getByTestId(`${panel}-filter-select-all`)).toHaveTextContent(label);
  });

  /**
   * The indeterminate assertion the founder's brief singled out: the DOM
   * PROPERTY, not a class name. `indeterminate` has no HTML attribute — it
   * exists only on the element — so a class-based assertion would pass against a
   * plain two-state checkbox that silently reads "nothing is selected" while
   * most things are.
   */
  it("renders indeterminate when SOME but not all options are selected", async () => {
    const user = userEvent.setup();
    renderList("ephemeral"); // opens on a true select-all

    await user.click(screen.getByTestId(`${panel}-filter-trigger`));
    expect(selectAllBox(panel).checked).toBe(true);
    expect(selectAllBox(panel).indeterminate).toBe(false);

    // Untick exactly one leaf -> some, but not all.
    await user.click(screen.getByTestId(`${panel}-filter-checkbox-${someLeaf}`));

    expect(selectAllBox(panel).indeterminate).toBe(true);
    expect(selectAllBox(panel).checked).toBe(false);
  });

  it("is unchecked and NOT indeterminate when nothing is selected", async () => {
    const user = userEvent.setup();
    renderList("ephemeral");

    await user.click(screen.getByTestId(`${panel}-filter-trigger`));
    await user.click(selectAllBox(panel)); // all -> none

    expect(selectAllBox(panel).checked).toBe(false);
    expect(selectAllBox(panel).indeterminate).toBe(false);
  });

  /**
   * The round trip, asserted on the EXACT ID SET rather than the count. Two
   * different sets of the same size would satisfy a count assertion, and a
   * select-all that quietly dropped a leaf would produce exactly that.
   */
  it("select-all -> clear-all -> select-all returns the same exact ID set", async () => {
    const user = userEvent.setup();
    renderList("ephemeral");

    const before = renderedIds();
    expect(before.length).toBeGreaterThan(0);

    await user.click(screen.getByTestId(`${panel}-filter-trigger`));
    await user.click(selectAllBox(panel)); // all -> none
    expect(renderedIds()).toEqual([]);

    await user.click(selectAllBox(panel)); // none -> all
    expect(renderedIds()).toEqual(before);
  });

  /**
   * The direction of the FIRST click differs by panel, which is why this drives
   * to a known state instead of assuming one. Source's default leaves the
   * Inferred group off, so it opens indeterminate and one click selects all.
   * Role's default is every leaf INCLUDING the permanently-disabled `brokers`
   * (deliberate — see `DEFAULT_ROLE_LEAF_IDS`), so every ENABLED leaf is already
   * on, the row opens checked, and one click would CLEAR it.
   */
  it("selects every enabled leaf — and adds no disabled one", async () => {
    const user = userEvent.setup();
    renderList("persistent");

    await user.click(screen.getByTestId(`${panel}-filter-trigger`));
    // Untick one leaf so the row is indeterminate on BOTH panels; the next
    // click is then unambiguously a select-all.
    await user.click(screen.getByTestId(`${panel}-filter-checkbox-${someLeaf}`));
    expect(selectAllBox(panel).indeterminate).toBe(true);

    const readStored = (): string[] =>
      panel === "source" ? storedFilters().sources : storedFilters().roles;
    const disabledBefore = readStored().filter(isDisabledLeaf).sort();

    await user.click(selectAllBox(panel));

    const enabled = allLeaves.filter((id) => !isDisabledLeaf(id));
    const stored = readStored();
    for (const id of enabled) expect(stored).toContain(id);

    // A permanently disabled leaf is never swept IN by this control, and never
    // swept OUT either — `toggleGroup` has always left disabled children alone,
    // and a global row that behaved differently from the group rows beneath it
    // would be the harder of the two to explain.
    expect(stored.filter(isDisabledLeaf).sort()).toEqual(disabledBefore);
  });

  it("holds no id of its own, so it cannot be counted in the trigger summary", async () => {
    const user = userEvent.setup();
    renderList("ephemeral");

    await user.click(screen.getByTestId(`${panel}-filter-trigger`));
    // Every enabled leaf is on, so the summary must read exactly "All" — an
    // extra id in the Set would make it "N selected".
    expect(screen.getByTestId(`${panel}-filter-summary`)).toHaveTextContent(/^All$/);
  });
});

/** True for a leaf the config marks permanently disabled (today: `brokers`). */
function isDisabledLeaf(leafId: string): boolean {
  return ROLE_GROUPS.some((g) => g.children.some((c) => c.id === leafId && c.disabled === true));
}

describe("the two meanings of 'all' — stated, and pinned", () => {
  beforeEach(() => localStorage.clear());

  /**
   * `defaultSourceSelection` leaves the Inferred group OFF; `trueSelectAll`
   * turns everything on. The select-all row means the second. This is the test
   * that tells the next reader which, and the one that fails if someone
   * "corrects" it into a restore-defaults button.
   */
  it("turns the Inferred sources ON, which the default selection leaves off", async () => {
    const user = userEvent.setup();
    renderList("persistent"); // seeds from the default selection

    // The default hides the message-derived row.
    expect(renderedIds()).toEqual(["c-book", "c-outlook"]);

    await user.click(screen.getByTestId("source-filter-trigger"));
    await user.click(selectAllBox("source"));

    expect(renderedIds()).toEqual(["c-book", "c-outlook", "c-text"]);
    for (const leafId of INFERRED_SOURCE_LEAF_IDS) {
      expect(storedFilters().sources).toContain(leafId);
    }
  });

  it("survives a remount in persistent mode — what he clicked is what he gets back", async () => {
    const user = userEvent.setup();
    const first = renderList("persistent");

    await user.click(screen.getByTestId("source-filter-trigger"));
    await user.click(selectAllBox("source"));
    const afterClick = renderedIds();

    first.unmount();
    renderList("persistent");

    expect(renderedIds()).toEqual(afterClick);
    expect(renderedIds()).toContain("c-text"); // the Inferred row is still shown
  });

  it("does NOT persist in ephemeral mode — the Contacts screen's saved selection is untouched", async () => {
    const user = userEvent.setup();
    renderList("ephemeral");

    await user.click(screen.getByTestId("source-filter-trigger"));
    await user.click(selectAllBox("source")); // all -> none

    expect(localStorage.getItem(FILTER_STORAGE_KEY)).toBeNull();
  });
});

describe("the select-all row is a control, not an option", () => {
  beforeEach(() => localStorage.clear());

  it("carries no per-source count of its own — only the population total", async () => {
    const user = userEvent.setup();
    renderList("ephemeral");

    await user.click(screen.getByTestId("source-filter-trigger"));

    // The number beside it is the total the row produces when clicked, which is
    // the whole list — not a count for a source called "All sources".
    expect(screen.getByTestId("source-filter-select-all-count")).toHaveTextContent("3");
    expect(renderedIds()).toHaveLength(3);
  });

  it("takes the first slot in the panel's roving keyboard focus", async () => {
    const user = userEvent.setup();
    renderList("ephemeral");

    // Opening the panel focuses its first row. If `countFocusableRows` and the
    // ref cursor disagreed about the new row, focus would land on the wrong
    // control or nowhere.
    await user.click(screen.getByTestId("source-filter-trigger"));
    expect(document.activeElement).toBe(selectAllBox("source"));
  });
});
