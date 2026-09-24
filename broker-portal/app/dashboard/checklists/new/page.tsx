/**
 * New checklist template — BACKLOG-3474.
 *
 * Same gate as the list. The editor opens empty with one blank item (a template
 * needs at least one); the first save creates the template and its items in
 * one call.
 */

import { notFound } from 'next/navigation';
import { requireChecklistEditorAccess } from '@/lib/checklist-access';
import ChecklistEditorClient from '../ChecklistEditorClient';

export default async function NewChecklistTemplatePage() {
  try {
    await requireChecklistEditorAccess();
  } catch {
    notFound();
  }
  return <ChecklistEditorClient templateId={null} updatedAt={null} archived={false} template={null} items={[]} />;
}
