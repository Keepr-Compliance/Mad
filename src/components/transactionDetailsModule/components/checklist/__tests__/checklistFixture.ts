/**
 * BACKLOG-3476 — typed access to the producer-generated fixture.
 *
 * `fixtures/checklistFixtures-3476.json` is written by
 * `electron/services/db/__tests__/checklistRendererFixtures-3476.test.ts`,
 * which runs the real main-process producers over the real schema and fails if
 * this file drifts from them. Do not edit the JSON by hand; regenerate it.
 *
 * Every accessor returns a deep copy, so a test that mutates its fixture
 * cannot leak that change into the next test.
 */
import raw from "./fixtures/checklistFixtures-3476.json";
import type {
  ChecklistDetail,
  ChecklistItem,
  ChecklistsForTransaction,
  ChecklistTemplate,
} from "../../../../../../electron/types/checklist";
import type { UnifiedAttachment } from "../../../hooks/useTransactionAllAttachments";
import type { Communication } from "../../../types";

const clone = <T,>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;

/**
 * Every checklist on `txn-1` (BACKLOG-3476), in display order:
 *   [0] "Probe template"        4 items, 1 of 2 required, 2 ticked (one optional)
 *   [1] "Other probe template"  3 required items, 1 ticked
 *   [2] "Done probe template"   every item ticked, `allItemsChecked` true
 * Summed: 3 of 6 required.
 */
export const fixtureChecklists = (): ChecklistsForTransaction =>
  clone<ChecklistsForTransaction>(raw.checklists);

/** One checklist of the envelope, by position. */
export const fixtureChecklist = (index: number): ChecklistDetail => fixtureChecklists().checklists[index];

/** An envelope holding only the given checklists, with main's sums recomputed the way main computes them. */
export const envelopeOf = (checklists: ChecklistDetail[]): ChecklistsForTransaction => ({
  checklists,
  requiredDone: checklists.reduce((n, d) => n + d.requiredDone, 0),
  requiredTotal: checklists.reduce((n, d) => n + d.requiredTotal, 0),
});

/** The first checklist on `txn-1`: 4 items, 2 required, requiredDone 1 while 2 are ticked. */
export const fixtureDetail = (): ChecklistDetail => fixtureChecklist(0);

/** Items by position: 0 required+ticked+attachment, 1 required+thread, 2 optional+ticked+note+partly stale, 3 optional+fully stale. */
export const fixtureItem = (index: number): ChecklistItem => fixtureDetail().items[index];

/** `transactions:get-all-attachments` for the same transaction, incl. one legacy fallback row. */
export const fixtureAttachments = (): UnifiedAttachment[] => clone<UnifiedAttachment[]>(raw.attachments);

/** `transactions:getCommunications(txn, "email")` for the same transaction. */
export const fixtureEmailCommunications = (): Communication[] =>
  clone<Communication[]>(raw.emailCommunications);

/** A detail with no links at all, derived from the fixture by deleting them. */
export const fixtureDetailWithoutLinks = (): ChecklistDetail => ({ ...fixtureDetail(), linksByItemId: {} });

/**
 * Two templates in the shape `checklists:list-templates` answers — transcribed
 * from the D1 capture already pinned in `checklistTemplateService-3475.test.ts`
 * (field set and ordering), with generic names.
 *
 * Producer proof: that suite's C13-A ("the D1 capture, read live",
 * `checklistTemplateService-3475.test.ts:244-267`) runs the real cloud mapper
 * over the capture and pins its output field by field. The fields below are
 * exactly those fields.
 */
export const fixtureTemplates = (): ChecklistTemplate[] => [
  {
    id: "tpl-probe",
    name: "Probe template",
    description: null,
    sortOrder: 0,
    updatedAt: "2026-03-01T00:00:00+00:00",
    items: [
      { id: "tpi-1", title: "Probe item 1", description: "What counts for probe item 1.", isRequired: true, expectedDocumentType: null, sortOrder: 0 },
      { id: "tpi-2", title: "Probe item 2", description: null, isRequired: true, expectedDocumentType: null, sortOrder: 1 },
      { id: "tpi-3", title: "Probe item 3", description: "What counts for probe item 3.", isRequired: false, expectedDocumentType: null, sortOrder: 2 },
      { id: "tpi-4", title: "Probe item 4", description: null, isRequired: false, expectedDocumentType: null, sortOrder: 3 },
    ],
  },
  {
    id: "tpl-other",
    name: "Other probe template",
    description: null,
    sortOrder: 1,
    updatedAt: "2026-03-01T00:00:00+00:00",
    items: [
      { id: "tpo-1", title: "Other item 1", description: null, isRequired: true, expectedDocumentType: null, sortOrder: 0 },
      { id: "tpo-2", title: "Other item 2", description: null, isRequired: true, expectedDocumentType: null, sortOrder: 1 },
      { id: "tpo-3", title: "Other item 3", description: null, isRequired: true, expectedDocumentType: null, sortOrder: 2 },
    ],
  },
  {
    id: "tpl-done",
    name: "Done probe template",
    description: null,
    sortOrder: 2,
    updatedAt: "2026-03-01T00:00:00+00:00",
    items: [
      { id: "tpd-1", title: "Done item 1", description: null, isRequired: true, expectedDocumentType: null, sortOrder: 0 },
      { id: "tpd-2", title: "Done item 2", description: null, isRequired: false, expectedDocumentType: null, sortOrder: 1 },
    ],
  },
  {
    id: "tpl-fresh",
    name: "Fresh probe template",
    description: null,
    sortOrder: 3,
    updatedAt: "2026-03-01T00:00:00+00:00",
    items: [
      { id: "tpf-1", title: "Fresh item 1", description: null, isRequired: true, expectedDocumentType: null, sortOrder: 0 },
    ],
  },
];
