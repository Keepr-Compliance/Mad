'use client';

/**
 * MessageViewerModal Component
 *
 * Full message viewer modal for emails and text messages.
 * Part of BACKLOG-401.
 */

import { formatDate } from '@/lib/utils';
import { ArrowDown, ArrowUp, Mail, MessageSquare, Paperclip, X } from 'lucide-react';

interface Message {
  id: string;
  channel: string;
  direction: string;
  subject: string | null;
  body_text: string | null;
  sent_at: string;
  has_attachments: boolean;
  attachment_count: number;
}

interface MessageViewerModalProps {
  message: Message | null;
  open: boolean;
  onClose: () => void;
}

export function MessageViewerModal({ message, open, onClose }: MessageViewerModalProps) {
  if (!message || !open) return null;

  const isEmail = message.channel === 'email';

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between">
          <div className="flex items-center gap-3">
            {/* Icon */}
            <div
              className={`p-2 rounded-lg ${
                isEmail ? 'bg-primary-100 text-primary-600' : 'bg-green-100 text-green-600'
              }`}
            >
              {isEmail ? (
                <Mail className="w-5 h-5" />
              ) : (
                <MessageSquare className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">
                {isEmail ? message.subject || 'No Subject' : 'Text Message'}
              </h2>
              <p className="text-sm text-gray-500">{formatDate(message.sent_at)}</p>
            </div>
          </div>
          {/* Close button */}
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 rounded"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Direction indicator */}
        <div className="px-6 py-3 bg-gray-50 border-b border-gray-200 text-sm">
          <div className="flex items-center gap-2">
            {message.direction === 'outbound' ? (
              <>
                <ArrowUp className="w-4 h-4 text-gray-400" />
                <span className="text-gray-600">Sent</span>
              </>
            ) : (
              <>
                <ArrowDown className="w-4 h-4 text-gray-400" />
                <span className="text-gray-600">Received</span>
              </>
            )}
            <span className="text-gray-400 uppercase text-xs">{message.channel}</span>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <p className="text-gray-800 whitespace-pre-wrap text-sm leading-relaxed">
            {message.body_text || 'No content'}
          </p>
        </div>

        {/* Attachments indicator */}
        {message.has_attachments && (
          <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 text-sm text-gray-500 flex items-center gap-2">
            <Paperclip className="w-4 h-4" />
            {message.attachment_count} attachment{message.attachment_count !== 1 ? 's' : ''} (view in
            Attachments section)
          </div>
        )}
      </div>
    </div>
  );
}

export default MessageViewerModal;
