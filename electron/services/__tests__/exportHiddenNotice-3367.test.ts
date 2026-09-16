/**
 * @jest-environment node
 */

/**
 * BACKLOG-3367 — EVERY export output that can contain texts states how many
 * texts were hidden from it.
 *
 * The outputs were ENUMERATED, not sampled. Derivation, re-run at this branch's
 * base (`2888c483d`) rather than inherited from the plan:
 *
 *   git grep -n resolveExportPlan -- electron src      -> 3 non-test call sites,
 *                                                         all in the one handler file
 *   git grep -n 'exportFolder|exportEnhanced|exportPDF' -- src
 *                                                      -> exportFolder  ExportModal.tsx:207
 *                                                         exportEnhanced ExportModal.tsx:220,
 *                                                                        useBulkActions.ts:196
 *                                                         exportPDF      ZERO non-test hits
 *   positive control: all three names hit electron/preload/transactionBridge.ts
 *                     (:500, :335, :326), so the grep can find them
 *   no dynamic `api.transactions[...]` access in src
 *
 * So there are TWO live channels, and this file covers every artifact either of
 * them writes:
 *
 *   F1  combined PDF, index page                    export-enhanced "pdf"
 *   F2  summary-only PDF                            export-enhanced "pdf" + summaryOnly
 *   F3  combined PDF + attachments/manifest.json    export-enhanced "pdf" + attachments
 *   F4  folder export Summary_Report.pdf            export-folder
 *   F5  folder export attachments/manifest.json     export-folder  (BOTH write sites)
 *   F6  folder export texts/<conversation>.pdf      export-folder  (its OWN count)
 *   F7  CSV                                         export-enhanced "csv"
 *   F8  Excel                                       export-enhanced "excel"
 *   F9  JSON                                        export-enhanced "json"
 *   F10 TXT+EML SUMMARY.txt                         export-enhanced "txt_eml"
 *   F11 per-message .txt / .eml                     no notice by design — SUMMARY.txt
 *                                                   is the only file describing the export
 *
 * `transactions:export-pdf` is excluded: no caller in src/, founder ruled it
 * deleted 2026-09-12 (BACKLOG-3234 → BACKLOG-3302).
 */

let lastLoadedHtmlContent: string | null = null;

const mockPrintToPDF = jest.fn().mockResolvedValue(Buffer.from("mock-pdf-data"));
const mockLoadFile = jest.fn().mockResolvedValue(undefined);

jest.mock("electron", () => ({
  BrowserWindow: jest.fn().mockImplementation(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    return {
      loadFile: (...args: unknown[]) => {
        const result = mockLoadFile(...args);
        if (handlers["did-finish-load"]) setImmediate(() => handlers["did-finish-load"]());
        return result;
      },
      webContents: {
        printToPDF: mockPrintToPDF,
        on: (event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = cb;
        },
      },
      close: jest.fn(),
      isDestroyed: jest.fn().mockReturnValue(false),
    };
  }),
  app: {
    getPath: jest.fn((pathType: string) => {
      if (pathType === "downloads") return "/mock/downloads";
      if (pathType === "temp") return "/mock/temp";
      return "/mock/path";
    }),
  },
}));

/** Every file the exporters write, path -> content. */
const writes: Array<{ path: string; content: unknown }> = [];

const mockWriteFile = jest.fn().mockImplementation(async (filePath: string, content: unknown) => {
  writes.push({ path: filePath, content });
  if (typeof content === "string" && content.includes("<!DOCTYPE html>")) {
    lastLoadedHtmlContent = content;
  }
  return undefined;
});

jest.mock("fs/promises", () => ({
  writeFile: mockWriteFile,
  mkdir: jest.fn().mockResolvedValue(undefined),
  access: jest.fn().mockResolvedValue(undefined),
  copyFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../logService", () => {
  const noop = jest.fn();
  return {
    __esModule: true,
    default: { info: noop, warn: noop, error: noop, debug: noop, log: noop },
  };
});

jest.mock("../databaseService", () => ({
  __esModule: true,
  default: {
    getRawDatabase: jest.fn().mockReturnValue({
      prepare: jest.fn().mockReturnValue({ all: jest.fn().mockReturnValue([]) }),
    }),
    getAttachmentsForExportBulk: jest.fn().mockReturnValue([]),
  },
}));

import type { Communication, Transaction } from "../../types/models";
import type { TransactionWithDetails } from "../transactionService/types";
import folderExportService from "../folderExportService";
import enhancedExportService from "../enhancedExportService";
import { testExportPlan } from "./helpers/exportPlanFixture";
import { generateSummaryHTML } from "../folderExport/summaryHelpers";
import { generateTextThreadHTML } from "../folderExport/textExportHelpers";

// --- The exact sentences every artifact must carry --------------------------

const TWO_HIDDEN = "2 text messages in this transaction were hidden from this export.";
const ONE_HIDDEN = "1 text message in this transaction was hidden from this export.";
const ONE_HIDDEN_CONVO = "1 text message in this conversation was hidden from this export.";
const TWO_HIDDEN_CONVO = "2 text messages in this conversation were hidden from this export.";

// --- Fixtures ---------------------------------------------------------------

const TRANSACTION: TransactionWithDetails = {
  id: "txn-3367",
  user_id: "user-3367",
  property_address: "27 Hidden Lane",
  transaction_type: "purchase",
  started_at: "2026-03-01",
  closed_at: "2026-03-31",
  communications: [],
  contact_assignments: [],
} as unknown as TransactionWithDetails;

function text(
  id: string,
  thread: string,
  sentAt: string,
  hidden: 0 | 1,
  extra: Partial<Communication> = {},
): Communication {
  return {
    id,
    message_id: id,
    user_id: "user-3367",
    thread_id: thread,
    sender: "+15555550112",
    body_text: `body of ${id}`,
    body_plain: `body of ${id}`,
    direction: "inbound",
    sent_at: sentAt,
    communication_type: "imessage",
    channel: "imessage",
    external_id: `guid-${id}`,
    associated_message_type: null,
    associated_message_guid: null,
    has_attachments: false,
    hidden_from_export: hidden,
    ...extra,
  } as unknown as Communication;
}

/** Two hidden texts in ONE conversation, one visible text in the same one. */
const CONVO_A_VISIBLE = text("a-visible", "thread-A", "2026-03-10T10:00:00Z", 0);
const CONVO_A_HIDDEN_1 = text("a-hidden-1", "thread-A", "2026-03-10T11:00:00Z", 1);
const CONVO_A_HIDDEN_2 = text("a-hidden-2", "thread-A", "2026-03-10T12:00:00Z", 1);
/** A second conversation that lost nothing. */
const CONVO_B_VISIBLE = text("b-visible", "thread-B", "2026-03-11T10:00:00Z", 0);

const MIXED = [CONVO_A_VISIBLE, CONVO_A_HIDDEN_1, CONVO_A_HIDDEN_2, CONVO_B_VISIBLE];
const NOTHING_HIDDEN = [CONVO_A_VISIBLE, CONVO_B_VISIBLE];

const WINDOW = { startDate: "2026-03-01", endDate: "2026-03-31" };

const plan = (comms: Communication[], opts: Record<string, unknown> = {}) =>
  testExportPlan(comms, { ...WINDOW, ...opts } as never);

const written = (fragment: string): string[] =>
  writes.filter((w) => w.path.includes(fragment)).map((w) => String(w.content));

/** The HTML the exporter last rendered. Fails loudly rather than asserting on null. */
function renderedHtml(): string {
  if (lastLoadedHtmlContent === null) {
    throw new Error("no HTML was rendered — the export wrote nothing to assert on");
  }
  return lastLoadedHtmlContent;
}

beforeEach(() => {
  jest.clearAllMocks();
  writes.length = 0;
  lastLoadedHtmlContent = null;
});

// ---------------------------------------------------------------------------
// N1 / F1 — combined PDF index page
// ---------------------------------------------------------------------------

describe("N1 / F1 — the combined PDF's index page states the count", () => {
  it("renders the sentence for a 2-hidden export", async () => {
    await enhancedExportService.exportTransaction(TRANSACTION, plan(MIXED, { format: "pdf" }), {
      exportFormat: "pdf",
    });

    expect(lastLoadedHtmlContent).toContain(TWO_HIDDEN);
  });

  it("renders it through the OTHER _exportPDF branch too (attachments folder)", async () => {
    // `_exportPDF` reaches the combined renderer from two branches. A default of
    // 0 on the count would let one branch forget it and still compile, which is
    // the failure this pair exists to catch (SR required change 2).
    await enhancedExportService.exportTransaction(
      TRANSACTION,
      plan(MIXED, { format: "pdf", attachmentType: "all" }),
      { exportFormat: "pdf" },
    );

    expect(lastLoadedHtmlContent).toContain(TWO_HIDDEN);

    // F3 — the same branch writes an attachments/manifest.json. Asserted here
    // rather than only through the folder export, which is a different caller.
    const manifests = written("manifest.json");
    expect(manifests).toHaveLength(1);
    expect(JSON.parse(manifests[0]).hiddenFromExport).toEqual({ texts: 2 });
  });

  it("each per-thread SECTION of the combined PDF states its own count", async () => {
    // The combined PDF's thread sections each carry their own anchor and
    // back-link and are read as units, so each states what was removed from it.
    // `renderCombinedHTML` groups them with `getThreadKey()`, the same helper
    // `exportTextConversations` uses — the two formats must not disagree about
    // what a conversation lost.
    await enhancedExportService.exportTransaction(TRANSACTION, plan(MIXED, { format: "pdf" }), {
      exportFormat: "pdf",
    });
    const doc = renderedHtml();

    const sections = doc.split('<div class="doc-section doc-text-thread');
    const sectionA = sections.find((s) => s.includes("body of a-visible"));
    const sectionB = sections.find((s) => s.includes("body of b-visible"));

    expect(sectionA).toBeDefined();
    expect(sectionB).toBeDefined();
    expect(sectionA).toContain(TWO_HIDDEN_CONVO);
    expect(sectionB).not.toContain("hidden from this export");
  });

  it("does not disturb the index links the combined PDF depends on", async () => {
    // `injectIndexLinks()` rewrites `.email-item` / `.text-item` rows and the
    // Threads Index headings by REGEX. A notice caught by that rewrite would
    // break every internal link in the document.
    await enhancedExportService.exportTransaction(TRANSACTION, plan(MIXED, { format: "pdf" }), {
      exportFormat: "pdf",
    });
    const withNotice = renderedHtml();

    writes.length = 0;
    lastLoadedHtmlContent = null;
    await enhancedExportService.exportTransaction(
      TRANSACTION,
      plan(NOTHING_HIDDEN, { format: "pdf" }),
      { exportFormat: "pdf" },
    );
    const without = renderedHtml();

    const links = (html: string) => (html.match(/href="#text-thread-\d+"/g) || []).length;
    expect(links(withNotice)).toBeGreaterThan(0);
    expect(links(withNotice)).toBe(links(without));
  });
});

// ---------------------------------------------------------------------------
// N2 / F2 — summary-only PDF
// ---------------------------------------------------------------------------

describe("N2 / F2 — the summary-only PDF states the count", () => {
  it("renders the sentence with summaryOnly true", async () => {
    await enhancedExportService.exportTransaction(
      TRANSACTION,
      plan(MIXED, { format: "pdf", summaryOnly: true }),
      { exportFormat: "pdf", summaryOnly: true },
    );

    expect(lastLoadedHtmlContent).toContain(TWO_HIDDEN);
  });
});

// ---------------------------------------------------------------------------
// N1b — the case the notice most exists for
// ---------------------------------------------------------------------------

describe("N1b — the notice renders when EVERY text is hidden", () => {
  it("states the count on a page that has no Text Threads Index at all", () => {
    // With every text hidden, `texts.length` is 0 and the Text Threads Index
    // section does not render. A notice placed inside that section would vanish
    // in precisely the case where the whole record is missing.
    const html = generateSummaryHTML(
      TRANSACTION,
      [],
      { hiddenTextCount: 2 },
      undefined,
      "thread",
    );

    expect(html).toContain(TWO_HIDDEN);
    expect(html).not.toContain("Text Threads Index");
  });

  it("through the real folder export, with every text hidden", async () => {
    const allHidden = [CONVO_A_HIDDEN_1, CONVO_A_HIDDEN_2];
    await folderExportService.exportTransactionToFolder(
      TRANSACTION,
      plan(allHidden),
      { transactionId: TRANSACTION.id, outputPath: "/mock/output" },
    );

    const summaryHtml = writes
      .map((w) => String(w.content))
      .find((c) => c.includes("Transaction Audit Summary"));
    expect(summaryHtml).toBeDefined();
    expect(summaryHtml).toContain(TWO_HIDDEN);
  });
});

// ---------------------------------------------------------------------------
// N3 / F4 + N4 / F5 + F6 — the folder export's three artifacts
// ---------------------------------------------------------------------------

describe("N3 / F4 — the folder export's Summary_Report.pdf states the count", () => {
  it("the summary HTML carries the sentence", async () => {
    await folderExportService.exportTransactionToFolder(
      TRANSACTION,
      plan(MIXED),
      { transactionId: TRANSACTION.id, outputPath: "/mock/output" },
    );

    const summaryHtml = writes
      .map((w) => String(w.content))
      .find((c) => c.includes("Transaction Audit Summary"));
    expect(summaryHtml).toContain(TWO_HIDDEN);
  });
});

describe("N4 / F5 — the folder export's manifest.json states the count", () => {
  it("carries hiddenFromExport.texts when attachments are written", async () => {
    await folderExportService.exportTransactionToFolder(
      TRANSACTION,
      plan(MIXED, { attachmentType: "all" }),
      { transactionId: TRANSACTION.id, outputPath: "/mock/output" },
    );

    const manifests = written("manifest.json");
    expect(manifests.length).toBeGreaterThan(0);
    for (const raw of manifests) {
      expect(JSON.parse(raw).hiddenFromExport).toEqual({ texts: 2 });
    }
  });

  it("carries it at the EMPTY-manifest write site too", async () => {
    // `exportAttachments` returns early, writing a manifest with no entries,
    // when nothing has an attachment. That early return is its own write site
    // and is the one an implementation forgets.
    await folderExportService.exportAttachments(
      TRANSACTION as unknown as Transaction,
      [],
      "/mock/output/attachments",
      { hiddenTextCount: 2 },
    );

    const manifests = written("manifest.json");
    expect(manifests).toHaveLength(1);
    const parsed = JSON.parse(manifests[0]);
    expect(parsed.attachments).toEqual([]);
    expect(parsed.hiddenFromExport).toEqual({ texts: 2 });
  });
});

describe("F6 — each conversation PDF states ITS OWN count", () => {
  // Founder decision 2026-09-15 (pm_comments 6306f393 item 2): a folder
  // export's texts/*.pdf is handed to someone on its own, so the summary
  // report's count never reaches its reader.
  it("the conversation that lost two texts says two; the one that lost none says nothing", async () => {
    await folderExportService.exportTransactionToFolder(
      TRANSACTION,
      plan(MIXED, { contentType: "texts" }),
      { transactionId: TRANSACTION.id, outputPath: "/mock/output" },
    );

    const threadPages = writes
      .map((w) => String(w.content))
      .filter((c) => c.includes("<h1>") && c.includes("Exported from Keepr"));

    const withA = threadPages.find((p) => p.includes("body of a-visible"));
    const withB = threadPages.find((p) => p.includes("body of b-visible"));

    expect(withA).toBeDefined();
    expect(withB).toBeDefined();
    expect(withA).toContain(TWO_HIDDEN_CONVO);
    expect(withB).not.toContain("hidden from this export");
  });

  it("a conversation page says nothing when its export hid nothing", () => {
    const html = generateTextThreadHTML(
      [CONVO_A_VISIBLE],
      { phone: "+15555550112", name: "Jane" },
      {},
      false,
      0,
      { hiddenTextCount: 0 },
    );

    expect(html).not.toContain("hidden from this export");
  });

  it("a conversation page states a singular count in singular words", () => {
    const html = generateTextThreadHTML(
      [CONVO_A_VISIBLE],
      { phone: "+15555550112", name: "Jane" },
      {},
      false,
      0,
      { hiddenTextCount: 1 },
    );

    expect(html).toContain(ONE_HIDDEN_CONVO);
  });
});

// ---------------------------------------------------------------------------
// N5 / F7, N6 / F8 — CSV and Excel
// ---------------------------------------------------------------------------

describe("N5 / F7 and N6 / F8 — CSV and Excel state the count", () => {
  for (const exportFormat of ["csv", "excel"] as const) {
    it(`${exportFormat} carries the sentence in its header block`, async () => {
      await enhancedExportService.exportTransaction(
        TRANSACTION,
        plan(MIXED, { format: exportFormat }),
        { exportFormat },
      );

      const [content] = writes.map((w) => String(w.content));
      expect(content).toContain(TWO_HIDDEN);
      // As its own quoted single-column line, so a comma in the sentence cannot
      // shift the data columns below it.
      expect(content).toContain(`"${TWO_HIDDEN}"`);
      // Directly beside the count it qualifies.
      expect(content.indexOf("Total Communications:")).toBeLessThan(
        content.indexOf(TWO_HIDDEN),
      );
    });

    it(`${exportFormat} says nothing when nothing was hidden`, async () => {
      await enhancedExportService.exportTransaction(
        TRANSACTION,
        plan(NOTHING_HIDDEN, { format: exportFormat }),
        { exportFormat },
      );

      const [content] = writes.map((w) => String(w.content));
      expect(content).toContain("Total Communications: 2");
      expect(content).not.toContain("hidden from this export");
    });
  }
});

// ---------------------------------------------------------------------------
// N7 / F9 — JSON
// ---------------------------------------------------------------------------

describe("N7 / F9 — JSON states the count as data AND as a sentence", () => {
  it("carries hidden_texts_count and export_notices", async () => {
    await enhancedExportService.exportTransaction(
      TRANSACTION,
      plan(MIXED, { format: "json" }),
      { exportFormat: "json" },
    );

    const parsed = JSON.parse(String(writes[0].content));
    expect(parsed.transaction.hidden_texts_count).toBe(2);
    expect(parsed.export_notices).toEqual([TWO_HIDDEN]);
    // The pre-existing key is untouched — consumers keep reading what they read.
    expect(parsed.transaction.total_communications_count).toBe(2);
    expect(parsed.communications.map((c: { id: string }) => c.id)).toEqual([
      "b-visible",
      "a-visible",
    ]);
  });

  it("states 0 and an empty notices array when nothing was hidden", async () => {
    await enhancedExportService.exportTransaction(
      TRANSACTION,
      plan(NOTHING_HIDDEN, { format: "json" }),
      { exportFormat: "json" },
    );

    const parsed = JSON.parse(String(writes[0].content));
    expect(parsed.transaction.hidden_texts_count).toBe(0);
    expect(parsed.export_notices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// N8 / F10 + F11 — TXT + EML
// ---------------------------------------------------------------------------

describe("N8 / F10 — the TXT+EML package's SUMMARY.txt states the count", () => {
  it("carries the sentence under the counts it qualifies", async () => {
    await enhancedExportService.exportTransaction(
      TRANSACTION,
      plan(MIXED, { format: "txt_eml" }),
      { exportFormat: "txt_eml" },
    );

    const [summary] = written("SUMMARY.txt");
    expect(summary).toBeDefined();
    expect(summary).toContain(TWO_HIDDEN);
    expect(summary.indexOf("- Texts:")).toBeLessThan(summary.indexOf(TWO_HIDDEN));
  });

  it("F11 — the hidden texts' own .txt files are absent from the package", async () => {
    await enhancedExportService.exportTransaction(
      TRANSACTION,
      plan(MIXED, { format: "txt_eml" }),
      { exportFormat: "txt_eml" },
    );

    const bodies = written(".txt").join("\n");
    expect(bodies).toContain("body of a-visible");
    expect(bodies).not.toContain("body of a-hidden-1");
    expect(bodies).not.toContain("body of a-hidden-2");
  });
});

// ---------------------------------------------------------------------------
// N9 — the renderer reads the PLAN's count, never a recount
// ---------------------------------------------------------------------------

describe("N9 — the count comes from the plan, not from the transaction", () => {
  it("a hidden text OUTSIDE the window is not counted by any artifact", async () => {
    const outOfWindow = text("out-hidden", "thread-A", "2026-01-05T10:00:00Z", 1);
    const comms = [...MIXED, outOfWindow];

    // The transaction holds THREE hidden texts; this export omitted two. A
    // renderer recounting from `transaction.communications` would print 3.
    const transaction = { ...TRANSACTION, communications: comms } as TransactionWithDetails;
    const resolved = plan(comms);
    expect(resolved.hiddenTextCount).toBe(2);

    await folderExportService.exportTransactionToFolder(transaction, resolved, {
      transactionId: TRANSACTION.id,
      outputPath: "/mock/output",
    });

    const summaryHtml = writes
      .map((w) => String(w.content))
      .find((c) => c.includes("Transaction Audit Summary")) as string;
    expect(summaryHtml).toContain(TWO_HIDDEN);
    expect(summaryHtml).not.toContain("3 text messages");
  });
});

// ---------------------------------------------------------------------------
// N0 — nothing hidden, nothing said
// ---------------------------------------------------------------------------

describe("N0 — an export that omitted nothing says nothing", () => {
  it("no format prints a notice when the count is 0", async () => {
    for (const exportFormat of ["pdf", "csv", "excel", "json", "txt_eml"] as const) {
      writes.length = 0;
      lastLoadedHtmlContent = null;

      await enhancedExportService.exportTransaction(
        TRANSACTION,
        plan(NOTHING_HIDDEN, { format: exportFormat === "pdf" ? "pdf" : exportFormat }),
        { exportFormat },
      );

      const all = writes.map((w) => String(w.content)).join("\n") + (lastLoadedHtmlContent ?? "");
      expect(all.length).toBeGreaterThan(0);
      expect(all).not.toContain("hidden from this export");
      // The `.export-notice` CSS RULE is always in the stylesheet; what must be
      // absent is a rendered block.
      expect(all).not.toContain('<div class="export-notice">');
    }
  });

  it("the folder export prints none either", async () => {
    await folderExportService.exportTransactionToFolder(
      TRANSACTION,
      plan(NOTHING_HIDDEN, { attachmentType: "all" }),
      { transactionId: TRANSACTION.id, outputPath: "/mock/output" },
    );

    const all = writes.map((w) => String(w.content)).join("\n");
    expect(all).toContain("Transaction Audit Summary");
    expect(all).not.toContain("hidden from this export");
    expect(JSON.parse(written("manifest.json")[0]).hiddenFromExport).toEqual({ texts: 0 });
  });
});

// ---------------------------------------------------------------------------
// Wording — singular, and scoped
// ---------------------------------------------------------------------------

describe("the sentence itself", () => {
  it("is singular for one hidden text", () => {
    const html = generateSummaryHTML(TRANSACTION, [], { hiddenTextCount: 1 }, undefined, "thread");
    expect(html).toContain(ONE_HIDDEN);
    expect(html).not.toContain("1 text messages");
  });

  it("names the transaction on the summary and the conversation on a thread page", () => {
    expect(
      generateSummaryHTML(TRANSACTION, [], { hiddenTextCount: 2 }, undefined, "thread"),
    ).toContain("in this transaction");

    expect(
      generateTextThreadHTML(
        [CONVO_A_VISIBLE],
        { phone: "+15555550112", name: "Jane" },
        {},
        false,
        0,
        { hiddenTextCount: 2 },
      ),
    ).toContain("in this conversation");
  });
});
