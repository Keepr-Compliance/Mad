/**
 * BACKLOG-3617 — the create-your-own hint in the checklist chooser, by role.
 *
 * The role is the answer of `checklists:can-edit-templates` (the database's
 * `can_edit_checklist_templates`, the portal Checklists page's own check),
 * mocked here at the preload bridge — the same boundary the real chooser reads
 * through `checklistService`.
 *
 * Three answers, three renderings:
 *   creator  `{ success: true, canEdit: true }`   → create line + "Checklists" link
 *   agent    `{ success: true, canEdit: false }`  → no link; nothing under the list
 *   unknown  `{ success: false }` or non-boolean  → today's "Templates come from…"
 *
 * Wrong implementations this suite is here to catch:
 *   FLAT  unknown flattened to "agent" (or to "creator") — the fallback line lost.
 *   TWO   the two views reading different role checks, so one flips without the other.
 *   LINK  the link shown to someone who cannot create, or not opening the portal.
 *   EMPTY "Select one from the list" shown when the list is empty.
 */
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChecklistTemplateChooser, canCreateChecklists } from "../ChecklistTemplateChooser";
import { fixtureTemplates } from "./checklistFixture";

const api = () => window.api.checklists as unknown as Record<string, jest.Mock>;

type Role = "creator" | "agent" | "unknown";
const ROLE_ANSWER: Record<Role, unknown> = {
  creator: { success: true, canEdit: true },
  agent: { success: true, canEdit: false },
  unknown: { success: false, error: "Couldn't check checklist permissions right now." },
};

// Exact copy, founder decision on BACKLOG-3617 (pm_comments 104ef6f1).
const CREATOR_ADD = "Need a different checklist? Create your own → Checklists.";
const CREATOR_PICK = "Need a checklist? Select one from the list or create your own → Checklists.";
const CREATOR_EMPTY = "Need a checklist? Create your own → Checklists.";
const AGENT_PICK = "Need a checklist? Select one from the list.";
const FALLBACK = "Templates come from your organization’s checklist settings.";

function renderChooser(mode: "pick" | "add") {
  return render(
    <ChecklistTemplateChooser mode={mode} onAdd={jest.fn().mockResolvedValue(true)} onAllAdded={jest.fn()} />,
  );
}

/** Wait until both reads have landed: the list, and the role. */
async function settle(role: Role, empty = false) {
  if (empty) await screen.findByTestId("checklist-templates-empty");
  else await screen.findByTestId("checklist-template-list");
  await waitFor(() => expect(api().canEditTemplates).toHaveBeenCalled());
  // Let the role answer's promise chain and setState flush. Without this, an
  // "unknown" assertion could run BEFORE the answer lands (the chooser starts
  // at unknown) and pass against an implementation that flattens it.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  if (role === "creator") expect(screen.getByTestId("checklist-create-link")).toBeInTheDocument();
}

const hints = () => screen.queryAllByTestId("checklist-chooser-hint").map((n) => n.textContent);

function setRole(role: Role) {
  api().canEditTemplates.mockResolvedValue(ROLE_ANSWER[role]);
}

beforeEach(() => {
  jest.clearAllMocks();
  api().listTemplates.mockResolvedValue({ success: true, templates: fixtureTemplates(), source: "live" });
  api().openTemplatesPortal.mockResolvedValue({ success: true });
});

describe("BACKLOG-3617 — the list view (add mode)", () => {
  it("creator: the create line, and Checklists opens the portal page", async () => {
    setRole("creator");
    renderChooser("add");
    await settle("creator");
    expect(hints()).toEqual([CREATOR_ADD]);
    expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("checklist-create-link"));
    expect(api().openTemplatesPortal).toHaveBeenCalledTimes(1);
    // No URL crosses the bridge.
    expect(api().openTemplatesPortal).toHaveBeenCalledWith();
  });

  it("agent: nothing under the list, and no link", async () => {
    setRole("agent");
    renderChooser("add");
    await settle("agent");
    expect(screen.queryByText(FALLBACK)).not.toBeInTheDocument();
    expect(hints()).toEqual([]);
    expect(screen.queryByTestId("checklist-create-link")).not.toBeInTheDocument();
  });

  it("unknown (refused): today's line, no link", async () => {
    setRole("unknown");
    renderChooser("add");
    await settle("unknown");
    expect(hints()).toEqual([FALLBACK]);
    expect(screen.queryByTestId("checklist-create-link")).not.toBeInTheDocument();
  });

  it("unknown (a reply that is not a boolean): today's line, not a creator", async () => {
    api().canEditTemplates.mockResolvedValue({ success: true, canEdit: "true" });
    renderChooser("add");
    await settle("unknown");
    expect(hints()).toEqual([FALLBACK]);
    expect(screen.queryByTestId("checklist-create-link")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3617 — the first-pick view", () => {
  it("creator: select-or-create line with the link", async () => {
    setRole("creator");
    renderChooser("pick");
    await settle("creator");
    expect(screen.getByTestId("checklist-chooser-title")).toHaveTextContent(/^No checklist added yet\.$/);
    expect(hints()).toEqual([CREATOR_PICK]);
    fireEvent.click(screen.getByTestId("checklist-create-link"));
    expect(api().openTemplatesPortal).toHaveBeenCalledTimes(1);
  });

  it("agent: select-only line, no link", async () => {
    setRole("agent");
    renderChooser("pick");
    await settle("agent");
    expect(screen.getByTestId("checklist-chooser-title")).toHaveTextContent(/^No checklist added yet\.$/);
    expect(hints()).toEqual([AGENT_PICK]);
    expect(screen.queryByTestId("checklist-create-link")).not.toBeInTheDocument();
  });

  it("unknown: the agent wording, no link, no fallback line", async () => {
    setRole("unknown");
    renderChooser("pick");
    await settle("unknown");
    expect(hints()).toEqual([AGENT_PICK]);
    expect(screen.queryByTestId("checklist-create-link")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3617 — no templates at all", () => {
  beforeEach(() => {
    api().listTemplates.mockResolvedValue({ success: true, templates: [], source: "live" });
  });

  it.each(["pick", "add"] as const)("creator, %s: the create line under the empty sentence", async (mode) => {
    setRole("creator");
    renderChooser(mode);
    await settle("creator", true);
    expect(hints()).toEqual([CREATOR_EMPTY]);
  });

  it.each([
    ["agent", "pick"],
    ["agent", "add"],
    ["unknown", "pick"],
    ["unknown", "add"],
  ] as const)("%s, %s: only the empty sentence — nothing to select, nothing to create", async (role, mode) => {
    setRole(role);
    renderChooser(mode);
    await settle(role, true);
    expect(screen.getByTestId("checklist-templates-empty")).toHaveTextContent(
      "No checklist templates have been set up yet.",
    );
    expect(hints()).toEqual([]);
    expect(screen.queryByTestId("checklist-create-link")).not.toBeInTheDocument();
  });
});

describe("BACKLOG-3617 — one role check", () => {
  it("canCreateChecklists is true only for the database's literal true", () => {
    expect(canCreateChecklists(true)).toBe(true);
    expect(canCreateChecklists(false)).toBe(false);
    expect(canCreateChecklists(null)).toBe(false);
  });
});
