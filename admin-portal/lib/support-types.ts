/**
 * Type definitions for the Support Ticketing system.
 *
 * Used by both the admin portal (agent dashboard) and shared query layer.
 */

export type TicketStatus = 'new' | 'assigned' | 'in_progress' | 'pending' | 'resolved' | 'closed' | 'deleted';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type MessageType = 'reply' | 'internal_note';
export type SourceChannel = 'web_form' | 'email' | 'in_app_redirect' | 'admin_created';
export type ParticipantRole = 'cc' | 'watcher';
export type PendingReason = 'customer' | 'vendor' | 'internal';

export interface SearchHighlight {
  field: 'subject' | 'description' | 'requester_name' | 'requester_email' | 'message';
  snippet: string;  // Contains <mark> tags from ts_headline
  sender_name?: string;  // Only for field: 'message'
  sent_at?: string;      // Only for field: 'message'
}

export interface SupportTicket {
  id: string;
  ticket_number: number;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  ticket_type: string | null;
  category_id: string | null;
  subcategory_id: string | null;
  requester_id: string | null;
  requester_email: string;
  requester_name: string;
  assignee_id: string | null;
  organization_id: string | null;
  source_channel: SourceChannel;
  pending_reason: PendingReason | null;
  first_response_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
  reopened_count: number;
  created_at: string;
  updated_at: string;
  // Joined fields from RPCs
  category_name?: string | null;
  subcategory_name?: string | null;
  assignee_name?: string | null;
  assignee_email?: string | null;
  // Search highlight snippets (populated when search is active)
  search_highlights?: SearchHighlight[] | null;
}

export interface SupportTicketMessage {
  id: string;
  ticket_id: string;
  sender_id: string | null;
  sender_email: string | null;
  sender_name: string | null;
  message_type: MessageType;
  body: string;
  created_at: string;
  edited_at: string | null;
  edited_by: string | null;
  attachments?: SupportTicketAttachment[];
}

export interface SupportTicketAttachment {
  id: string;
  ticket_id: string;
  message_id: string | null;
  file_name: string;
  file_size: number;
  file_type: string;
  storage_path: string;
  uploaded_by: string | null;
  created_at: string;
}

export interface SupportTicketEvent {
  id: string;
  ticket_id: string;
  actor_id: string | null;
  event_type: string;
  old_value: string | null;
  new_value: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface SupportTicketParticipant {
  id: string;
  ticket_id: string;
  user_id: string | null;
  email: string;
  name: string | null;
  role: ParticipantRole;
  added_by: string | null;
  created_at: string;
}

export interface SupportCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
  metadata: Record<string, unknown> | null;
  children?: SupportCategory[];
}

export type SortColumn = 'ticket_number' | 'subject' | 'status' | 'priority' | 'created_at' | 'assignee_name';
export type SortDirection = 'asc' | 'desc';

export interface TicketListParams {
  status?: TicketStatus | null;
  priority?: TicketPriority | null;
  category_id?: string | null;
  assignee_id?: string | null;
  search?: string | null;
  requester_email?: string | null;
  page?: number;
  page_size?: number;
  sort_by?: SortColumn;
  sort_dir?: SortDirection;
}

export interface TicketListResponse {
  tickets: SupportTicket[];
  total_count: number;
  page: number;
  page_size: number;
  total_pages: number;
}

export interface TicketStats {
  total_open: number;
  unassigned: number;
  by_status: Record<string, number>;
  by_priority: Record<string, number>;
}

export interface TicketDetailResponse {
  ticket: SupportTicket;
  messages: SupportTicketMessage[];
  events: SupportTicketEvent[];
  attachments: SupportTicketAttachment[];
  participants: SupportTicketParticipant[];
}

export interface CreateTicketParams {
  subject: string;
  description: string;
  priority: TicketPriority;
  ticket_type?: string | null;
  category_id?: string | null;
  subcategory_id?: string | null;
  requester_email: string;
  requester_name: string;
  source_channel?: SourceChannel;
  requester_phone?: string;
  preferred_contact?: PreferredContact;
}

export interface SupportResponseTemplate {
  id: string;
  name: string;
  body: string;
  category: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// --- Related Tickets types ---

export type TicketLinkType = 'related' | 'duplicate' | 'parent' | 'child';

export interface RelatedTicket {
  id: string;
  ticket_number: number;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
  link_source: 'auto' | 'manual';
  link_type?: TicketLinkType;
  link_id?: string;
}

export interface RelatedTicketsResponse {
  auto_related: RelatedTicket[];
  manual_links: RelatedTicket[];
}

export interface TicketLinkSearchResult {
  id: string;
  ticket_number: number;
  subject: string;
  status: string;
  requester_name: string;
}

// --- Requester Lookup types ---

export type PreferredContact = 'email' | 'phone' | 'either';

export interface RequesterSearchResult {
  user_id: string;
  email: string;
  name: string;
  phone: string | null;
  organization_id: string | null;
  organization_name: string | null;
  open_ticket_count: number;
}

export interface RecentTicket {
  id: string;
  ticket_number: number;
  subject: string;
  status: string;
  priority: string;
  created_at: string;
}

// Status transition map for UI validation
export const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  new: ['assigned', 'in_progress'],
  assigned: ['in_progress', 'pending'],
  in_progress: ['pending', 'resolved'],
  pending: ['in_progress'],
  resolved: ['in_progress', 'closed'],
  closed: ['in_progress'], // admin reopen only
  deleted: ['new'], // recovery: reopen as new
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  new: 'New',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  pending: 'Pending',
  resolved: 'Resolved',
  closed: 'Closed',
  deleted: 'Deleted',
};

export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

export const STATUS_COLORS: Record<TicketStatus, string> = {
  new: 'bg-blue-100 text-blue-800',
  assigned: 'bg-yellow-100 text-yellow-800',
  in_progress: 'bg-green-100 text-green-800',
  pending: 'bg-orange-100 text-orange-800',
  resolved: 'bg-purple-100 text-purple-800',
  closed: 'bg-gray-100 text-gray-800',
  deleted: 'bg-red-100 text-red-800',
};

export const PRIORITY_COLORS: Record<TicketPriority, string> = {
  low: 'bg-gray-100 text-gray-800',
  normal: 'bg-blue-100 text-blue-800',
  high: 'bg-orange-100 text-orange-800',
  urgent: 'bg-red-100 text-red-800',
};

// --- Saved View types ---

export interface SupportSavedView {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  is_shared: boolean;
  is_own: boolean;
  created_at: string;
}

// --- Timeline types ---

export type TimelineEntry =
  | { type: 'message'; data: SupportTicketMessage; timestamp: string }
  | { type: 'event'; data: SupportTicketEvent; timestamp: string };
