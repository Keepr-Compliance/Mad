'use client';

/**
 * Support Settings - Response Templates Management
 *
 * Supervisors can create, edit, and delete response templates.
 * Templates support dynamic variables: {{customer_name}}, {{ticket_number}}, {{agent_name}}.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, Pencil, Trash2, FileText, ToggleLeft, ToggleRight } from 'lucide-react';
import { listAllTemplates, createTemplate, updateTemplate, deleteTemplate } from '@/lib/support-queries';
import type { SupportResponseTemplate } from '@/lib/support-types';

interface TemplateFormData {
  name: string;
  body: string;
  category: string;
}

const EMPTY_FORM: TemplateFormData = { name: '', body: '', category: '' };

const VARIABLE_CHIPS = [
  { label: 'Customer Name', value: '{{customer_name}}' },
  { label: 'Ticket Number', value: '{{ticket_number}}' },
  { label: 'Agent Name', value: '{{agent_name}}' },
];

export default function SupportSettingsPage() {
  const [templates, setTemplates] = useState<SupportResponseTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TemplateFormData>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadTemplates = useCallback(async () => {
    try {
      const data = await listAllTemplates();
      setTemplates(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  function handleNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function handleEdit(template: SupportResponseTemplate) {
    setEditingId(template.id);
    setForm({ name: template.name, body: template.body, category: template.category || '' });
    setShowForm(true);
  }

  function handleCancel() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.body.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await updateTemplate(editingId, form.name.trim(), form.body.trim(), form.category.trim() || undefined);
      } else {
        await createTemplate(form.name.trim(), form.body.trim(), form.category.trim() || undefined);
      }
      handleCancel();
      loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(template: SupportResponseTemplate) {
    try {
      await updateTemplate(template.id, template.name, template.body, template.category || undefined, !template.is_active);
      loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update template');
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteTemplate(id);
      setDeleteConfirm(null);
      loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete template');
    }
  }

  function insertVariable(variable: string) {
    const textarea = textareaRef.current;
    const cursorPos = textarea?.selectionStart ?? form.body.length;
    const before = form.body.slice(0, cursorPos);
    const after = form.body.slice(cursorPos);
    const newBody = before + variable + after;
    setForm((prev) => ({ ...prev, body: newBody }));

    // Refocus and place cursor after inserted variable
    requestAnimationFrame(() => {
      if (textarea) {
        textarea.focus();
        const newPos = cursorPos + variable.length;
        textarea.setSelectionRange(newPos, newPos);
      }
    });
  }

  // Group templates by category
  const grouped = new Map<string, SupportResponseTemplate[]>();
  for (const t of templates) {
    const cat = t.category || 'General';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(t);
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <Link
          href="/dashboard/support"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-3"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Support Queue
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Support Settings</h1>
            <p className="text-sm text-gray-500 mt-1">Manage response templates for your support team</p>
          </div>
          {!showForm && (
            <button
              onClick={handleNew}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-md transition-colors"
            >
              <Plus className="h-4 w-4" />
              New Template
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">
            dismiss
          </button>
        </div>
      )}

      {/* Create/Edit Form */}
      {showForm && (
        <div className="mb-6 bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">
            {editingId ? 'Edit Template' : 'New Template'}
          </h2>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Template Name</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Welcome Response"
                  className="w-full px-3 py-2 text-sm text-gray-900 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Category (optional)</label>
                <input
                  type="text"
                  value={form.category}
                  onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}
                  placeholder="e.g. Onboarding, Billing, General"
                  className="w-full px-3 py-2 text-sm text-gray-900 border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Template Body</label>
              <textarea
                ref={textareaRef}
                value={form.body}
                onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
                placeholder="Hi {{customer_name}}, thank you for reaching out..."
                rows={6}
                className="w-full px-3 py-2 text-sm text-gray-900 bg-white border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-primary-400 resize-none"
              />
              <div className="mt-2 flex items-center gap-2">
                <span className="text-xs text-gray-400">Insert variable:</span>
                {VARIABLE_CHIPS.map((v) => (
                  <button
                    key={v.value}
                    type="button"
                    onClick={() => insertVariable(v.value)}
                    className="inline-flex items-center px-2 py-0.5 text-xs bg-primary-50 text-primary-700 border border-primary-200 rounded-full hover:bg-primary-100 transition-colors"
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleSave}
                disabled={!form.name.trim() || !form.body.trim() || saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : editingId ? 'Update Template' : 'Create Template'}
              </button>
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Template List */}
      {loading ? (
        <div className="animate-pulse space-y-3">
          <div className="h-16 bg-gray-200 rounded" />
          <div className="h-16 bg-gray-200 rounded" />
          <div className="h-16 bg-gray-200 rounded" />
        </div>
      ) : templates.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
          <FileText className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">No response templates yet</p>
          <p className="text-xs text-gray-400 mt-1">
            Create templates to help your team respond faster with consistent messaging.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([category, items]) => (
            <div key={category}>
              <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">{category}</h3>
              <div className="space-y-2">
                {items.map((template) => (
                  <div
                    key={template.id}
                    className={`bg-white rounded-lg border p-4 ${
                      template.is_active ? 'border-gray-200' : 'border-gray-100 opacity-60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">{template.name}</span>
                          {!template.is_active && (
                            <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">Inactive</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-1 line-clamp-2 whitespace-pre-wrap">{template.body}</p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleToggleActive(template)}
                          className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
                          title={template.is_active ? 'Deactivate' : 'Activate'}
                        >
                          {template.is_active ? (
                            <ToggleRight className="h-4 w-4 text-green-600" />
                          ) : (
                            <ToggleLeft className="h-4 w-4" />
                          )}
                        </button>
                        <button
                          onClick={() => handleEdit(template)}
                          className="p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {deleteConfirm === template.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(template.id)}
                              className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="px-2 py-1 text-xs text-gray-500 hover:bg-gray-50 rounded transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(template.id)}
                            className="p-1.5 text-gray-400 hover:text-red-600 transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
