'use client';

/**
 * MessageList - Displays messages grouped by conversation threads
 *
 * Groups messages by thread_id (for texts) or subject (for emails)
 * Shows compact thread cards that open into a phone-style conversation modal
 *
 * Design based on desktop app's TransactionMessagesTab/MessageThreadCard
 */

import { useState, useMemo } from 'react';
import { EmptyMessages } from '@/components/ui/EmptyState';
import { ChevronRight, MapPin, Mic, Paperclip, Users, X } from 'lucide-react';

/** Message type values matching desktop app */
type MessageType = 'text' | 'voice_message' | 'location' | 'attachment_only' | 'system' | 'unknown';

interface Message {
  id: string;
  channel: string;
  direction: string;
  subject: string | null;
  body_text: string | null;
  sent_at: string;
  has_attachments: boolean;
  attachment_count: number;
  thread_id?: string | null;
  /** Message type: text, voice_message, location, attachment_only, system, unknown */
  message_type?: MessageType | string | null;
  participants?: {
    from?: string;
    to?: string | string[];
    cc?: string[];
    bcc?: string[];
    chat_members?: string[];
    // Resolved names from contact lookup
    from_name?: string;
    to_names?: Record<string, string>;
    chat_member_names?: Record<string, string>;
  } | null;
}

interface MessageListProps {
  messages: Message[];
}

type FilterType = 'all' | 'email' | 'text';

interface Thread {
  id: string;
  messages: Message[];
  channel: string;
  subject: string | null;
  firstDate: string;
  lastDate: string;
  participantDisplay: string;
  totalAttachments: number;
  /** Number of unique participants (excluding user) - used for group chat detection */
  uniqueParticipantCount: number;
  /** Primary contact name for 1-on-1 chats */
  primaryContactName: string | null;
  /** Primary phone number for display */
  primaryPhone: string | null;
}

/**
 * Normalize a participant identifier for consistent grouping
 */
function normalizeParticipant(participant: string): string {
  if (!participant) return '';
  const digits = participant.replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return participant.toLowerCase().trim();
}

/**
 * Generate a thread key for grouping messages
 */
function getThreadKey(msg: Message): string {
  // Use thread_id if available (for texts/iMessage)
  if (msg.thread_id) {
    return msg.thread_id;
  }

  // For emails, group by subject (normalized)
  if (msg.channel === 'email' && msg.subject) {
    // Remove Re: Fwd: etc. prefixes
    const normalizedSubject = msg.subject
      .replace(/^(re:|fwd?:|fw:)\s*/gi, '')
      .trim()
      .toLowerCase();
    return `email-${normalizedSubject}`;
  }

  // Fallback: group by participants
  if (msg.participants) {
    const participants = msg.participants;
    const allParticipants = new Set<string>();

    if (participants.from) {
      allParticipants.add(normalizeParticipant(participants.from));
    }
    if (participants.to) {
      const toList = Array.isArray(participants.to) ? participants.to : [participants.to];
      toList.forEach((p) => allParticipants.add(normalizeParticipant(p)));
    }

    if (allParticipants.size > 0) {
      return `participants-${Array.from(allParticipants).sort().join('|')}`;
    }
  }

  // Last resort: use message id
  return `msg-${msg.id}`;
}

/**
 * Participant info extracted from thread messages
 */
interface ParticipantInfo {
  /** Display string for participants */
  display: string;
  /** Number of unique participants (for group chat detection) */
  count: number;
  /** Primary contact name (resolved if available) */
  primaryName: string | null;
  /** Primary phone number */
  primaryPhone: string | null;
}

/**
 * Get all unique participants from thread messages
 * Returns both phone numbers and resolved names
 */
function getThreadParticipants(messages: Message[]): {
  phones: Set<string>;
  names: Map<string, string>; // phone -> name
} {
  const phones = new Set<string>();
  const names = new Map<string, string>();

  for (const msg of messages) {
    if (!msg.participants) continue;

    // Collect from chat_members (authoritative for group chats)
    if (msg.participants.chat_members && Array.isArray(msg.participants.chat_members)) {
      const memberNames = msg.participants.chat_member_names || {};
      msg.participants.chat_members.forEach((phone) => {
        if (phone && phone !== 'me' && phone !== 'unknown') {
          phones.add(phone);
          if (memberNames[phone]) {
            names.set(phone, memberNames[phone]);
          }
        }
      });
    }

    // Collect from from/to fields
    if (msg.direction === 'inbound' && msg.participants.from) {
      const from = msg.participants.from;
      if (from !== 'me' && from !== 'unknown') {
        phones.add(from);
        if (msg.participants.from_name) {
          names.set(from, msg.participants.from_name);
        }
      }
    }

    if (msg.direction === 'outbound' && msg.participants.to) {
      const toList = Array.isArray(msg.participants.to)
        ? msg.participants.to
        : [msg.participants.to];
      const toNames = msg.participants.to_names || {};
      toList.forEach((phone) => {
        if (phone && phone !== 'me' && phone !== 'unknown') {
          phones.add(phone);
          if (toNames[phone]) {
            names.set(phone, toNames[phone]);
          }
        }
      });
    }
  }

  return { phones, names };
}

/**
 * Extract participant info from thread messages
 * Properly counts unique participants for group chat detection
 */
function getParticipantInfo(messages: Message[]): ParticipantInfo {
  const { phones, names } = getThreadParticipants(messages);

  // Normalize phones and deduplicate by resolved name
  const normalizePhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : digits;
  };

  // Build set of unique resolved identities
  const uniqueIdentities = new Set<string>();
  const displayList: string[] = [];

  Array.from(phones).forEach((phone) => {
    // Get resolved name or use phone as identity
    const resolvedName = names.get(phone);
    const identity = resolvedName || normalizePhone(phone);

    if (!uniqueIdentities.has(identity)) {
      uniqueIdentities.add(identity);
      displayList.push(resolvedName || phone);
    }
  });

  // Get primary contact (first resolved name, or first phone)
  const primaryPhone = phones.size > 0 ? Array.from(phones)[0] : null;
  const primaryName = primaryPhone ? (names.get(primaryPhone) || null) : null;

  // Format display string
  let display: string;
  if (displayList.length === 0) {
    display = 'Unknown';
  } else if (displayList.length === 1) {
    display = displayList[0];
  } else if (displayList.length <= 3) {
    display = displayList.join(', ');
  } else {
    display = `${displayList.slice(0, 2).join(', ')} +${displayList.length - 2} more`;
  }

  return {
    display,
    count: uniqueIdentities.size,
    primaryName,
    primaryPhone,
  };
}

/**
 * Get initials for avatar display
 */
function getAvatarInitial(name: string): string {
  if (!name || name.trim().length === 0) return '#';
  // Check if it looks like a phone number
  if (/^[\d\s\-+()]+$/.test(name)) return '#';
  return name.trim().charAt(0).toUpperCase();
}

/**
 * Format date range for display
 */
function formatDateRange(firstDate: string, lastDate: string): string {
  const first = new Date(firstDate);
  const last = new Date(lastDate);
  const formatOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

  if (first.toDateString() === last.toDateString()) {
    return first.toLocaleDateString(undefined, formatOpts);
  }
  return `${first.toLocaleDateString(undefined, formatOpts)} - ${last.toLocaleDateString(undefined, formatOpts)}`;
}

/**
 * Group messages into threads
 */
function groupMessagesIntoThreads(messages: Message[]): Thread[] {
  const threadMap = new Map<string, Message[]>();

  // Group messages by thread key
  for (const msg of messages) {
    const key = getThreadKey(msg);
    const existing = threadMap.get(key) || [];
    existing.push(msg);
    threadMap.set(key, existing);
  }

  // Convert to Thread objects and sort messages within each thread
  const threads: Thread[] = Array.from(threadMap.entries()).map(([id, msgs]) => {
    // Sort by sent_at ascending (oldest first within thread)
    const sortedMsgs = msgs.sort(
      (a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime()
    );

    const firstMsg = sortedMsgs[0];
    const lastMsg = sortedMsgs[sortedMsgs.length - 1];

    // Get participant info with proper counting
    const participantInfo = getParticipantInfo(sortedMsgs);

    return {
      id,
      messages: sortedMsgs,
      channel: firstMsg.channel,
      subject: firstMsg.subject,
      firstDate: firstMsg.sent_at,
      lastDate: lastMsg.sent_at,
      participantDisplay: participantInfo.display,
      totalAttachments: sortedMsgs.reduce((sum, m) => sum + m.attachment_count, 0),
      uniqueParticipantCount: participantInfo.count,
      primaryContactName: participantInfo.primaryName,
      primaryPhone: participantInfo.primaryPhone,
    };
  });

  // Sort threads by most recent message (newest first)
  return threads.sort((a, b) => new Date(b.lastDate).getTime() - new Date(a.lastDate).getTime());
}

/**
 * Format timestamp for message display
 */
function formatMessageTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Get display info for special message types
 * @param messageType - The message type from the database
 * @returns Display configuration for the message type
 */
function getMessageTypeDisplay(messageType: string | null | undefined): {
  indicator: string | null;
  icon: 'mic' | 'map-pin' | 'paperclip' | null;
} {
  switch (messageType) {
    case 'voice_message':
      return { indicator: 'Voice Message', icon: 'mic' };
    case 'location':
      return { indicator: 'Location Shared', icon: 'map-pin' };
    case 'attachment_only':
      return { indicator: 'Media Attachment', icon: 'paperclip' };
    case 'system':
      return { indicator: 'System', icon: null };
    default:
      return { indicator: null, icon: null };
  }
}

/**
 * Icon component for message type indicators (lucide)
 */
function MessageTypeIcon({ icon, className }: { icon: 'mic' | 'map-pin' | 'paperclip'; className?: string }) {
  switch (icon) {
    case 'mic':
      return <Mic className={className} />;
    case 'map-pin':
      return <MapPin className={className} />;
    case 'paperclip':
      return <Paperclip className={className} />;
  }
}

/**
 * Phone-style conversation modal
 */
function ConversationModal({
  thread,
  onClose,
}: {
  thread: Thread;
  onClose: () => void;
}) {
  const isEmail = thread.channel === 'email';
  // Group chat = more than one unique participant (matching desktop logic)
  const isGroupChat = thread.uniqueParticipantCount > 1;

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-100 w-full max-w-md h-[600px] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`px-4 py-3 flex items-center gap-3 ${
          isEmail
            ? 'bg-gradient-to-r from-primary-500 to-primary-600'
            : 'bg-gradient-to-r from-green-500 to-teal-600'
        }`}>
          <button
            onClick={onClose}
            className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h4 className="text-white font-semibold truncate">
              {isGroupChat ? 'Group Chat' : (thread.primaryContactName || thread.primaryPhone || 'Unknown')}
            </h4>
            {isGroupChat ? (
              <p className="text-white/80 text-xs truncate">{thread.participantDisplay}</p>
            ) : thread.primaryContactName && thread.primaryPhone ? (
              <p className="text-white/80 text-xs truncate">{thread.primaryPhone}</p>
            ) : null}
            {thread.subject && (
              <p className="text-white/80 text-xs truncate">{thread.subject}</p>
            )}
            <p className={`text-xs ${isEmail ? 'text-primary-100' : 'text-green-100'}`}>
              {thread.messages.length} message{thread.messages.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        {/* Messages list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {thread.messages.map((msg) => {
            const isOutbound = msg.direction === 'outbound';
            const msgText = msg.body_text || '';
            const typeDisplay = getMessageTypeDisplay(msg.message_type);
            const isSpecialType = typeDisplay.indicator !== null;

            // System messages get special centered styling
            if (msg.message_type === 'system') {
              return (
                <div key={msg.id} className="flex justify-center">
                  <p className="text-xs text-gray-500 italic py-1 px-4">
                    {msgText || '[System message]'}
                  </p>
                </div>
              );
            }

            return (
              <div
                key={msg.id}
                className={`flex ${isOutbound ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2 ${
                    isOutbound
                      ? isEmail
                        ? 'bg-primary-500 text-white rounded-br-md'
                        : 'bg-green-500 text-white rounded-br-md'
                      : 'bg-white text-gray-900 rounded-bl-md shadow-sm'
                  }`}
                >
                  {/* Subject for emails (first message only or when subject changes) */}
                  {isEmail && msg.subject && (
                    <p className={`text-xs font-semibold mb-1 ${isOutbound ? 'text-white/80' : 'text-gray-500'}`}>
                      {msg.subject}
                    </p>
                  )}
                  {/* Special message type indicator */}
                  {isSpecialType && typeDisplay.icon && (
                    <div className={`flex items-center gap-1.5 mb-1 italic opacity-90 ${
                      isOutbound ? 'text-white/80' : 'text-gray-600'
                    }`}>
                      <MessageTypeIcon icon={typeDisplay.icon} className="w-4 h-4" />
                      <span className="font-medium text-sm">{typeDisplay.indicator}</span>
                    </div>
                  )}
                  <p className={`text-sm whitespace-pre-wrap break-words ${
                    isSpecialType ? 'italic opacity-75' : ''
                  }`}>
                    {msgText || (isSpecialType ? `[${typeDisplay.indicator}]` : '[No content]')}
                  </p>
                  <div className={`flex items-center gap-2 mt-1 ${isOutbound ? (isEmail ? 'text-primary-100' : 'text-green-100') : 'text-gray-400'}`}>
                    <span className="text-xs">{formatMessageTime(msg.sent_at)}</span>
                    {msg.has_attachments && (
                      <span className="flex items-center gap-1 text-xs">
                        <Paperclip className="w-3 h-3" />
                        {msg.attachment_count}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="bg-white border-t border-gray-200 px-4 py-3 flex justify-center">
          <button
            onClick={onClose}
            className="px-6 py-2 bg-gray-200 hover:bg-gray-300 rounded-full text-sm font-medium text-gray-700 transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Thread card component (similar to desktop MessageThreadCard)
 */
function ThreadCard({
  thread,
  onViewFull,
}: {
  thread: Thread;
  onViewFull: () => void;
}) {
  const isEmail = thread.channel === 'email';
  // Group chat = more than one unique participant (matching desktop logic)
  const isGroupChat = thread.uniqueParticipantCount > 1;
  // For 1-on-1 chats, use primary contact name or phone for avatar
  const displayName = isGroupChat
    ? thread.participantDisplay
    : (thread.primaryContactName || thread.primaryPhone || thread.participantDisplay);
  const avatarInitial = getAvatarInitial(displayName);

  return (
    <div className="bg-white rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors">
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* Avatar */}
          {isGroupChat ? (
            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 bg-purple-100">
              <Users className="w-5 h-5 text-purple-600" />
            </div>
          ) : (
            <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0 ${
              isEmail ? 'bg-gradient-to-br from-primary-500 to-primary-600' : 'bg-gradient-to-br from-green-500 to-teal-600'
            }`}>
              {avatarInitial}
            </div>
          )}

          {/* Contact info */}
          <div className="min-w-0 flex-1">
            {isGroupChat ? (
              // Group chat display
              <>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-gray-900 truncate">Group Chat</span>
                  <span className="flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                    {thread.messages.length}
                  </span>
                  {isEmail && (
                    <span className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-100 text-primary-700">
                      Email
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 truncate">{thread.participantDisplay}</p>
              </>
            ) : (
              // 1-on-1 chat display (like desktop: name on top, phone below)
              <>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-gray-900 truncate">
                    {thread.primaryContactName || thread.primaryPhone || 'Unknown'}
                  </span>
                  <span className="flex-shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                    {thread.messages.length}
                  </span>
                  {isEmail && (
                    <span className="flex-shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-primary-100 text-primary-700">
                      Email
                    </span>
                  )}
                </div>
                {thread.primaryContactName && thread.primaryPhone && (
                  <p className="text-xs text-gray-500 truncate">{thread.primaryPhone}</p>
                )}
              </>
            )}
            {thread.subject && (
              <p className="text-sm text-gray-600 truncate">{thread.subject}</p>
            )}
            <div className="flex items-center gap-3 text-xs text-gray-400 mt-0.5">
              <span>{formatDateRange(thread.firstDate, thread.lastDate)}</span>
              {thread.totalAttachments > 0 && (
                <span className="flex items-center gap-1">
                  <Paperclip className="w-3 h-3" />
                  {thread.totalAttachments}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* View Full button */}
        <button
          onClick={onViewFull}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary-600 hover:text-primary-700 transition-colors whitespace-nowrap flex-shrink-0 ml-4"
        >
          View Full
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function MessageList({ messages }: MessageListProps) {
  const [filter, setFilter] = useState<FilterType>('all');
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);

  // Filter messages first
  const filteredMessages = messages.filter((msg) => {
    if (filter === 'all') return true;
    if (filter === 'email') return msg.channel === 'email';
    if (filter === 'text') return msg.channel === 'sms' || msg.channel === 'imessage';
    return true;
  });

  // Group filtered messages into threads
  const threads = useMemo(() => groupMessagesIntoThreads(filteredMessages), [filteredMessages]);

  const emailCount = messages.filter((m) => m.channel === 'email').length;
  const textCount = messages.filter((m) => m.channel !== 'email').length;

  const tabs: { value: FilterType; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: messages.length },
    { value: 'email', label: 'Emails', count: emailCount },
    { value: 'text', label: 'Texts', count: textCount },
  ];

  return (
    <>
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg overflow-hidden">
        {/* Header with tabs */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Messages ({filteredMessages.length})</h2>
              <p className="text-sm text-gray-500">
                in {threads.length} conversation{threads.length !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex gap-2">
              {tabs.map(({ value, label, count }) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                    filter === value
                      ? 'bg-primary-600 text-white'
                      : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {label} ({count})
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Thread list */}
        <div className="max-h-[600px] overflow-y-auto p-4 space-y-3">
          {threads.length === 0 ? (
            <EmptyMessages />
          ) : (
            threads.map((thread) => (
              <ThreadCard
                key={thread.id}
                thread={thread}
                onViewFull={() => setSelectedThread(thread)}
              />
            ))
          )}
        </div>
      </div>

      {/* Conversation Modal */}
      {selectedThread && (
        <ConversationModal
          thread={selectedThread}
          onClose={() => setSelectedThread(null)}
        />
      )}
    </>
  );
}
