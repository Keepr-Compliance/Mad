/**
 * BACKLOG-3367 — the ONE place an export drops a hidden text: `resolveExportPlan`.
 *
 * The shared conversation read MARKS a hidden text and never filters it
 * (BACKLOG-3366) — the Texts tab must still show it, grayed. Everything that
 * turns that marker into an omission lives in the resolver, so every export
 * format inherits the same decision and no renderer re-derives it.
 *
 * Plans are built with the REAL resolver through `testExportPlan()`, never by
 * hand, so no case here can describe a plan production cannot produce.
 *
 * Fixture values are TRANSCRIBED from the producer, not invented: the marker is
 * a SQLite `EXISTS(...)` projection at `communicationDbService.ts:911`, so it
 * arrives as the integer `1` or `0` — never the boolean `true`. `external_id`
 * and `associated_message_guid` are projected columns on the same rows, and the
 * guid is stored already-normalized at import time.
 *
 * What each control holds, and the wrong build it catches:
 *   P1   the filter is absent entirely
 *   P2   reactions to a hidden parent survive (a CSV/JSON row that reveals a
 *        message existed, and who reacted to it)
 *   P2b  reaction guids derived from the in-scope set instead of the whole input
 *   P3   the count taken before the date window
 *   P4   the count taken before the content selection
 *   P5   `attachmentComms` derived before the hidden filter — a hidden text's
 *        attachments written to disk AND fetched from the provider
 *   P9   the export consulting the BACKLOG-3365 plan gate
 */

import type { Communication } from "../../types/models";
import { testExportPlan } from "./helpers/exportPlanFixture";
import * as fs from "fs";
import * as path from "path";

const ids = (comms: Communication[]): string[] => comms.map((c) => c.id as string);

/** A text row in the shape `getCommunicationsWithMessages` projects it. */
function text(
  id: string,
  sentAt: string,
  opts: { hidden?: 0 | 1; externalId?: string | null } = {},
): Communication {
  return {
    id,
    communication_type: "imessage",
    channel: "imessage",
    body_text: `body of ${id}`,
    sent_at: sentAt,
    external_id: opts.externalId === undefined ? `guid-${id}` : opts.externalId,
    associated_message_type: null,
    associated_message_guid: null,
    has_attachments: false,
    hidden_from_export: opts.hidden ?? 0,
  } as unknown as Communication;
}

/** A tapback row: `associated_message_type` in the 2000-3005 band. */
function reaction(id: string, parentGuid: string, sentAt: string): Communication {
  return {
    id,
    communication_type: "imessage",
    channel: "imessage",
    body_text: "",
    sent_at: sentAt,
    external_id: `guid-${id}`,
    associated_message_type: 2000,
    associated_message_guid: parentGuid,
    has_attachments: false,
    hidden_from_export: 0,
  } as unknown as Communication;
}

function email(id: string, sentAt: string): Communication {
  return {
    id,
    communication_type: "email",
    channel: "email",
    subject: `subject of ${id}`,
    sent_at: sentAt,
    external_id: `ext-${id}`,
    has_attachments: false,
    hidden_from_export: 0,
  } as unknown as Communication;
}

const WINDOW = { startDate: "2026-03-01", endDate: "2026-03-31" };

describe("BACKLOG-3367 P1 — a hidden text is omitted, and counted", () => {
  it("drops the hidden text, keeps the visible text and the email, counts 1", () => {
    const hidden = text("H", "2026-03-10T10:00:00Z", { hidden: 1 });
    const visible = text("V", "2026-03-11T10:00:00Z");
    const mail = email("E", "2026-03-12T10:00:00Z");

    const plan = testExportPlan([hidden, visible, mail], WINDOW);

    expect(ids(plan.communications)).toEqual(["V", "E"]);
    expect(plan.hiddenTextCount).toBe(1);
    expect(ids(plan.hiddenTexts)).toEqual(["H"]);
  });

  it("states 0 and an empty list when nothing is hidden", () => {
    const plan = testExportPlan(
      [text("V", "2026-03-11T10:00:00Z"), email("E", "2026-03-12T10:00:00Z")],
      WINDOW,
    );

    expect(ids(plan.communications)).toEqual(["V", "E"]);
    expect(plan.hiddenTextCount).toBe(0);
    expect(plan.hiddenTexts).toEqual([]);
  });

  it("an email is never counted as a hidden text (its marker is 0 by construction)", () => {
    // The hide table keys on a `messages` row, so the EXISTS subquery cannot
    // match an email. This pins the resolver's own guard rather than trusting
    // that the SQL can never emit a 1 here.
    const markedEmail = {
      ...email("E", "2026-03-12T10:00:00Z"),
      hidden_from_export: 1,
    } as unknown as Communication;

    const plan = testExportPlan([markedEmail], WINDOW);

    expect(ids(plan.communications)).toEqual(["E"]);
    expect(plan.hiddenTextCount).toBe(0);
  });
});

describe("BACKLOG-3367 P2 — a reaction to a hidden text is dropped with it", () => {
  it("drops the tapback on the hidden parent, keeps the tapback on the visible one", () => {
    const hidden = text("H", "2026-03-10T10:00:00Z", { hidden: 1 });
    const visible = text("V", "2026-03-11T10:00:00Z");
    const onHidden = reaction("R1", "guid-H", "2026-03-10T10:05:00Z");
    const onVisible = reaction("R2", "guid-V", "2026-03-11T10:05:00Z");

    const plan = testExportPlan([hidden, visible, onHidden, onVisible], WINDOW);

    expect(ids(plan.communications)).toEqual(["V", "R2"]);
    // Reactions are dropped but never COUNTED: the count is a count of messages
    // a reader would have seen, and a tapback is decoration on one.
    expect(plan.hiddenTextCount).toBe(1);
    expect(ids(plan.hiddenTexts)).toEqual(["H"]);
  });

  it("keeps a reaction whose parent guid matches nothing hidden", () => {
    const plan = testExportPlan(
      [
        text("H", "2026-03-10T10:00:00Z", { hidden: 1 }),
        text("V", "2026-03-11T10:00:00Z"),
        reaction("R", "guid-SOMETHING-ELSE", "2026-03-11T10:05:00Z"),
      ],
      WINDOW,
    );

    expect(ids(plan.communications)).toEqual(["V", "R"]);
  });

  it("keeps a reaction carrying no parent guid at all", () => {
    const orphan = {
      ...reaction("R", "guid-H", "2026-03-11T10:05:00Z"),
      associated_message_guid: null,
    } as unknown as Communication;

    const plan = testExportPlan(
      [text("H", "2026-03-10T10:00:00Z", { hidden: 1 }), orphan],
      WINDOW,
    );

    // Nothing to match against, so nothing to drop it for. The renderer already
    // never displays it (`partitionReactions` drops a guid-less tapback).
    expect(ids(plan.communications)).toEqual(["R"]);
  });
});

describe("BACKLOG-3367 P2b — reaction guids come from the WHOLE input", () => {
  it("drops an in-window tapback whose hidden parent is OUTSIDE the window", () => {
    // The parent's own omission is the window's doing and is not counted. Its
    // tapback is inside the window, so a guid set scoped to `inScope` would not
    // know the parent was hidden and would leave the tapback in the CSV/JSON
    // rows — where it reveals that a message existed at that time.
    const hiddenBefore = text("H", "2026-02-20T10:00:00Z", { hidden: 1 });
    const tapbackInside = reaction("R", "guid-H", "2026-03-02T10:00:00Z");
    const visible = text("V", "2026-03-11T10:00:00Z");

    const plan = testExportPlan([hiddenBefore, tapbackInside, visible], WINDOW);

    expect(ids(plan.communications)).toEqual(["V"]);
    expect(plan.hiddenTextCount).toBe(0);
    expect(plan.hiddenTexts).toEqual([]);
  });

  it("drops an in-window tapback whose hidden parent is excluded by CONTENT type", () => {
    // Same shape through the other pre-filter. `contentType: "texts"` keeps both
    // rows in scope, so the discriminating case is the reverse: a window that
    // admits the tapback and not the parent, asserted above. Here the parent is
    // in scope and the count is 1 — the pair proves the two filters are ordered
    // as stated rather than that one of them happens to catch everything.
    const plan = testExportPlan(
      [
        text("H", "2026-03-10T10:00:00Z", { hidden: 1 }),
        reaction("R", "guid-H", "2026-03-10T10:05:00Z"),
      ],
      { ...WINDOW, contentType: "texts" },
    );

    expect(plan.communications).toEqual([]);
    expect(plan.hiddenTextCount).toBe(1);
  });
});

describe("BACKLOG-3367 P3 — the count is taken AFTER the date window", () => {
  it("a hidden text outside the window is not counted; the same text inside is", () => {
    const outside = testExportPlan(
      [text("H", "2026-01-05T10:00:00Z", { hidden: 1 }), text("V", "2026-03-11T10:00:00Z")],
      WINDOW,
    );
    expect(outside.hiddenTextCount).toBe(0);
    expect(ids(outside.communications)).toEqual(["V"]);

    const inside = testExportPlan(
      [text("H", "2026-03-05T10:00:00Z", { hidden: 1 }), text("V", "2026-03-11T10:00:00Z")],
      WINDOW,
    );
    expect(inside.hiddenTextCount).toBe(1);
    expect(ids(inside.communications)).toEqual(["V"]);
  });
});

describe("BACKLOG-3367 P4 — the count is taken AFTER the content selection", () => {
  it("an emails-only export does not count a hidden text it was never going to show", () => {
    const plan = testExportPlan(
      [text("H", "2026-03-10T10:00:00Z", { hidden: 1 }), email("E", "2026-03-12T10:00:00Z")],
      { ...WINDOW, contentType: "emails" },
    );

    expect(ids(plan.communications)).toEqual(["E"]);
    expect(plan.hiddenTextCount).toBe(0);
  });

  it("the same input with contentType 'both' counts it", () => {
    const plan = testExportPlan(
      [text("H", "2026-03-10T10:00:00Z", { hidden: 1 }), email("E", "2026-03-12T10:00:00Z")],
      { ...WINDOW, contentType: "both" },
    );

    expect(ids(plan.communications)).toEqual(["E"]);
    expect(plan.hiddenTextCount).toBe(1);
  });
});

describe("BACKLOG-3367 P5 — a hidden text's attachments are never selected", () => {
  const withAttachment = (id: string, hidden: 0 | 1): Communication =>
    ({
      ...text(id, "2026-03-10T10:00:00Z", { hidden }),
      has_attachments: true,
      attachment_count: 2,
    }) as unknown as Communication;

  // `attachmentComms` is the ONLY gate on writing an attachment file to disk AND
  // on fetching one from the provider (BACKLOG-2769). A hidden text reaching it
  // means the user hid a message and its photo shipped anyway.
  const cases: Array<["all" | "text", "folder" | "pdf"]> = [
    ["all", "folder"],
    ["all", "pdf"],
    ["text", "folder"],
    ["text", "pdf"],
  ];

  for (const [attachmentType, format] of cases) {
    it(`${format} export, attachments "${attachmentType}": the hidden text is absent from attachmentComms`, () => {
      const plan = testExportPlan(
        [withAttachment("H", 1), withAttachment("V", 0)],
        { ...WINDOW, attachmentType, format },
      );

      expect(plan.writesAttachmentsToDisk).toBe(true);
      expect(ids(plan.attachmentComms)).toEqual(["V"]);
      expect(ids(plan.attachmentComms)).not.toContain("H");
      expect(plan.hiddenTextCount).toBe(1);
    });
  }
});

describe("BACKLOG-3367 P9 — the export never consults the hide feature gate", () => {
  // BACKLOG-3365 decides whether a user may HIDE. Once a text is hidden the
  // export honours it unconditionally: a plan change must never resurrect
  // already-hidden texts into an audit package a third party has been given.
  // Source-level, in the shape of `exportPlan.noReviewFilter-2866.test.ts`.
  //
  // BACKLOG-3365 added `exportUtils.ts`: it is imported by `pdfExportService`,
  // by all three `folderExport` helpers and by `exportHandleSql`, so it is as
  // much on the export path as the three above. A named list can never be
  // proven complete, though, which is why `hideFromExportGateIdentity-3365`
  // asks the same question from the other end — the set of files that name the
  // gate, over the whole production tree.
  const sources = [
    "../exportPlan.ts",
    "../../handlers/transactionExportHandlers.ts",
    "../exportNotices.ts",
    "../../utils/exportUtils.ts",
  ];

  for (const rel of sources) {
    it(`${path.basename(rel)} references no feature gate`, () => {
      const source = fs.readFileSync(path.join(__dirname, rel), "utf8");

      // Positive control: the file was actually read and is the right one.
      expect(source.length).toBeGreaterThan(200);

      for (const forbidden of [
        "featureGate",
        "isHideFromExportAllowed",
        "hideFromExportGateStub",
        "useHideFromExportState",
        "hide_from_export",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    });
  }
});
