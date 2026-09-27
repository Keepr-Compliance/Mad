/**
 * BACKLOG-3588 — the checklist item row's checkbox is now a shared component
 * (ChecklistCheckbox) that the template chooser also uses. The row must render
 * EXACTLY what it rendered before the extraction.
 *
 * The expected strings below were captured from ChecklistItemRow at
 * 59cfa9860 (before the extraction) by rendering it and reading the
 * checkbox's outerHTML. Any drift in class order, attributes or the check
 * glyph turns this red.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { ChecklistItemRow } from "../ChecklistItemRow";
import { fixtureItem } from "./checklistFixture";

const noop = () => undefined;

const BEFORE: Array<[string, string, boolean, boolean, boolean]> = [
  ["unticked", "<button type=\"button\" role=\"checkbox\" aria-checked=\"false\" aria-label=\"Probe item 1\" class=\"w-6 h-6 rounded-md border-2 inline-flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors disabled:cursor-not-allowed bg-white border-gray-300 hover:border-blue-300 \" data-testid=\"checklist-check-id-2\"><svg class=\"w-4 h-4 text-white opacity-0\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3\" d=\"M5 13l4 4L19 7\"></path></svg></button>", false, false, false],
  ["ticked", "<button type=\"button\" role=\"checkbox\" aria-checked=\"true\" aria-label=\"Probe item 1\" class=\"w-6 h-6 rounded-md border-2 inline-flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors disabled:cursor-not-allowed bg-blue-500 border-blue-500 \" data-testid=\"checklist-check-id-2\"><svg class=\"w-4 h-4 text-white opacity-100\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3\" d=\"M5 13l4 4L19 7\"></path></svg></button>", true, false, false],
  ["read-only", "<button type=\"button\" role=\"checkbox\" aria-checked=\"false\" aria-label=\"Probe item 1\" disabled=\"\" class=\"w-6 h-6 rounded-md border-2 inline-flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors disabled:cursor-not-allowed bg-white border-gray-300 hover:border-blue-300 \" data-testid=\"checklist-check-id-2\"><svg class=\"w-4 h-4 text-white opacity-0\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3\" d=\"M5 13l4 4L19 7\"></path></svg></button>", false, true, false],
  ["ticked and pending", "<button type=\"button\" role=\"checkbox\" aria-checked=\"true\" aria-label=\"Probe item 1\" disabled=\"\" class=\"w-6 h-6 rounded-md border-2 inline-flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors disabled:cursor-not-allowed bg-blue-500 border-blue-500 opacity-60\" data-testid=\"checklist-check-id-2\"><svg class=\"w-4 h-4 text-white opacity-100\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3\" d=\"M5 13l4 4L19 7\"></path></svg></button>", true, false, true]
];

describe("BACKLOG-3588 — the item row's checkbox is unchanged by the extraction", () => {
  it.each(BEFORE.map(([name, html, checked, readOnly, pending]) => [name, html, checked, readOnly, pending]))(
    "%s: byte-identical to the pre-extraction row",
    (_name, html, checked, readOnly, pending) => {
      const item = { ...fixtureItem(0), isChecked: checked as boolean };
      render(
        <ChecklistItemRow
          item={item}
          links={[]}
          readOnly={readOnly}
          pending={pending}
          attachmentsById={new Map()}
          threads={[]}
          onToggle={noop}
          onSaveNote={() => Promise.resolve(true)}
          onOpenPicker={noop}
          onRemoveLink={() => Promise.resolve()}
          viewer={{ onViewAttachment: noop, downloadingAttachmentId: null, onViewThread: () => Promise.resolve() }}
        />,
      );
      expect(screen.getByTestId(`checklist-check-${item.id}`).outerHTML).toBe(html);
    },
  );
});
