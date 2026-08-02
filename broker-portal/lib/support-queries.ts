/**
 * Supabase query functions for the Support Ticketing system (customer portal).
 *
 * These functions are called from the broker portal for customer-facing operations.
 * All mutations go through SECURITY DEFINER RPCs.
 */

import { createClient } from '@/lib/supabase/client';
import type {
  TicketListResponse,
  TicketDetailResponse,
  TicketPriority,
  SupportCategory,
  SupportTicketAttachment,
} from './support-types';

export async function listTickets(
  requesterEmail?: string,
  page: number = 1,
  pageSize: number = 20
): Promise<TicketListResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('support_list_tickets', {
    p_status: null,
    p_priority: null,
    p_category_id: null,
    p_assignee_id: null,
    p_search: null,
    p_requester_email: requesterEmail || null,
    p_page: page,
    p_page_size: pageSize,
  });
  if (error) throw error;
  return data as unknown as TicketListResponse;
}

export async function getTicketDetail(ticketId: string): Promise<TicketDetailResponse> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('support_get_ticket_detail', {
    p_ticket_id: ticketId,
  });
  if (error) throw error;
  return data as unknown as TicketDetailResponse;
}

export async function createTicket(params: {
  subject: string;
  description: string;
  priority: TicketPriority;
  category_id?: string | null;
  subcategory_id?: string | null;
  requester_email: string;
  requester_name: string;
}): Promise<{ id: string; ticket_number: number }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('support_create_ticket', {
    p_subject: params.subject,
    p_description: params.description,
    p_priority: params.priority,
    p_category_id: params.category_id || null,
    p_subcategory_id: params.subcategory_id || null,
    p_requester_email: params.requester_email,
    p_requester_name: params.requester_name,
    p_source_channel: 'web_form',
  });
  if (error) throw error;
  return data as unknown as { id: string; ticket_number: number };
}

export async function addMessage(
  ticketId: string,
  body: string,
  senderEmail?: string,
  senderName?: string
): Promise<{ id: string }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('support_add_message', {
    p_ticket_id: ticketId,
    p_body: body,
    p_message_type: 'reply',
    p_sender_email: senderEmail || null,
    p_sender_name: senderName || null,
  });
  if (error) throw error;
  return data as unknown as { id: string };
}

export async function getCategories(): Promise<SupportCategory[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('support_categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw error;
  return (data ?? []) as SupportCategory[];
}

/** Build hierarchical category tree from flat list */
export function buildCategoryTree(categories: SupportCategory[]): SupportCategory[] {
  const topLevel = categories.filter((c) => !c.parent_id);
  return topLevel.map((parent) => ({
    ...parent,
    children: categories
      .filter((c) => c.parent_id === parent.id)
      .sort((a, b) => a.sort_order - b.sort_order),
  }));
}

// --- Attachment functions ---

export async function uploadAttachment(
  ticketId: string,
  file: File,
  messageId?: string
): Promise<{ id: string; storage_path: string }> {
  const supabase = createClient();
  const attachmentId = crypto.randomUUID();
  const sanitizedName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${ticketId}/${attachmentId}/${sanitizedName}`;

  const { error: uploadError } = await supabase.storage
    .from('support-attachments')
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase.rpc('support_add_attachment', {
    p_ticket_id: ticketId,
    p_message_id: messageId || null,
    p_file_name: file.name,
    p_file_size: file.size,
    p_file_type: file.type,
    p_storage_path: storagePath,
  });
  if (error) throw error;
  return data as unknown as { id: string; storage_path: string };
}

export async function listAttachments(ticketId: string): Promise<SupportTicketAttachment[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('support_list_attachments', {
    p_ticket_id: ticketId,
  });
  if (error) throw error;
  return (data ?? []) as unknown as SupportTicketAttachment[];
}

/**
 * Record that someone opened a support attachment (BACKLOG-2393).
 *
 * Until now nothing recorded who read a customer's diagnostics. That was
 * tolerable while the only attachments were files a person chose to send; it is
 * not tolerable now that support access mode uploads them on a timer.
 *
 * Deliberately best-effort: a failure to write the audit row must not stop a
 * support agent from opening a file they are entitled to open. It is logged to
 * the console so the gap is visible rather than silent.
 *
 * Scope, stated honestly: this logs reads that go through the portal. It is not
 * a tamper-proof audit of the storage layer, and it does not claim to be.
 */
export async function recordAttachmentAccess(attachmentId: string): Promise<void> {
  try {
    const supabase = createClient();
    const { error } = await supabase.rpc('support_record_attachment_access', {
      p_attachment_id: attachmentId,
    });
    if (error) {
      console.warn('[support] attachment read not logged:', error.message);
    }
  } catch (err) {
    console.warn('[support] attachment read not logged:', err);
  }
}

export async function getAttachmentUrl(
  storagePath: string,
  attachmentId?: string
): Promise<string> {
  // Log the read before minting the URL: if the URL is never produced there was
  // no read, but a URL produced without a log entry would be an unrecorded one.
  if (attachmentId) await recordAttachmentAccess(attachmentId);
  const supabase = createClient();
  const { data, error } = await supabase.storage
    .from('support-attachments')
    .createSignedUrl(storagePath, 3600);
  if (error) throw error;
  return data.signedUrl;
}

export async function closeTicketByRequester(ticketId: string): Promise<{ closed: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc('support_close_ticket_by_requester', {
    p_ticket_id: ticketId,
  });
  if (error) throw error;
  return data as unknown as { closed: boolean };
}
