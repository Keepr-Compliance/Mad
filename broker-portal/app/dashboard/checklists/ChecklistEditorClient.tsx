'use client';

/**
 * Checklist template editor — BACKLOG-3474.
 *
 * Layout transcribed from the signed-off mock (BACKLOG-3480): a details card
 * (name, description) and an items card (grip, title + description, Required
 * switch, expected document type, remove), with "Unsaved changes", Cancel and
 * Save changes in the header and the items card footer.
 *
 * - Reorder by dragging the grip, or by focusing it and pressing Up / Down.
 * - Save changes arms only when saving would write something different
 *   (order included) — see isDirty() in lib/checklists/editorState.ts.
 * - One save = one server action = one database call. The template's
 *   updated_at travels as the text the page read and comes back as the text
 *   the save returned; the next save sends that. It never passes through a
 *   JS Date.
 * - After a save of an existing template the page is refreshed; the server
 *   page keys this component on updated_at, so it re-mounts with the stored
 *   rows (and the ids of items added in this session).
 */

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  ConfirmationDialog,
  Input,
  Label,
  Select,
  Textarea,
  FieldHelp,
} from '@keepr/design-system';
import { saveChecklistTemplate } from '@/lib/actions/checklists';
import {
  ANY_DOCUMENT_TYPE_LABEL,
  CHECKLIST_DOCUMENT_TYPES,
  CHECKLIST_DOCUMENT_TYPE_LABELS,
  type ChecklistDocumentType,
} from '@/lib/checklists/documentTypes';
import {
  addItem,
  emptyEditor,
  fromTemplate,
  hasErrors,
  isDirty,
  moveItem,
  newItem,
  removeItem,
  toSavePayload,
  updateItem,
  validateSavePayload,
  type EditorState,
  type TemplateItemRow,
} from '@/lib/checklists/editorState';

export interface ChecklistEditorClientProps {
  /** null for a new template. */
  templateId: string | null;
  /** updated_at text as read; null for a new template. */
  updatedAt: string | null;
  archived: boolean;
  template: { name: string; description: string | null } | null;
  items: TemplateItemRow[];
}

const LIST_PATH = '/dashboard/checklists';

function initialState(template: ChecklistEditorClientProps['template'], items: TemplateItemRow[]): EditorState {
  if (template) return fromTemplate(template, items);
  return { ...emptyEditor(), items: [newItem('new-0')] };
}

function DirtyMarker() {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      Unsaved changes
    </span>
  );
}

export default function ChecklistEditorClient({
  templateId,
  updatedAt,
  archived,
  template,
  items: itemRows,
}: ChecklistEditorClientProps) {
  const router = useRouter();
  const [initial, setInitial] = useState<EditorState>(() => initialState(template, itemRows));
  const [state, setState] = useState<EditorState>(initial);
  const [token, setToken] = useState<string | null>(updatedAt);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'saved'; text: string } | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const keySeq = useRef(1);
  const focusKey = useRef<string | null>(null);
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());

  const dirty = isDirty(initial, state);
  const payload = useMemo(() => toSavePayload(state), [state]);
  const errors = useMemo(() => validateSavePayload(payload), [payload]);
  const requiredCount = state.items.filter((i) => i.isRequired).length;
  const summary = `${state.items.length} ${state.items.length === 1 ? 'item' : 'items'} · ${requiredCount} required`;

  // Warn before a reload or tab close drops unsaved work.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Keep keyboard focus on the grip of the item that just moved.
  useEffect(() => {
    if (focusKey.current) {
      gripRefs.current.get(focusKey.current)?.focus();
      focusKey.current = null;
    }
  }, [state.items]);

  function edit(next: EditorState) {
    setState(next);
    setMessage(null);
  }

  function move(from: number, to: number, key?: string) {
    if (key) focusKey.current = key;
    edit(moveItem(state, from, to));
  }

  function onGripKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number, key: string) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    move(index, e.key === 'ArrowUp' ? index - 1 : index + 1, key);
  }

  function onDrop(e: DragEvent<HTMLTableRowElement>, index: number) {
    e.preventDefault();
    if (dragIndex !== null) move(dragIndex, index);
    setDragIndex(null);
    setOverIndex(null);
  }

  async function save() {
    if (saving || !dirty) return;
    if (hasErrors(errors)) {
      setShowErrors(true);
      setMessage({ kind: 'error', text: 'Fix the highlighted fields, then save again.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await saveChecklistTemplate({ templateId, expectedUpdatedAt: token, payload });
      if (!result.ok) {
        setMessage({ kind: 'error', text: result.message });
        return;
      }
      if (templateId === null) {
        setInitial(state);
        router.replace(`${LIST_PATH}/${result.id}`);
        return;
      }
      setToken(result.updatedAt);
      setInitial(state);
      setShowErrors(false);
      setMessage({ kind: 'saved', text: 'Saved.' });
      router.refresh();
    } catch {
      setMessage({ kind: 'error', text: 'The template could not be saved. Try again.' });
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty) setConfirmLeave(true);
    else router.push(LIST_PATH);
  }

  const saveDisabled = !dirty || saving;
  const title = state.name.trim() || (templateId === null ? 'New template' : 'Untitled template');

  const actions = (
    <>
      {dirty && <DirtyMarker />}
      <Button variant="secondary" onClick={cancel} disabled={saving}>
        Cancel
      </Button>
      <Button onClick={save} disabled={saveDisabled}>
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </>
  );

  return (
    <div className="space-y-6">
      {/* PageHeader does not wrap; at phone width the actions drop below the title (mock deviation, noted there). */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 break-words">{title}</h1>
          <p className="mt-1 text-sm text-gray-500">
            Checklist template · {state.items.length} {state.items.length === 1 ? 'item' : 'items'}, {requiredCount} required
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">{actions}</div>
      </div>

      {archived && (
        <p className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
          This template is archived. Agents do not see it until you restore it from the list.
        </p>
      )}

      {message && (
        <p
          role={message.kind === 'error' ? 'alert' : 'status'}
          className={`text-sm ${message.kind === 'error' ? 'text-red-600' : 'text-green-700'}`}
        >
          {message.text}
        </p>
      )}

      <Card padding="none">
        <CardHeader>
          <div>
            <CardTitle>Template details</CardTitle>
            <CardDescription className="mt-1">The name agents see when this checklist is applied to a transaction.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-md">
            <Label htmlFor="checklist-name">Name</Label>
            <Input
              id="checklist-name"
              value={state.name}
              onChange={(e) => edit({ ...state, name: e.target.value })}
              aria-invalid={showErrors && Boolean(errors.name)}
            />
            {showErrors && errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
          </div>
          <div className="max-w-2xl">
            <Label htmlFor="checklist-description">Description</Label>
            <Textarea
              id="checklist-description"
              rows={2}
              value={state.description}
              onChange={(e) => edit({ ...state, description: e.target.value })}
            />
            {showErrors && errors.description ? (
              <p className="mt-1 text-xs text-red-600">{errors.description}</p>
            ) : (
              <FieldHelp>Optional. Shown in the template list, not to agents.</FieldHelp>
            )}
          </div>
        </CardContent>
      </Card>

      <Card padding="none">
        <CardHeader>
          <div>
            <CardTitle>Items</CardTitle>
            <CardDescription className="mt-1">Drag to reorder. Required items are the ones counted before a submission.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-hidden rounded-lg border border-gray-200 md:overflow-x-auto">
            <table className="block min-w-full bg-white md:table">
              <thead className="hidden bg-gray-50 md:table-header-group">
                <tr>
                  <th scope="col" className="w-10 px-4 py-2">
                    <span className="sr-only">Reorder</span>
                  </th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Item
                  </th>
                  <th scope="col" className="w-36 px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Required
                  </th>
                  <th scope="col" className="w-56 px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Expected document type
                  </th>
                  <th scope="col" className="w-12 px-4 py-2">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody className="block md:table-row-group">
                {state.items.map((item, index) => {
                  const label = item.title.trim() || `item ${index + 1}`;
                  const itemError = showErrors ? errors.item[index] : undefined;
                  return (
                    <tr
                      key={item.key}
                      data-testid="checklist-item-row"
                      draggable={dragIndex === index}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        setDragIndex(index);
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setOverIndex(index);
                      }}
                      onDrop={(e) => onDrop(e, index)}
                      onDragEnd={() => {
                        setDragIndex(null);
                        setOverIndex(null);
                      }}
                      className={`relative block border-t border-gray-200 py-3 pl-10 pr-12 first:border-t-0 md:table-row md:p-0 md:first:border-t ${
                        dragIndex === index ? 'opacity-40' : ''
                      } ${overIndex === index && dragIndex !== index ? 'shadow-[inset_0_2px_0_0_#0ea5e9]' : ''}`}
                    >
                      <td className="absolute left-1 top-3 md:static md:px-4 md:pt-3.5 md:align-top">
                        <button
                          type="button"
                          ref={(el) => {
                            if (el) gripRefs.current.set(item.key, el);
                            else gripRefs.current.delete(item.key);
                          }}
                          className="inline-flex cursor-grab rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-primary-500"
                          aria-label={`Reorder ${label}. Use the up and down arrow keys.`}
                          title="Drag to reorder, or use the arrow keys"
                          onMouseDown={() => setDragIndex(index)}
                          onMouseUp={() => setDragIndex(null)}
                          onKeyDown={(e) => onGripKeyDown(e, index, item.key)}
                        >
                          <GripVertical className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </td>
                      <td className="block md:table-cell md:px-4 md:py-2 md:align-top">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500 md:hidden">
                          Item
                        </span>
                        <Input
                          value={item.title}
                          placeholder="What the agent ticks off"
                          aria-label="Item title"
                          aria-invalid={Boolean(itemError)}
                          onChange={(e) => edit(updateItem(state, item.key, { title: e.target.value }))}
                        />
                        <Input
                          className="mt-1 text-xs text-gray-500"
                          value={item.description}
                          placeholder="Optional description"
                          aria-label="Item description (optional)"
                          onChange={(e) => edit(updateItem(state, item.key, { description: e.target.value }))}
                        />
                        {itemError && <p className="mt-1 text-xs text-red-600">{itemError}</p>}
                      </td>
                      <td className="mt-2.5 flex items-center md:mt-0 md:table-cell md:whitespace-nowrap md:px-4 md:pt-3 md:align-top">
                        <span className="mr-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500 md:hidden">
                          Required
                        </span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={item.isRequired}
                          aria-label={`Required: ${label}`}
                          onClick={() => edit(updateItem(state, item.key, { isRequired: !item.isRequired }))}
                          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent align-middle transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                            item.isRequired ? 'bg-primary-600' : 'bg-gray-200'
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              item.isRequired ? 'translate-x-5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                        <span className="ml-2 text-xs text-gray-500">{item.isRequired ? 'Required' : 'Optional'}</span>
                      </td>
                      <td className="mt-2.5 block md:mt-0 md:table-cell md:px-4 md:py-2 md:align-top">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-gray-500 md:hidden">
                          Expected document type
                        </span>
                        <Select
                          value={item.documentType}
                          aria-label={`Expected document type for ${label}`}
                          onChange={(e) =>
                            edit(updateItem(state, item.key, { documentType: e.target.value as ChecklistDocumentType | '' }))
                          }
                        >
                          <option value="">{ANY_DOCUMENT_TYPE_LABEL}</option>
                          {CHECKLIST_DOCUMENT_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {CHECKLIST_DOCUMENT_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="absolute right-2 top-2.5 md:static md:px-4 md:pt-2.5 md:text-center md:align-top">
                        <button
                          type="button"
                          className="inline-flex rounded-md p-1 text-red-500 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
                          aria-label={`Remove ${label}`}
                          title="Remove item"
                          onClick={() => edit(removeItem(state, item.key))}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="border-t border-gray-200 bg-gray-50 px-4 py-2.5">
              <Button
                variant="secondary"
                size="xs"
                onClick={() => edit(addItem(state, `new-${keySeq.current++}`))}
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                Add item
              </Button>
            </div>
          </div>
          {showErrors && errors.items ? (
            <p className="mt-1 text-xs text-red-600">{errors.items}</p>
          ) : (
            <FieldHelp>{summary}</FieldHelp>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-end gap-3">{actions}</CardFooter>
      </Card>

      <ConfirmationDialog
        open={confirmLeave}
        title="Discard unsaved changes?"
        description="Your changes to this template have not been saved."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => {
          setConfirmLeave(false);
          setInitial(state);
          router.push(LIST_PATH);
        }}
      />
    </div>
  );
}
