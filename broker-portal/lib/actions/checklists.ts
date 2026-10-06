'use server';

/**
 * Checklist template writes — BACKLOG-3474.
 *
 * Every action runs, in order:
 *   1. blockWriteDuringImpersonation()   support sessions are read-only
 *   2. requireChecklistAccess()          identity, membership, editor or own-
 *                                        checklist right, transaction_checklists
 *                                        (fail-closed)
 *   3. one write scoped to the organization the gate resolved — never an
 *      organization id taken from the browser.
 * Row-level security and save_checklist_template's own authority check hold
 * independently underneath.
 *
 * Saving is ONE rpc('save_checklist_template') call: the name, description and
 * every item change commit together or not at all. The template's updated_at is
 * passed back verbatim as text (never through a JS Date, which drops the
 * microseconds and would make every save look stale).
 *
 * BACKLOG-3618: the scope of a NEW template is decided here, from the gate:
 * an editor of the organization creates the organization's template; a
 * brokerage member who is not an editor creates their own (p_personal). A
 * solo user's personal organization never gets own rows (one list). An
 * existing template keeps its scope (the database reads it from the row), so
 * p_personal is not sent. The "Send with submissions" value is sent only when
 * the editor changed it; omitted, the database keeps the stored value.
 */

import { revalidatePath } from 'next/cache';
import { blockWriteDuringImpersonation } from '@/lib/impersonation-guards';
import { requireChecklistAccess, type ChecklistAccess } from '@/lib/checklist-access';
import { hasErrors, validateSavePayload, type SavePayload } from '@/lib/checklists/editorState';
import { reasonForRpcError, saveFailure, type SaveFailure } from '@/lib/checklists/saveErrors';

export interface SaveChecklistTemplateInput {
  /** null creates a template. */
  templateId: string | null;
  /** The template's updated_at exactly as the page read it; null on create. */
  expectedUpdatedAt: string | null;
  payload: SavePayload;
}

export type SaveChecklistTemplateResult =
  | { ok: true; id: string; updatedAt: string }
  | SaveFailure;

export type ChecklistArchiveResult = { ok: true } | { ok: false; message: string };

const LIST_PATH = '/dashboard/checklists';

async function gate(): Promise<ChecklistAccess | null> {
  if (await blockWriteDuringImpersonation()) return null;
  try {
    return await requireChecklistAccess();
  } catch {
    return null;
  }
}

export async function saveChecklistTemplate(
  input: SaveChecklistTemplateInput
): Promise<SaveChecklistTemplateResult> {
  const access = await gate();
  if (!access) return saveFailure('not_authorized');

  if (!input || typeof input !== 'object') return saveFailure('invalid');
  const templateId = input.templateId ?? null;
  const expectedUpdatedAt = input.expectedUpdatedAt ?? null;
  if (templateId !== null && (typeof templateId !== 'string' || templateId === '')) return saveFailure('invalid');
  if (templateId !== null && typeof expectedUpdatedAt !== 'string') return saveFailure('invalid');
  if (hasErrors(validateSavePayload(input.payload))) return saveFailure('invalid');

  const { payload } = input;
  const personal = templateId === null && !access.canEditOrg && !access.personalOrg;
  const args: Record<string, unknown> = {
    p_org_id: access.organizationId,
    p_template_id: templateId,
    p_expected_updated_at: templateId === null ? null : expectedUpdatedAt,
    p_name: payload.name,
    p_description: payload.description,
    p_items: payload.items,
  };
  if (personal) args.p_personal = true;
  if (typeof payload.include_in_submission === 'boolean') args.p_include_in_submission = payload.include_in_submission;
  const { data, error } = await access.supabase.rpc('save_checklist_template', args);

  if (error) {
    let reason = reasonForRpcError(error);
    if (reason === 'not_authorized' && !access.canEditOrg) reason = 'brokerage_read_only';
    if (reason === 'failed') console.warn('[checklists] save failed', error.code, error.message);
    return saveFailure(reason);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row.id !== 'string' || typeof row.updated_at !== 'string') {
    console.warn('[checklists] save returned no row');
    return saveFailure('failed');
  }

  revalidatePath(LIST_PATH);
  return { ok: true, id: row.id, updatedAt: row.updated_at };
}

const BROKERAGE_READ_ONLY = 'Only your broker or an admin can change brokerage checklists.';

async function setArchived(templateId: string, archive: boolean): Promise<ChecklistArchiveResult> {
  const access = await gate();
  if (!access) return { ok: false, message: "You don't have permission to change checklist templates." };
  if (typeof templateId !== 'string' || templateId === '') {
    return { ok: false, message: 'That template could not be found.' };
  }

  // BACKLOG-3618: a member who is not an editor archives only their own
  // templates. Checked before any write; RLS refuses the rest regardless.
  if (!access.canEditOrg) {
    const { data: row, error: readError } = await access.supabase
      .from('checklist_templates')
      .select('id, owner_user_id')
      .eq('id', templateId)
      .eq('organization_id', access.organizationId)
      .maybeSingle();
    if (readError) {
      console.warn('[checklists] archive/restore read failed', readError.code, readError.message);
      return { ok: false, message: 'The template could not be updated. Try again.' };
    }
    if (!row) return { ok: false, message: 'That template could not be found.' };
    const owner = (row as { owner_user_id: string | null }).owner_user_id;
    if (owner === null) return { ok: false, message: BROKERAGE_READ_ONLY };
    if (owner !== access.userId) return { ok: false, message: 'That template could not be found.' };
  }

  const base = access.supabase
    .from('checklist_templates')
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq('id', templateId)
    .eq('organization_id', access.organizationId);
  const scoped = archive ? base.is('archived_at', null) : base.not('archived_at', 'is', null);
  const { data, error } = await scoped.select('id');

  if (error) {
    console.warn('[checklists] archive/restore failed', error.code, error.message);
    return { ok: false, message: 'The template could not be updated. Try again.' };
  }
  if (!Array.isArray(data) || data.length === 0) {
    return {
      ok: false,
      message: archive
        ? 'That template is already archived or no longer exists. Reload the page.'
        : 'That template is already active or no longer exists. Reload the page.',
    };
  }

  revalidatePath(LIST_PATH);
  return { ok: true };
}

/** Hide a template from agents choosing a checklist. Transactions that already use it keep their copy. */
export async function archiveChecklistTemplate(templateId: string): Promise<ChecklistArchiveResult> {
  return setArchived(templateId, true);
}

/** Make an archived template available to agents again. */
export async function restoreChecklistTemplate(templateId: string): Promise<ChecklistArchiveResult> {
  return setArchived(templateId, false);
}
