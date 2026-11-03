/**
 * Zod schemas for transaction checklists — BACKLOG-3475.
 *
 * Two jobs, and they fail in opposite directions on purpose.
 *
 * **The cloud row schemas** validate what PostgREST hands back. A row that does
 * not parse is DROPPED and never cached — the rest of the listing is still
 * usable, and a broker who added a row this build does not understand should
 * not lose the templates that do parse. `checklistTemplateService` logs the
 * drop; it never throws.
 *
 * **The IPC argument schemas** validate what the renderer sends. A payload that
 * does not parse is REFUSED. The renderer is not the authority on any of it —
 * ids, lengths and counts all arrive over a channel anything in the window can
 * call, and the label a link carries is derived in main from the target rows
 * rather than accepted from here at all.
 *
 * The shapes mirror the cloud CHECK constraints in
 * `supabase/migrations/20260921101757_backlog_3473_transaction_checklists.sql`
 * and the local ones in `electron/database/schema.sql`. Where the two differ,
 * the stricter is used: a local row that cannot be written is better than one
 * that is written and then refused on its way up.
 */
import { z } from 'zod/v4';

import { UuidSchema } from './common';

// ============================================
// SHARED FIELD SCHEMAS
// ============================================

/**
 * The ten document types, character for character the `DocumentType` union in
 * `electron/types/models.ts` and the cloud CHECK on
 * `checklist_template_items.expected_document_type`.
 */
export const ChecklistDocumentTypeSchema = z.enum([
  'offer',
  'inspection',
  'disclosure',
  'contract',
  'appraisal',
  'amendment',
  'addendum',
  'title',
  'closing',
  'other',
]);

/**
 * `attachment`, `email` or (BACKLOG-3968 PR-4b) `text`. Mirrors the local
 * CHECK (migration v78). The cloud takes 'text' only after PR-5; a submission
 * whose cloud does not withholds text groups
 * (`electron/services/checklistTextLinksCapability.ts`), not refused here.
 */
export const ChecklistLinkKindSchema = z.enum(['attachment', 'email', 'text']);

// ============================================
// CLOUD ROW SCHEMAS (PostgREST -> desktop)
// ============================================

/**
 * One embedded `checklist_template_items` row.
 *
 * `expected_document_type` is `.catch(null)` rather than a hard failure: the
 * cloud CHECK holds the same ten values, so a value outside them means the
 * cloud added an eleventh that this build predates. Dropping the whole ITEM for
 * that would hide a row the broker can see in their own portal; dropping only
 * the hint keeps the item and loses nothing the user needs.
 */
export const CloudChecklistTemplateItemSchema = z.object({
  id: UuidSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(2000).nullable().catch(null),
  is_required: z.boolean(),
  expected_document_type: ChecklistDocumentTypeSchema.nullable().catch(null),
  sort_order: z.number().int(),
});

/**
 * One `checklist_templates` row with its items embedded.
 *
 * `checklist_template_items` is `.catch([])`: a template whose embed came back
 * malformed is still a template the broker made, and it is better shown empty
 * (where picking it produces an obviously empty checklist) than silently
 * missing from the list.
 */
export const CloudChecklistTemplateSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1).max(200),
  description: z.string().nullable().catch(null),
  sort_order: z.number().int(),
  updated_at: z.string().nullable().catch(null),
  checklist_template_items: z.array(CloudChecklistTemplateItemSchema).catch([]),
  /**
   * BACKLOG-3618. Both OPTIONAL: a database without the 3618 migration (or
   * after its rollback) returns neither, and such a row is a brokerage
   * template that is sent. A malformed owner is NOT caught — the row is
   * dropped rather than guessed to be the brokerage's. A malformed switch
   * reads as `true`: wrong in that direction costs one extra warning; wrong
   * the other way would hide one.
   */
  owner_user_id: z.string().min(1).nullable().optional(),
  include_in_submission: z.boolean().optional().catch(true),
});

export type CloudChecklistTemplate = z.infer<typeof CloudChecklistTemplateSchema>;
export type CloudChecklistTemplateItem = z.infer<typeof CloudChecklistTemplateItemSchema>;

// ============================================
// IPC ARGUMENT SCHEMAS (renderer -> main)
// ============================================

/**
 * A note. 4000 characters, which the cloud does not impose — `note` on
 * `submission_checklist_items` is bare `text`. The cap is local and deliberate:
 * an unbounded field on a row that is copied into an export is a way to make a
 * PDF that cannot be rendered. Being the stricter side costs nothing, because
 * every local note fits the cloud column by construction.
 *
 * Empty and whitespace-only both mean "clear it", so they normalise to null
 * rather than writing a row that renders as a blank note.
 */
export const ChecklistNoteSchema = z
  .string()
  .max(4000)
  .nullable()
  .transform((value) => {
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  });

/**
 * ADDS a checklist from a template (BACKLOG-3476 round 2: Change is gone,
 * so this channel never replaces or deletes one).
 */
export const SelectChecklistTemplateArgsSchema = z.object({
  transactionId: UuidSchema,
  templateId: UuidSchema,
});

export const GetChecklistArgsSchema = z.object({
  transactionId: UuidSchema,
});

/** Both required: a remove names the one checklist it takes off (BACKLOG-3476). */
export const RemoveChecklistArgsSchema = z.object({
  transactionId: UuidSchema,
  checklistId: UuidSchema,
});

export const SetChecklistItemCheckedArgsSchema = z.object({
  itemId: UuidSchema,
  checked: z.boolean(),
});

export const SetChecklistItemNoteArgsSchema = z.object({
  itemId: UuidSchema,
  note: ChecklistNoteSchema,
});

/**
 * `targetIds` is 1..200 and distinct.
 *
 * **`.min(1)` makes the db service's empty-`targetIds` branch unreachable over
 * IPC, on purpose.** An empty request is refused here, at the boundary, with a
 * validation error. `addChecklistLink` keeps its own guard for any caller that
 * is not this channel, and since BACKLOG-3476 that guard answers its own
 * status, `no_targets`, rather than `targets_not_in_transaction` with an empty
 * `rejectedIds` — nothing was rejected, because nothing was supplied.
 *
 * 200 is the same bound the plan set for one group. It is a bound on a single
 * request, not on how much evidence an item may carry.
 */
export const AddChecklistLinkArgsSchema = z
  .object({
    itemId: UuidSchema,
    kind: ChecklistLinkKindSchema,
    targetIds: z.array(UuidSchema).min(1).max(200),
    /** BACKLOG-3764: the agent's "Include it" to the outside-the-dates question. */
    includeOutsideDates: z.boolean().optional(),
  })
  // BACKLOG-3968: a text is never asked the outside-the-dates question (the
  // message upload has no such arm), so an "Include it" for one is refused.
  .refine((args) => !(args.kind === 'text' && args.includeOutsideDates === true), {
    message: 'includeOutsideDates is not accepted for a text link',
    path: ['includeOutsideDates'],
  });

/** BACKLOG-3764: "Include it" for an existing group, from the submit pre-flight. */
export const IncludeChecklistLinkOutsideDatesArgsSchema = z.object({
  transactionId: UuidSchema,
  linkId: UuidSchema,
});

export const RemoveChecklistLinkArgsSchema = z.object({
  linkId: UuidSchema,
});

/**
 * BACKLOG-3965 PR-3: the Dashboard's Todo list. `limit` is 1..50 (the db
 * service's cap); absent means the handler's default.
 */
export const ListOpenRequiredChecklistItemsArgsSchema = z.object({
  userId: UuidSchema,
  limit: z.number().int().min(1).max(50).optional(),
});

// ============================================
// BACKLOG-3966: the private checklist ("My items")
// ============================================

/**
 * One of the agent's own item titles: trimmed, 1..300 characters — the same
 * bound the `title` CHECK in schema.sql applies to every checklist item.
 */
export const MyItemTitleSchema = z.string().trim().min(1).max(300);

/** Every My-items write names the deal: the SQL is scoped to its private checklist. */
export const AddMyItemArgsSchema = z.object({
  transactionId: UuidSchema,
  title: MyItemTitleSchema,
});

export const RenameMyItemArgsSchema = z.object({
  transactionId: UuidSchema,
  itemId: UuidSchema,
  title: MyItemTitleSchema,
});

/** The section's items in their new order: every one of them, once. */
export const ReorderMyItemsArgsSchema = z.object({
  transactionId: UuidSchema,
  itemIds: z.array(UuidSchema).min(1).max(500),
});

export const RemoveMyItemArgsSchema = z.object({
  transactionId: UuidSchema,
  itemId: UuidSchema,
});

export type AddMyItemArgs = z.infer<typeof AddMyItemArgsSchema>;
export type RenameMyItemArgs = z.infer<typeof RenameMyItemArgsSchema>;
export type ReorderMyItemsArgs = z.infer<typeof ReorderMyItemsArgsSchema>;
export type RemoveMyItemArgs = z.infer<typeof RemoveMyItemArgsSchema>;

export type SelectChecklistTemplateArgs = z.infer<typeof SelectChecklistTemplateArgsSchema>;
export type GetChecklistArgs = z.infer<typeof GetChecklistArgsSchema>;
export type RemoveChecklistArgs = z.infer<typeof RemoveChecklistArgsSchema>;
export type SetChecklistItemCheckedArgs = z.infer<typeof SetChecklistItemCheckedArgsSchema>;
export type SetChecklistItemNoteArgs = z.infer<typeof SetChecklistItemNoteArgsSchema>;
export type AddChecklistLinkArgs = z.infer<typeof AddChecklistLinkArgsSchema>;
export type RemoveChecklistLinkArgs = z.infer<typeof RemoveChecklistLinkArgsSchema>;
export type IncludeChecklistLinkOutsideDatesArgs = z.infer<
  typeof IncludeChecklistLinkOutsideDatesArgsSchema
>;
export type ListOpenRequiredChecklistItemsArgs = z.infer<
  typeof ListOpenRequiredChecklistItemsArgsSchema
>;
