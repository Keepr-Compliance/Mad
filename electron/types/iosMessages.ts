/**
 * iOS Messages Database Types
 * Types for parsing sms.db from iOS backups
 */

/**
 * Individual message from iOS Messages database
 */
export interface iOSMessage {
  id: number;
  guid: string;
  text: string | null;
  /** Transcript of voice message audio (TASK-1798, populated when available) */
  audioTranscript?: string | null;
  handle: string; // Phone number or email
  isFromMe: boolean;
  date: Date;
  dateRead: Date | null;
  dateDelivered: Date | null;
  service: "iMessage" | "SMS";
  attachments: iOSAttachment[];
}

/**
 * Attachment reference from iOS Messages database
 */
export interface iOSAttachment {
  id: number;
  guid: string;
  filename: string;
  mimeType: string;
  transferName: string;
}

/**
 * Conversation (chat) from iOS Messages database
 */
export interface iOSConversation {
  chatId: number;
  chatIdentifier: string; // Group name or contact
  participants: string[];
  messages: iOSMessage[];
  lastMessage: Date;
  isGroupChat: boolean;
  /**
   * BACKLOG-3892 S1: the chat's newest `message.date` exactly as sms.db stores it
   * (seconds before iOS 11, nanoseconds after), as a decimal string — exact past
   * 2^53 and safe to serialize, unlike a BigInt. The parse floor compares this,
   * never `lastMessage` (which assumes nanoseconds). Set by getConversationsAsync.
   */
  lastDateRaw?: string | null;
  /** BACKLOG-3892 S1 (D5): the participants read failed, so `participants` is incomplete. */
  participantsReadFailed?: boolean;
}

/**
 * Raw message row from sms.db
 */
export interface RawMessageRow {
  ROWID: number;
  guid: string;
  text: string | null;
  attributedBody?: Buffer | null;
  audio_transcript?: string | null;
  handle_id: number;
  is_from_me: number;
  date: number;
  date_read: number | null;
  date_delivered: number | null;
  service: string;
}

/**
 * Raw attachment row from sms.db
 */
export interface RawAttachmentRow {
  ROWID: number;
  guid: string;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
}

/**
 * Raw chat row from sms.db
 */
export interface RawChatRow {
  ROWID: number;
  guid: string;
  chat_identifier: string;
  display_name: string | null;
}

/**
 * Raw handle row from sms.db
 */
export interface RawHandleRow {
  ROWID: number;
  id: string; // Phone number or email
  service: string;
}
