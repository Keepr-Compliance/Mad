import React, { useState } from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GroupedMultiSelect,
  OptionGroup,
  GroupedMultiSelectProps,
} from "../GroupedMultiSelect";

/**
 * Standard groups: two normal groups + a standalone group.
 * - Fruit: apple, banana, cherry (cherry disabled)
 * - Veg: carrot, potato
 * - Unassigned: standalone single toggle
 */
const GROUPS: OptionGroup[] = [
  {
    id: "fruit",
    label: "Fruit",
    children: [
      { id: "apple", label: "Apple" },
      { id: "banana", label: "Banana" },
      { id: "cherry", label: "Cherry", disabled: true, hint: "no data" },
    ],
  },
  {
    id: "veg",
    label: "Veg",
    children: [
      { id: "carrot", label: "Carrot" },
      { id: "potato", label: "Potato" },
    ],
  },
  {
    id: "unassigned",
    label: "Unassigned",
    standalone: true,
    children: [{ id: "unassigned", label: "Unassigned" }],
  },
];

/**
 * Controlled test harness — mirrors how the parent (ContactSearchList in T3) owns the Set.
 * Exposes the latest `selected` via a callback so tests can assert emitted payloads.
 */
function Harness({
  initial = new Set<string>(),
  onSelectedChange,
  ...props
}: {
  initial?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
} & Partial<GroupedMultiSelectProps>) {
  const [selected, setSelected] = useState<Set<string>>(initial);
  return (
    <GroupedMultiSelect
      triggerLabel="Category"
      groups={GROUPS}
      selected={selected}
      onChange={(next) => {
        setSelected(next);
        onSelectedChange?.(next);
      }}
      {...props}
    />
  );
}

function openPanel() {
  fireEvent.click(screen.getByTestId("grouped-multiselect-trigger"));
}

describe("GroupedMultiSelect", () => {
  describe("trigger + open/close", () => {
    it("renders the trigger with label and aria attributes, panel closed by default", () => {
      render(<Harness />);
      const trigger = screen.getByTestId("grouped-multiselect-trigger");
      expect(trigger).toHaveTextContent("Category");
      expect(trigger).toHaveAttribute("aria-haspopup", "true");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByTestId("grouped-multiselect-panel")).not.toBeInTheDocument();
    });

    it("opens and closes the panel on trigger click", () => {
      render(<Harness />);
      openPanel();
      expect(screen.getByTestId("grouped-multiselect-panel")).toBeInTheDocument();
      expect(screen.getByTestId("grouped-multiselect-trigger")).toHaveAttribute(
        "aria-expanded",
        "true"
      );
      fireEvent.click(screen.getByTestId("grouped-multiselect-trigger"));
      expect(screen.queryByTestId("grouped-multiselect-panel")).not.toBeInTheDocument();
    });

    it("disables the trigger when disabled prop is set", () => {
      render(<Harness disabled />);
      expect(screen.getByTestId("grouped-multiselect-trigger")).toBeDisabled();
    });

    it("panel uses role=group with the trigger label as aria-label", () => {
      render(<Harness />);
      openPanel();
      const panel = screen.getByTestId("grouped-multiselect-panel");
      expect(panel).toHaveAttribute("role", "group");
      expect(panel).toHaveAttribute("aria-label", "Category");
    });
  });

  describe("rendering groups and children", () => {
    it("renders all groups, children, and a standalone group as a single checkbox", () => {
      render(<Harness />);
      openPanel();
      // Group headers
      expect(screen.getByTestId("grouped-multiselect-group-fruit")).toBeInTheDocument();
      expect(screen.getByTestId("grouped-multiselect-group-veg")).toBeInTheDocument();
      // Children
      ["apple", "banana", "cherry", "carrot", "potato"].forEach((id) => {
        expect(screen.getByTestId(`grouped-multiselect-option-${id}`)).toBeInTheDocument();
      });
      // Standalone: rendered as an option, NOT as a group header
      expect(screen.getByTestId("grouped-multiselect-option-unassigned")).toBeInTheDocument();
      expect(
        screen.queryByTestId("grouped-multiselect-group-unassigned")
      ).not.toBeInTheDocument();
    });

    it("renders a hint next to a disabled child", () => {
      render(<Harness />);
      openPanel();
      expect(screen.getByTestId("grouped-multiselect-hint-cherry")).toHaveTextContent("no data");
    });

    it("renders disabled children as disabled and aria-disabled", () => {
      render(<Harness />);
      openPanel();
      const cherry = screen.getByTestId("grouped-multiselect-checkbox-cherry");
      expect(cherry).toBeDisabled();
      expect(cherry).toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("tri-state parent (over enabled children only)", () => {
    it("parent is unchecked when no children are selected", () => {
      render(<Harness />);
      openPanel();
      const parent = screen.getByTestId("grouped-multiselect-group-checkbox-fruit") as HTMLInputElement;
      expect(parent.checked).toBe(false);
      expect(parent.indeterminate).toBe(false);
    });

    it("parent is checked when all ENABLED children are selected (disabled ignored)", () => {
      // apple + banana selected; cherry is disabled and excluded -> parent checked
      render(<Harness initial={new Set(["apple", "banana"])} />);
      openPanel();
      const parent = screen.getByTestId("grouped-multiselect-group-checkbox-fruit") as HTMLInputElement;
      expect(parent.checked).toBe(true);
      expect(parent.indeterminate).toBe(false);
    });

    it("parent is indeterminate when some enabled children are selected", () => {
      render(<Harness initial={new Set(["apple"])} />);
      openPanel();
      const parent = screen.getByTestId("grouped-multiselect-group-checkbox-fruit") as HTMLInputElement;
      // The DOM `indeterminate` property is set via ref; browsers map this to
      // the accessibility tree as aria-checked="mixed". (jsdom does not reflect
      // that ARIA mapping as a literal attribute, so we assert the property.)
      expect(parent.indeterminate).toBe(true);
      expect(parent.checked).toBe(false);
    });
  });

  describe("all-children-disabled group edge case", () => {
    const ALL_DISABLED: OptionGroup[] = [
      {
        id: "empty",
        label: "Empty",
        children: [
          { id: "x", label: "X", disabled: true },
          { id: "y", label: "Y", disabled: true },
        ],
      },
    ];

    it("parent is disabled + unchecked (not indeterminate) and does not toggle", () => {
      const onChange = jest.fn();
      render(
        <GroupedMultiSelect
          triggerLabel="Empty"
          groups={ALL_DISABLED}
          selected={new Set()}
          onChange={onChange}
        />
      );
      openPanel();
      const parent = screen.getByTestId("grouped-multiselect-group-checkbox-empty") as HTMLInputElement;
      expect(parent).toBeDisabled();
      expect(parent.checked).toBe(false);
      expect(parent.indeterminate).toBe(false);
      // Clicking a disabled input fires nothing
      fireEvent.click(parent);
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("selection behavior (controlled, immutable)", () => {
    it("toggling a child emits a new Set with that child added", () => {
      const onSelectedChange = jest.fn();
      render(<Harness onSelectedChange={onSelectedChange} />);
      openPanel();
      fireEvent.click(screen.getByTestId("grouped-multiselect-checkbox-apple"));
      expect(onSelectedChange).toHaveBeenCalledTimes(1);
      const emitted = onSelectedChange.mock.calls[0][0] as Set<string>;
      expect(emitted.has("apple")).toBe(true);
    });

    it("does not mutate the input Set (emits a fresh Set)", () => {
      const initial = new Set<string>(["banana"]);
      const onChange = jest.fn();
      render(
        <GroupedMultiSelect
          triggerLabel="Category"
          groups={GROUPS}
          selected={initial}
          onChange={onChange}
        />
      );
      openPanel();
      fireEvent.click(screen.getByTestId("grouped-multiselect-checkbox-apple"));
      const emitted = onChange.mock.calls[0][0] as Set<string>;
      expect(emitted).not.toBe(initial); // new reference
      expect(initial.has("apple")).toBe(false); // original untouched
      expect(emitted.has("apple")).toBe(true);
      expect(emitted.has("banana")).toBe(true);
    });

    it("clicking a disabled child does not toggle it", () => {
      const onChange = jest.fn();
      render(
        <GroupedMultiSelect
          triggerLabel="Category"
          groups={GROUPS}
          selected={new Set()}
          onChange={onChange}
        />
      );
      openPanel();
      fireEvent.click(screen.getByTestId("grouped-multiselect-checkbox-cherry"));
      expect(onChange).not.toHaveBeenCalled();
    });

    it("clicking the parent selects all ENABLED children (disabled untouched)", () => {
      const onChange = jest.fn();
      render(
        <GroupedMultiSelect
          triggerLabel="Category"
          groups={GROUPS}
          selected={new Set()}
          onChange={onChange}
        />
      );
      openPanel();
      fireEvent.click(screen.getByTestId("grouped-multiselect-group-checkbox-fruit"));
      const emitted = onChange.mock.calls[0][0] as Set<string>;
      expect(emitted.has("apple")).toBe(true);
      expect(emitted.has("banana")).toBe(true);
      expect(emitted.has("cherry")).toBe(false); // disabled excluded
    });

    it("clicking a fully-checked parent deselects all enabled children", () => {
      const onChange = jest.fn();
      render(
        <GroupedMultiSelect
          triggerLabel="Category"
          groups={GROUPS}
          selected={new Set(["apple", "banana"])}
          onChange={onChange}
        />
      );
      openPanel();
      fireEvent.click(screen.getByTestId("grouped-multiselect-group-checkbox-fruit"));
      const emitted = onChange.mock.calls[0][0] as Set<string>;
      expect(emitted.has("apple")).toBe(false);
      expect(emitted.has("banana")).toBe(false);
    });

    it("standalone group toggles on children[0].id", () => {
      const onChange = jest.fn();
      render(
        <GroupedMultiSelect
          triggerLabel="Category"
          groups={GROUPS}
          selected={new Set()}
          onChange={onChange}
        />
      );
      openPanel();
      fireEvent.click(screen.getByTestId("grouped-multiselect-checkbox-unassigned"));
      const emitted = onChange.mock.calls[0][0] as Set<string>;
      expect(emitted.has("unassigned")).toBe(true);
    });
  });

  describe("summary", () => {
    it("shows 'None' when nothing is selected", () => {
      render(<Harness />);
      expect(screen.getByTestId("grouped-multiselect-summary")).toHaveTextContent("None");
    });

    it("shows 'N selected' for a partial selection", () => {
      render(
        <GroupedMultiSelect
          triggerLabel="Category"
          groups={GROUPS}
          selected={new Set(["apple", "carrot"])}
          onChange={jest.fn()}
        />
      );
      expect(screen.getByTestId("grouped-multiselect-summary")).toHaveTextContent("2 selected");
    });

    it("uses summaryFormatter when provided", () => {
      render(
        <GroupedMultiSelect
          triggerLabel="Category"
          groups={GROUPS}
          selected={new Set(["apple"])}
          onChange={jest.fn()}
          summaryFormatter={() => "Custom!"}
        />
      );
      expect(screen.getByTestId("grouped-multiselect-summary")).toHaveTextContent("Custom!");
    });

    it("default summary reads 'All' when every child is selected", () => {
      render(
        <GroupedMultiSelect
          triggerLabel="Category"
          groups={GROUPS}
          selected={new Set(["apple", "banana", "cherry", "carrot", "potato", "unassigned"])}
          onChange={jest.fn()}
        />
      );
      expect(screen.getByTestId("grouped-multiselect-summary")).toHaveTextContent("All");
    });
  });

  describe("keyboard navigation and focus", () => {
    it("moves focus into the panel (first enabled row) on open", () => {
      render(<Harness />);
      openPanel();
      const firstRow = screen.getByTestId("grouped-multiselect-group-checkbox-fruit");
      expect(firstRow).toHaveFocus();
    });

    it("ArrowDown / ArrowUp move roving focus, skipping disabled rows", () => {
      render(<Harness />);
      openPanel();
      const panel = screen.getByTestId("grouped-multiselect-panel");

      const parent = screen.getByTestId("grouped-multiselect-group-checkbox-fruit");
      expect(parent).toHaveFocus();

      fireEvent.keyDown(panel, { key: "ArrowDown" });
      expect(screen.getByTestId("grouped-multiselect-checkbox-apple")).toHaveFocus();

      fireEvent.keyDown(panel, { key: "ArrowDown" });
      expect(screen.getByTestId("grouped-multiselect-checkbox-banana")).toHaveFocus();

      // Next enabled row skips the disabled cherry -> veg group header
      fireEvent.keyDown(panel, { key: "ArrowDown" });
      expect(screen.getByTestId("grouped-multiselect-group-checkbox-veg")).toHaveFocus();

      fireEvent.keyDown(panel, { key: "ArrowUp" });
      expect(screen.getByTestId("grouped-multiselect-checkbox-banana")).toHaveFocus();
    });

    it("Space toggles the focused checkbox", async () => {
      const onSelectedChange = jest.fn();
      const user = userEvent.setup();
      render(<Harness onSelectedChange={onSelectedChange} />);
      openPanel();
      // Focus is on the fruit parent (moved into panel on open); Space toggles it,
      // which selects all enabled fruit children.
      const parent = screen.getByTestId("grouped-multiselect-group-checkbox-fruit");
      expect(parent).toHaveFocus();
      await user.keyboard(" ");
      expect(onSelectedChange).toHaveBeenCalled();
      const emitted = onSelectedChange.mock.calls[0][0] as Set<string>;
      expect(emitted.has("apple")).toBe(true);
      expect(emitted.has("banana")).toBe(true);
    });

    it("Escape closes the panel and returns focus to the trigger", () => {
      render(<Harness />);
      openPanel();
      expect(screen.getByTestId("grouped-multiselect-panel")).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("grouped-multiselect-panel")).not.toBeInTheDocument();
      expect(screen.getByTestId("grouped-multiselect-trigger")).toHaveFocus();
    });

    it("Tab closes the panel", async () => {
      render(<Harness />);
      openPanel();
      const panel = screen.getByTestId("grouped-multiselect-panel");
      fireEvent.keyDown(panel, { key: "Tab" });
      expect(screen.queryByTestId("grouped-multiselect-panel")).not.toBeInTheDocument();
    });
  });

  describe("outside-click close", () => {
    it("closes the panel on outside mousedown", () => {
      render(
        <div>
          <span data-testid="outside">outside</span>
          <Harness />
        </div>
      );
      openPanel();
      expect(screen.getByTestId("grouped-multiselect-panel")).toBeInTheDocument();
      fireEvent.mouseDown(screen.getByTestId("outside"));
      expect(screen.queryByTestId("grouped-multiselect-panel")).not.toBeInTheDocument();
    });

    it("does not close on mousedown inside the panel", () => {
      render(<Harness />);
      openPanel();
      const panel = screen.getByTestId("grouped-multiselect-panel");
      fireEvent.mouseDown(within(panel).getByTestId("grouped-multiselect-option-apple"));
      expect(screen.getByTestId("grouped-multiselect-panel")).toBeInTheDocument();
    });
  });
});
