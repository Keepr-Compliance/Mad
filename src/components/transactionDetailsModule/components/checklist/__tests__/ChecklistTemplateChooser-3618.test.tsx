/**
 * BACKLOG-3618 — the chooser shows the user's own templates beside the
 * brokerage's.
 *
 *   own template                    → "Mine" beside the name
 *   own template, not sent          → "Mine" and "Not sent to broker"
 *   brokerage template              → neither, whatever its switch says
 *
 * The listing is the main-process mapper's output (`isMine`,
 * `includeInSubmission`), mocked at the preload bridge; the mapper itself is
 * pinned in checklistTemplateService-3475.test.ts ("BACKLOG-3618 C10").
 *
 * Wrong implementations this suite catches:
 *   every row tagged, or the tag keyed on the switch instead of ownership;
 *   the not-sent note on a brokerage row (the database forbids it, but a
 *   renderer that reads only the switch would show it).
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChecklistTemplateChooser } from "../ChecklistTemplateChooser";
import { fixtureTemplates } from "./checklistFixture";

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;

beforeEach(() => {
  jest.clearAllMocks();
  const [brokerage, mineSent, mineNotSent, brokerageOff] = fixtureTemplates();
  api().listTemplates.mockResolvedValue({
    success: true,
    source: "live",
    templates: [
      brokerage,
      { ...mineSent, isMine: true, includeInSubmission: true },
      { ...mineNotSent, isMine: true, includeInSubmission: false },
      { ...brokerageOff, isMine: false, includeInSubmission: false },
    ],
  });
  api().canEditTemplates.mockResolvedValue({ success: true, canEdit: true });
});

it("tags only the user's own templates \"Mine\"", async () => {
  render(<ChecklistTemplateChooser mode="add" onAdd={jest.fn()} onAllAdded={jest.fn()} />);
  await screen.findByTestId("checklist-template-list");

  expect(screen.getAllByText("Mine").length).toBe(2);
  expect(screen.queryByTestId("checklist-template-mine-tpl-probe")).not.toBeInTheDocument();
  expect(screen.getByTestId("checklist-template-mine-tpl-other")).toHaveTextContent("Mine");
  expect(screen.getByTestId("checklist-template-mine-tpl-done")).toHaveTextContent("Mine");
  expect(screen.queryByTestId("checklist-template-mine-tpl-fresh")).not.toBeInTheDocument();
});

it("says \"Not sent to broker\" only on an own template set not to be sent", async () => {
  render(<ChecklistTemplateChooser mode="add" onAdd={jest.fn()} onAllAdded={jest.fn()} />);
  await screen.findByTestId("checklist-template-list");

  expect(screen.getAllByText("Not sent to broker").length).toBe(1);
  expect(screen.getByTestId("checklist-template-not-sent-tpl-done")).toHaveTextContent("Not sent to broker");
  expect(screen.queryByTestId("checklist-template-not-sent-tpl-other")).not.toBeInTheDocument();
  expect(screen.queryByTestId("checklist-template-not-sent-tpl-fresh")).not.toBeInTheDocument();
});
