/**
 * New checklist template — BACKLOG-3474.
 *
 * Same gate as the list. The editor opens empty with one blank item (a template
 * needs at least one); the first save creates the template and its items in
 * one call.
 *
 * BACKLOG-3618: a brokerage agent (not an editor of the organization) creates
 * their own checklist, with the "Send with submissions" switch. The scope is
 * decided on the server (saveChecklistTemplate), never by the browser.
 */

import { notFound } from 'next/navigation';
import { requireChecklistAccess, type ChecklistAccess } from '@/lib/checklist-access';
import ChecklistEditorClient from '../ChecklistEditorClient';

export default async function NewChecklistTemplatePage() {
  let access: ChecklistAccess;
  try {
    access = await requireChecklistAccess();
  } catch {
    notFound();
  }
  return (
    <ChecklistEditorClient
      templateId={null}
      updatedAt={null}
      archived={false}
      template={null}
      items={[]}
      own={!access.canEditOrg}
    />
  );
}
