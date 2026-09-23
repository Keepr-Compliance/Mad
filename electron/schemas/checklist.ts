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

/** `attachment` or `email`. Mirrors the CHECK on both sides. */
export const ChecklistLinkKindSchema = z.enum(['attachment', 'email']);

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

export const SelectChecklistTemplateArgsSchema = z.object({
  transactionId: UuidSchema,
  templateId: UuidSchema,
  replaceExisting: z.boolean().optional(),
});

export const GetChecklistArgsSchema = z.object({
  transactionId: UuidSchema,
});

export const RemoveChecklistArgsSchema = z.object({
  transactionId: UuidSchema,
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
 * IPC, on purpose.** `addChecklistLink` answers an empty request with
 * `targets_not_in_transaction` and an empty `rejectedIds`, which is the wrong
 * sentence for the cause — nothing was rejected because nothing was supplied.
 * Telling the two apart needs a distinct status, and a new member of
 * `AddChecklistLinkResult` is a surface decision that belongs with the surface
 * (BACKLOG-3476). Refusing the empty request at the boundary means no user can
 * reach the wrong sentence in the meantime, and the db service keeps its own
 * guard for any future caller that is not this channel.
 *
 * 200 is the same bound the plan set for one group. It is a bound on a single
 * request, not on how much evidence an item may carry.
 */
export const AddChecklistLinkArgsSchema = z.object({
  itemId: UuidSchema,
  kind: ChecklistLinkKindSchema,
  targetIds: z.array(UuidSchema).min(1).max(200),
});

export const RemoveChecklistLinkArgsSchema = z.object({
  linkId: UuidSchema,
});

export type SelectChecklistTemplateArgs = z.infer<typeof SelectChecklistTemplateArgsSchema>;
export type GetChecklistArgs = z.infer<typeof GetChecklistArgsSchema>;
export type RemoveChecklistArgs = z.infer<typeof RemoveChecklistArgsSchema>;
export type SetChecklistItemCheckedArgs = z.infer<typeof SetChecklistItemCheckedArgsSchema>;
export type SetChecklistItemNoteArgs = z.infer<typeof SetChecklistItemNoteArgsSchema>;
export type AddChecklistLinkArgs = z.infer<typeof AddChecklistLinkArgsSchema>;
export type RemoveChecklistLinkArgs = z.infer<typeof RemoveChecklistLinkArgsSchema>;
