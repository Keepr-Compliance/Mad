'use client';

/**
 * ReplyComposer - Support Ticket Detail
 *
 * Collapsible composer with Reply / Internal Note toggle, file attachments,
 * and response template picker with dynamic variable substitution.
 * Minimized by default; text persists across collapse/expand.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Lock, MessageSquare, ChevronDown, ChevronUp, FileText, Search } from 'lucide-react';
import { addMessage, uploadAttachment, listTemplates } from '@/lib/support-queries';
import type { MessageType, SupportResponseTemplate } from '@/lib/support-types';
import { FileUpload } from './FileUpload';
import type { PendingFile } from './FileUpload';
import { useClickOutside } from '@/hooks/useClickOutside';

interface ReplyComposerProps {
  ticketId: string;
  onMessageSent: () => void;
  requesterName?: string;
  ticketNumber?: number;
  agentName?: string;
  ticketSubject?: string;
  requesterEmail?: string;
}

function applyTemplateVariables(
  body: string,
  vars: { customerName?: string; ticketNumber?: number; agentName?: string }
): string {
  let result = body;
  if (vars.customerName) result = result.replace(/\{\{customer_name\}\}/gi, vars.customerName);
  if (vars.ticketNumber) result = result.replace(/\{\{ticket_number\}\}/gi, String(vars.ticketNumber));
  if (vars.agentName) result = result.replace(/\{\{agent_name\}\}/gi, vars.agentName);
  return result;
}

function TemplatePicker({
  onSelect,
  requesterName,
  ticketNumber,
  agentName,
}: {
  onSelect: (body: string) => void;
  requesterName?: string;
  ticketNumber?: number;
  agentName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<SupportResponseTemplate[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && templates.length === 0) {
      setLoading(true);
      listTemplates()
        .then(setTemplates)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [open, templates.length]);

  const closeDropdown = useCallback(() => setOpen(false), []);
  useClickOutside(ref, closeDropdown, open);

  const filtered = templates.filter(
    (t) =>
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      (t.category && t.category.toLowerCase().includes(search.toLowerCase()))
  );

  // Group by category
  const grouped = new Map<string, SupportResponseTemplate[]>();
  for (const t of filtered) {
    const cat = t.category || 'General';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(t);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
        title="Insert template"
      >
        <FileText className="h-3.5 w-3.5" />
        Templates
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-72 bg-white rounded-lg border border-gray-200 shadow-lg z-50">
          {/* Search */}
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search templates..."
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
                autoFocus
              />
            </div>
          </div>

          {/* List */}
          <div className="max-h-60 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-center text-xs text-gray-400">Loading...</div>
            ) : filtered.length === 0 ? (
              <div className="p-4 text-center text-xs text-gray-400">
                {templates.length === 0 ? 'No templates yet' : 'No matches'}
              </div>
            ) : (
              Array.from(grouped.entries()).map(([category, items]) => (
                <div key={category}>
                  <div className="px-3 py-1.5 text-xs font-medium text-gray-400 uppercase tracking-wider bg-gray-50">
                    {category}
                  </div>
                  {items.map((template) => (
                    <button
                      key={template.id}
                      onClick={() => {
                        const filled = applyTemplateVariables(template.body, {
                          customerName: requesterName,
                          ticketNumber,
                          agentName,
                        });
                        onSelect(filled);
                        setOpen(false);
                        setSearch('');
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-primary-50 transition-colors"
                    >
                      <div className="text-sm font-medium text-gray-900">{template.name}</div>
                      <div className="text-xs text-gray-400 truncate mt-0.5">{template.body}</div>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ReplyComposer({ ticketId, onMessageSent, requesterName, ticketNumber, agentName, ticketSubject, requesterEmail }: ReplyComposerProps) {
  const [body, setBody] = useState('');
  const [messageType, setMessageType] = useState<MessageType>('internal_note');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const isNote = messageType === 'internal_note';
  const validFiles = files.filter((f) => !f.error);
  const hasContent = body.trim().length > 0 || validFiles.length > 0;

  async function handleSend() {
    if (!body.trim() && validFiles.length === 0) return;

    setSending(true);
    setError(null);
    setUploadProgress(null);

    try {
      const ticketMeta = ticketSubject && ticketNumber && requesterEmail
        ? { subject: ticketSubject, ticket_number: ticketNumber, requester_email: requesterEmail }
        : undefined;
      const result = await addMessage(ticketId, body.trim(), messageType, ticketMeta);
      const messageId = result.id;

      if (validFiles.length > 0) {
        for (let i = 0; i < validFiles.length; i++) {
          setUploadProgress(`Uploading ${i + 1}/${validFiles.length}...`);
          await uploadAttachment(ticketId, validFiles[i].file, messageId);
        }
      }

      setBody('');
      setFiles([]);
      setUploadProgress(null);
      setExpanded(false);
      onMessageSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
      setUploadProgress(null);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      handleSend();
    }
  }

  // Minimized state
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className={`w-full rounded-lg border-2 px-4 py-3 flex items-center justify-between transition-colors ${
          isNote
            ? 'border-amber-300 bg-amber-50 hover:bg-amber-100'
            : 'border-gray-200 bg-white hover:bg-gray-50'
        }`}
      >
        <div className="flex items-center gap-2 text-sm text-gray-500">
          {isNote ? <Lock className="h-3.5 w-3.5 text-amber-600" /> : <MessageSquare className="h-3.5 w-3.5" />}
          <span>
            {hasContent
              ? body.trim().substring(0, 60) + (body.trim().length > 60 ? '...' : '')
              : 'Click to respond...'}
          </span>
        </div>
        <ChevronDown className="h-4 w-4 text-gray-400" />
      </button>
    );
  }

  // Expanded state
  return (
    <div
      className={`rounded-lg border-2 ${
        isNote ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white'
      }`}
    >
      {/* Header: Toggle buttons + collapse */}
      <div className="flex items-center justify-between border-b border-gray-200 px-1 pt-1">
        <div className="flex">
          <button
            type="button"
            onClick={() => setMessageType('reply')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ${
              !isNote
                ? 'bg-white text-primary-700 border-b-2 border-primary-500'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Reply
          </button>
          <button
            type="button"
            onClick={() => setMessageType('internal_note')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-t-md transition-colors ${
              isNote
                ? 'bg-amber-50 text-amber-700 border-b-2 border-amber-500'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Lock className="h-3.5 w-3.5" />
            Internal Note
          </button>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors mr-1"
          title="Minimize"
        >
          <ChevronUp className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="p-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isNote ? 'Add an internal note (not visible to customer)...' : 'Type your reply...'}
          rows={5}
          className={`w-full border-0 resize-y min-h-[120px] max-h-[400px] overflow-y-auto text-sm text-gray-900 focus:outline-none focus:ring-0 ${
            isNote ? 'bg-amber-50 placeholder-amber-400' : 'bg-white placeholder-gray-400'
          }`}
          autoFocus
        />

        {/* File Upload */}
        <div className="mb-2">
          <FileUpload files={files} onFilesChange={setFiles} disabled={sending} />
        </div>

        {error && <div className="mb-2 text-sm text-red-600">{error}</div>}

        {uploadProgress && <div className="mb-2 text-sm text-blue-600">{uploadProgress}</div>}

        {/* Actions */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TemplatePicker
              onSelect={(text) => setBody(text)}
              requesterName={requesterName}
              ticketNumber={ticketNumber}
              agentName={agentName}
            />
            <span className="text-xs text-gray-400">
              {isNote ? 'Only visible to agents' : 'Visible to customer'}
              {' | Ctrl+Enter to send'}
            </span>
          </div>
          <button
            onClick={handleSend}
            disabled={(!body.trim() && validFiles.length === 0) || sending}
            className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isNote
                ? 'bg-amber-600 hover:bg-amber-700'
                : 'bg-primary-600 hover:bg-primary-700'
            }`}
          >
            <Send className="h-3.5 w-3.5" />
            {sending ? (uploadProgress || 'Sending...') : isNote ? 'Add Note' : 'Send Reply'}
          </button>
        </div>
      </div>
    </div>
  );
}
