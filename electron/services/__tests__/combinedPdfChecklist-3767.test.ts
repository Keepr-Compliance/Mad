/**
 * @jest-environment node
 */

/**
 * BACKLOG-3767 — the checklist block in the combined PDF and the Summary PDF.
 *
 * Renders through the REAL `exportTransactionToCombinedPDF` (Chromium mocked,
 * the HTML captured from the temp-file write) over a plan built by the REAL
 * `resolveExportPlan`, so "outside the audit dates" comes from the plan's own
 * window and nothing here re-applies a date filter.
 *
 * Checklist fixtures follow `getChecklistsForTransaction`'s shape (typed by
 * `ChecklistDetail`); attachment targets follow `getChecklistExportTargets`,
 * whose real-driver read is pinned in exportChecklist-3767 (handlers).
 * The Communication id fields follow getCommunicationsWithMessages'
 * projection (communicationDbService.ts): `COALESCE(m.id, e.id, c.id) AS id`,
 * `c.email_id`, `COALESCE(c.message_id, m.id) AS message_id`,
 * `COALESCE(m.external_id, e.external_id) AS external_id`, and the
 * `hidden_from_export` marker.
 *
 * Fixture values are invented and documentation-only.
 */

let lastLoadedHtmlContent: string | null = null;

jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      loadFile: () => {
        if (handlers["did-finish-load"]) setImmediate(() => handlers["did-finish-load"]());
        return Promise.resolve(undefined);
      },
      webContents: {
        printToPDF: jest.fn().mockResolvedValue(Buffer.from("mock-pdf-data")),
        on: (event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb;
        },
      },
      close: jest.fn(),
      isDestroyed: jest.fn().mockReturnValue(false),
    };
  }),
  app: {
    getPath: jest.fn((pathType: string) => (pathType === "temp" ? "/mock/temp" : "/mock/path")),
  },
}));

jest.mock("fs/promises", () => ({
  writeFile: jest.fn().mockImplementation(async (_p: string, content: unknown) => {
    if (typeof content === "string" && content.includes("<!DOCTYPE html>")) {
      lastLoadedHtmlContent = content;
    }
  }),
  mkdir: jest.fn().mockResolvedValue(undefined),
  access: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../logService", () => {
  const mockLog = jest.fn();
  return {
    __esModule: true,
    default: { info: mockLog, warn: mockLog, error: mockLog, debug: mockLog, log: mockLog },
  };
});

jest.mock("../databaseService", () => ({
  default: {
    getRawDatabase: jest.fn().mockReturnValue({
      prepare: jest.fn().mockReturnValue({ all: jest.fn().mockReturnValue([]) }),
    }),
  },
}));

import type { Communication } from "../../types/models";
import type { ChecklistDetail, ChecklistLink } from "../../types/checklist";
import type { ExportOmissionDetail } from "../exportNotices";
import { resolveExportPlan, type ExportContentType } from "../exportPlan";
import {
  NOT_IN_EXPORT_TEXT,
  OUTSIDE_DATES_TEXT,
  staleCountText,
  type ChecklistExportData,
} from "../folderExport/checklistExportHelpers";

const NO_OMISSIONS: ExportOmissionDetail = { hiddenTextCount: 0, hiddenTexts: [], filesNotIncluded: [] };

const tx = {
  id: "txn-3767",
  user_id: "user-3767",
  property_address: "1 Fixture Way",
  transaction_type: "purchase",
  started_at: "2024-01-10",
  closed_at: "2024-01-20",
  communications: [],
  contact_assignments: [],
} as unknown as import("../transactionService/types").TransactionWithDetails;

const email = (id: string, thread: string, subject: string, sentAt: string): Communication =>
  ({
    id,
    email_id: id,
    user_id: "user-3767",
    thread_id: thread,
    subject,
    body: `<div>${subject} body</div>`,
    sender: `${id}@example.test`,
    recipients: "b@example.test",
    direction: "inbound",
    sent_at: sentAt,
    communication_type: "email",
    channel: "email",
    has_attachments: false,
    hidden_from_export: 0,
    created_at: sentAt,
  }) as unknown as Communication;

const text = (id: string, thread: string, sentAt: string, opts: { hidden?: boolean } = {}): Communication =>
  ({
    id,
    message_id: id,
    external_id: `guid-${id}`,
    user_id: "user-3767",
    thread_id: thread,
    body_text: `Text ${id}`,
    body_plain: `Text ${id}`,
    sender: "+15550101",
    direction: "inbound",
    sent_at: sentAt,
    communication_type: "sms",
    channel: "text",
    participants: JSON.stringify({ from: "+15550101", to: ["+12065550199"] }),
    has_attachments: true,
    hidden_from_export: opts.hidden ? 1 : 0,
    created_at: sentAt,
  }) as unknown as Communication;

/**
 * The transaction's loaded set, in a DB order that is NOT the document order:
 * thread B's email and text come first, so a View link built from input
 * position instead of the rendered sections lands on the wrong thread.
 */
const TX_COMMS: Communication[] = [
  email("e3", "thread-B", "Beta topic", "2024-01-12T09:00:00Z"),
  email("e1", "thread-A", "Alpha topic", "2024-01-10T10:00:00Z"),
  email("e2", "thread-A", "Re: Alpha topic", "2024-01-10T11:00:00Z"),
  email("e9", "thread-C", "Old thread", "2023-12-01T09:00:00Z"), // outside the window
  text("t2", "text-B", "2024-01-14T08:00:00Z"),
  text("t1", "text-A", "2024-01-13T08:00:00Z"),
  text("th", "text-H", "2023-11-01T08:00:00Z", { hidden: true }), // hidden AND outside
];

let seq = 0;
function lnk(
  itemId: string,
  kind: "email" | "attachment" | "text",
  label: string,
  members: Array<{ id: string; inTransaction?: boolean }>,
): ChecklistLink {
  const id = `link-${++seq}`;
  return {
    id,
    itemId,
    kind,
    label,
    sortOrder: seq,
    includeOutsideDates: false,
    members: members.map((m) => ({
      id: `m-${++seq}`,
      linkId: id,
      kind,
      attachmentId: kind === "attachment" ? m.id : null,
      emailId: kind === "email" ? m.id : null,
      messageId: kind === "text" ? m.id : null,
      inTransaction: m.inTransaction ?? true,
    })),
  };
}

function checklists(): ChecklistDetail[] {
  seq = 0;
  return [
    {
      checklist: {
        id: "cl-1",
        transactionId: "txn-3767",
        templateId: "tpl-1",
        templateName: "Purchase file",
        sortOrder: 0,
        selectedAt: null,
        isPrivate: false,
      },
      items: [
        {
          id: "it-1",
          checklistId: "cl-1",
          title: "Offer",
          description: null,
          isRequired: true,
          expectedDocumentType: null,
          isChecked: true,
          checkedAt: "2024-01-15T00:00:00Z",
          note: "Seller <b>&</b> buyer",
          sortOrder: 0,
        },
        {
          id: "it-2",
          checklistId: "cl-1",
          title: "Inspection",
          description: null,
          isRequired: false,
          expectedDocumentType: null,
          isChecked: false,
          checkedAt: null,
          note: null,
          sortOrder: 1,
        },
      ],
      linksByItemId: {
        "it-1": [
          lnk("it-1", "email", "Beta topic", [{ id: "e3" }]),
          lnk("it-1", "attachment", "t2-photo.jpg", [{ id: "att-t2" }]),
          lnk("it-1", "attachment", "ext-photo.jpg", [{ id: "att-ext" }]),
          lnk("it-1", "attachment", "e1-contract.pdf", [{ id: "att-e1" }]),
        ],
        "it-2": [
          lnk("it-2", "email", "Old thread", [{ id: "e9" }]),
          lnk("it-2", "email", "Other deal subject", [{ id: "e-stale", inTransaction: false }]),
          lnk("it-2", "attachment", "secret-photo.jpg", [{ id: "att-th" }]),
          lnk("it-2", "attachment", "hidden-first.jpg", [{ id: "att-th2" }, { id: "att-t1" }]),
          // Hidden AND no longer in the transaction: must not be counted.
          lnk("it-2", "attachment", "hidden-unlinked.jpg", [{ id: "att-hu", inTransaction: false }]),
        ],
      },
      requiredDone: 1,
      requiredTotal: 1,
      allItemsChecked: false,
    },
    {
      checklist: {
        id: "cl-2",
        transactionId: "txn-3767",
        templateId: "tpl-2",
        templateName: "Disclosures",
        sortOrder: 1,
        selectedAt: null,
        isPrivate: false,
      },
      items: [
        {
          id: "it-3",
          checklistId: "cl-2",
          title: "Seller disclosure",
          description: null,
          isRequired: true,
          expectedDocumentType: null,
          isChecked: false,
          checkedAt: null,
          note: null,
          sortOrder: 0,
        },
      ],
      linksByItemId: {},
      requiredDone: 0,
      requiredTotal: 1,
      allItemsChecked: false,
    },
  ];
}

const target = (
  attachmentId: string,
  filename: string,
  owner: { emailId?: string; messageId?: string; externalMessageId?: string; messageExternalId?: string },
  hidden = false,
) => ({
  attachmentId,
  filename,
  emailId: owner.emailId ?? null,
  messageId: owner.messageId ?? null,
  externalMessageId: owner.externalMessageId ?? null,
  messageExternalId: owner.messageExternalId ?? null,
  hidden,
});

function data(contentType: ExportContentType = "both"): ChecklistExportData {
  return {
    checklists: checklists(),
    attachmentTargets: {
      "att-t2": target("att-t2", "t2-photo.jpg", { messageId: "t2", externalMessageId: "guid-t2" }),
      // Row owned by another user's copy of t2: only the guid reaches it.
      "att-ext": target("att-ext", "ext-photo.jpg", {
        messageId: "other-copy-of-t2",
        externalMessageId: "guid-t2",
        messageExternalId: "guid-t2",
      }),
      "att-e1": target("att-e1", "e1-contract.pdf", { emailId: "e1" }),
      "att-th": target("att-th", "secret-photo.jpg", { messageId: "th", externalMessageId: "guid-th" }, true),
      "att-th2": target("att-th2", "hidden-first.jpg", { messageId: "th", externalMessageId: "guid-th" }, true),
      "att-hu": target("att-hu", "hidden-unlinked.jpg", { messageId: "th", externalMessageId: "guid-th" }, true),
      "att-t1": target("att-t1", "t1-photo.jpg", { messageId: "t1", externalMessageId: "guid-t1" }),
    },
    emailSubjects: { e3: "Beta topic", e9: "Old thread", "e-stale": "Other deal subject" },
    textTargets: {},
    includeEmails: contentType !== "texts",
    includeTexts: contentType !== "emails",
  };
}

function plan(contentType: ExportContentType = "both", summaryOnly = false) {
  return resolveExportPlan(
    {
      format: "pdf",
      contentType,
      attachmentType: "none",
      emailMode: "thread",
      startDate: "2024-01-10",
      endDate: "2024-01-20",
      summaryOnly,
    },
    TX_COMMS,
  );
}

const hrefSet = (html: string): Set<string> => {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="#([^"]+)"/g)) out.add(m[1]);
  return out;
};
const idSet = (html: string): Set<string> => {
  const out = new Set<string>();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) out.add(m[1]);
  return out;
};
/** The rendered row for one item, by its title. */
const itemRow = (html: string, title: string): string => {
  const rows = html.split('<div class="cl-item"').slice(1);
  const row = rows.find((r) => r.includes(`>${title}</span>`));
  if (!row) throw new Error(`no row for ${title}`);
  return row.split('<div class="cl-item"')[0];
};
/** The evidence line that names `name`. */
const evidenceLine = (html: string, name: string): string => {
  const lines = html.split('<div class="cl-evidence"').slice(1).map((l) => l.split("</div>")[0]);
  const line = lines.find((l) => l.includes(`<span>${name}</span>`));
  if (!line) throw new Error(`no evidence line for ${name}`);
  return line;
};
const stripGenerated = (html: string) => html.replace(/Generated on [^<]*/g, "");

describe("BACKLOG-3767 combined PDF checklist block", () => {
  let service: typeof import("../folderExportService").default;

  beforeEach(async () => {
    jest.resetModules();
    lastLoadedHtmlContent = null;
    service = (await import("../folderExportService")).default;
  });

  async function render(
    contentType: ExportContentType,
    summaryOnly: boolean,
    checklist: ChecklistExportData | undefined,
  ): Promise<string> {
    const p = plan(contentType, summaryOnly);
    await service.exportTransactionToCombinedPDF(
      tx,
      p.communications,
      "/mock/out.pdf",
      NO_OMISSIONS,
      summaryOnly,
      "thread",
      { checklist },
    );
    expect(lastLoadedHtmlContent).not.toBeNull();
    return lastLoadedHtmlContent as string;
  }

  it("C1: without checklist data the document is identical to today's call", async () => {
    const p = plan();
    await service.exportTransactionToCombinedPDF(tx, p.communications, "/mock/out.pdf", NO_OMISSIONS, false);
    const today = lastLoadedHtmlContent as string;
    const off = await render("both", false, undefined);
    expect(stripGenerated(off)).toBe(stripGenerated(today));
    expect(off).not.toContain("cl-checklist");
    const on = await render("both", false, data());
    expect(on).toContain("cl-checklist");
  });

  it("C2: each item shows its status, required marker and escaped note, per checklist", async () => {
    const doc = await render("both", false, data());
    expect(doc).toContain("Checklist: Purchase file (1 of 1 required complete)");
    expect(doc).toContain("Checklist: Disclosures (0 of 1 required complete)");
    const offer = itemRow(doc, "Offer");
    expect(offer).toContain(">Complete</span>");
    expect(offer).toContain(">Required</span>");
    expect(offer).toContain("Seller &lt;b&gt;&amp;&lt;/b&gt; buyer");
    expect(offer).not.toContain("<b>&</b>");
    const inspection = itemRow(doc, "Inspection");
    expect(inspection).toContain(">Not complete</span>");
    expect(inspection).not.toContain(">Required</span>");
    expect(itemRow(doc, "Seller disclosure")).toContain(">Not complete</span>");
    // Placed after the indexes, before the footer.
    const textIndex = doc.indexOf('id="text-threads-index"');
    const block = doc.indexOf("cl-checklist");
    const footer = doc.indexOf("This report was automatically generated");
    expect(textIndex).toBeGreaterThan(-1);
    expect(block).toBeGreaterThan(textIndex);
    expect(footer).toBeGreaterThan(block);
  });

  it("C3: View links target the section that holds the evidence, in document order", async () => {
    const doc = await render("both", false, data());
    // Thread B is the SECOND email thread and the SECOND text conversation.
    expect(evidenceLine(doc, "Beta topic")).toContain('href="#email-thread-1"');
    expect(evidenceLine(doc, "t2-photo.jpg")).toContain('href="#text-thread-1"');
    // Another copy's attachment row, reached through the guid.
    expect(evidenceLine(doc, "ext-photo.jpg")).toContain('href="#text-thread-1"');
    expect(evidenceLine(doc, "e1-contract.pdf")).toContain('href="#email-thread-0"');
    expect(evidenceLine(doc, "t1-photo.jpg")).toContain('href="#text-thread-0"');
    // The sections those links name exist and hold the evidence.
    for (const [id, needle] of [
      ["email-thread-1", "Beta topic body"],
      ["text-thread-1", "Text t2"],
      ["email-thread-0", "Alpha topic body"],
      ["text-thread-0", "Text t1"],
    ]) {
      const start = doc.indexOf(`id="${id}"`);
      expect(start).toBeGreaterThan(-1);
      const next = doc.indexOf('class="doc-section', start + 1);
      expect(doc.slice(start, next < 0 ? undefined : next)).toContain(needle);
    }
  });

  it("C4: every href in the document has a matching id", async () => {
    const doc = await render("both", false, data());
    const ids = idSet(doc);
    const dangling = [...hrefSet(doc)].filter((h) => !ids.has(h));
    expect(dangling).toEqual([]);
    expect(hrefSet(doc).size).toBeGreaterThan(0);
  });

  it("C5: evidence left out of the export is named with its reason and no link", async () => {
    const doc = await render("both", false, data());
    const old = evidenceLine(doc, "Old thread");
    expect(old).toContain(OUTSIDE_DATES_TEXT);
    expect(old).not.toContain("href=");
    // No longer part of the transaction: counted, never named.
    expect(doc).not.toContain("Other deal subject");
    expect(itemRow(doc, "Inspection")).toContain(staleCountText(1));

    const emailsOnly = await render("emails", false, data("emails"));
    const t2 = evidenceLine(emailsOnly, "t2-photo.jpg");
    expect(t2).toContain(NOT_IN_EXPORT_TEXT);
    expect(t2).not.toContain(OUTSIDE_DATES_TEXT);
    expect(t2).not.toContain("href=");
    expect(evidenceLine(emailsOnly, "Beta topic")).toContain('href="#email-thread-1"');
  });

  it("C6: the Summary PDF lists the checklist with no links or anchors, and prints the reasons as plain text", async () => {
    const doc = await render("both", true, data());
    expect(doc).toContain("Checklist: Purchase file");
    expect(itemRow(doc, "Offer")).toContain(">Complete</span>");
    expect(evidenceLine(doc, "Beta topic")).toBeDefined();
    expect(hrefSet(doc).size).toBe(0);
    expect(doc).not.toContain("View &rarr;");
    expect(doc).not.toContain("View Full");
    expect(evidenceLine(doc, "Old thread")).toContain(OUTSIDE_DATES_TEXT);
    expect(doc).not.toContain('id="email-thread-0"');
  });

  it("C10: a hidden attachment that is also unlinked is not counted, in full and Summary", async () => {
    for (const summaryOnly of [false, true]) {
      const doc = await render("both", summaryOnly, data());
      const row = itemRow(doc, "Inspection");
      expect(row).toContain(staleCountText(1));
      expect(row).not.toContain(staleCountText(2));
      expect(doc).not.toContain("hidden-unlinked.jpg");
    }
  });

  it("C9: a hidden text's attachment prints nothing, in full and Summary, even outside the window", async () => {
    for (const summaryOnly of [false, true]) {
      const doc = await render("both", summaryOnly, data());
      expect(doc).not.toContain("secret-photo.jpg");
      // A group whose label is a hidden file: the label is not printed, the
      // visible member is named on its own.
      expect(doc).not.toContain("hidden-first.jpg");
      expect(evidenceLine(doc, "t1-photo.jpg")).toBeDefined();
    }
  });
});

/**
 * BACKLOG-3968 PR-4a, C17 — a text link prints like an email link. Text
 * targets follow `getChecklistExportTargets`' `textTargets`, whose real-driver
 * read (hidden by message id and by guid) is pinned in
 * submissionChecklistTextLinks-3968.test.ts.
 */
describe("BACKLOG-3968 combined PDF checklist block — text links", () => {
  let service: typeof import("../folderExportService").default;

  beforeEach(async () => {
    jest.resetModules();
    lastLoadedHtmlContent = null;
    service = (await import("../folderExportService")).default;
  });

  const textTarget = (messageId: string, sentAt: string, opts: { externalId?: string; hidden?: boolean } = {}) => ({
    messageId,
    externalId: opts.externalId ?? `guid-${messageId}`,
    sentAt,
    hidden: opts.hidden ?? false,
  });

  function textData(contentType: ExportContentType = "both"): ChecklistExportData {
    const d = data(contentType);
    d.checklists[1].linksByItemId = {
      "it-3": [
        lnk("it-3", "text", "Text with the seller", [{ id: "t1" }]),
        lnk("it-3", "text", "Old text", [{ id: "t-old" }]),
        lnk("it-3", "text", "Secret text", [{ id: "th" }]),
        // Another copy of t2 (a re-import): only the guid reaches the section.
        lnk("it-3", "text", "Copy of t2", [{ id: "t2-copy" }]),
        lnk("it-3", "text", "Unlinked text", [{ id: "t-gone", inTransaction: false }]),
      ],
    };
    d.textTargets = {
      t1: textTarget("t1", "2024-01-13T08:00:00Z"),
      "t-old": textTarget("t-old", "2023-10-01T08:00:00Z"),
      th: textTarget("th", "2023-11-01T08:00:00Z", { hidden: true }),
      "t2-copy": textTarget("t2-copy", "2024-01-14T08:00:00Z", { externalId: "guid-t2" }),
      "t-gone": textTarget("t-gone", "2024-01-15T08:00:00Z"),
    };
    return d;
  }

  async function render(contentType: ExportContentType, summaryOnly: boolean, checklist: ChecklistExportData) {
    const p = plan(contentType, summaryOnly);
    await service.exportTransactionToCombinedPDF(tx, p.communications, "/mock/out.pdf", NO_OMISSIONS, summaryOnly, "thread", {
      checklist,
    });
    return lastLoadedHtmlContent as string;
  }

  it("C17: an included text links to its conversation; one outside the dates says so; a copy is found by guid", async () => {
    const doc = await render("both", false, textData());
    const row = itemRow(doc, "Seller disclosure");
    expect(evidenceLine(row, "Text with the seller")).toContain('href="#text-thread-0"');
    expect(evidenceLine(row, "Old text")).toContain(OUTSIDE_DATES_TEXT);
    expect(evidenceLine(row, "Old text")).not.toContain("href=");
    expect(evidenceLine(row, "Copy of t2")).toContain('href="#text-thread-1"');
  });

  it("C17: a hidden text prints nothing; an unlinked one is counted, never named", async () => {
    const doc = await render("both", false, textData());
    const row = itemRow(doc, "Seller disclosure");
    expect(row).not.toContain("Secret text");
    expect(row).not.toContain("Unlinked text");
    expect(row).toContain(staleCountText(1));
  });

  it("C17: with texts left out of the export, each text link says 'Not in this export'", async () => {
    const doc = await render("emails", false, textData("emails"));
    expect(evidenceLine(itemRow(doc, "Seller disclosure"), "Text with the seller")).toContain(NOT_IN_EXPORT_TEXT);
  });
});

