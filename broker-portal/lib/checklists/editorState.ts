/**
 * Checklist template editor state — BACKLOG-3474.
 *
 * Pure functions, shared by the editor (client) and saveChecklistTemplate
 * (server). The server re-validates with validateSavePayload() before it calls
 * the database; the database enforces the same bounds again (table CHECKs and
 * save_checklist_template's 1..200 item cap).
 *
 * LENGTHS ARE UTF-16 UNITS OF THE TRIMMED STRING. Two readers bound these
 * fields:
 *   - the database CHECKs count code points after btrim (char_length(btrim(x)));
 *   - the desktop app validates what it downloads with zod `.max(n)`, which
 *     counts UTF-16 units (electron/schemas/checklist.ts). A title the desktop
 *     rejects makes it show the whole template with NO items.
 * A UTF-16 count is never smaller than a code-point count, so bounding the
 * UTF-16 length satisfies both. The save stores trimmed values, so the length
 * checked here is the length stored.
 */

import {
  isChecklistDocumentType,
  type ChecklistDocumentType,
} from '@/lib/checklists/documentTypes';

export const TEMPLATE_NAME_MAX = 200;
export const ITEM_TITLE_MAX = 300;
export const DESCRIPTION_MAX = 2000;
export const ITEMS_MIN = 1;
export const ITEMS_MAX = 200;

export interface EditorItem {
  /** Stable React key; never sent. */
  key: string;
  /** checklist_template_items.id, or null for an item added in this session. */
  id: string | null;
  title: string;
  description: string;
  isRequired: boolean;
  /** '' = any document type (NULL in the database). */
  documentType: ChecklistDocumentType | '';
}

export interface EditorState {
  name: string;
  description: string;
  items: EditorItem[];
}

/** The row shape the editor page reads (PostgREST embed). */
export interface TemplateItemRow {
  id: string;
  title: string;
  description: string | null;
  is_required: boolean;
  expected_document_type: string | null;
  sort_order: number;
}

export interface SaveItem {
  id?: string;
  title: string;
  description: string | null;
  is_required: boolean;
  expected_document_type: ChecklistDocumentType | null;
}

export interface SavePayload {
  name: string;
  description: string | null;
  items: SaveItem[];
}

export function emptyEditor(): EditorState {
  return { name: '', description: '', items: [] };
}

export function newItem(key: string): EditorItem {
  return { key, id: null, title: '', description: '', isRequired: false, documentType: '' };
}

/** Editor state from a stored template; items in sort_order. */
export function fromTemplate(
  template: { name: string; description: string | null },
  items: TemplateItemRow[]
): EditorState {
  return {
    name: template.name,
    description: template.description ?? '',
    items: [...items]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((row) => ({
        key: row.id,
        id: row.id,
        title: row.title,
        description: row.description ?? '',
        isRequired: row.is_required,
        documentType: isChecklistDocumentType(row.expected_document_type) ? row.expected_document_type : '',
      })),
  };
}

export function addItem(state: EditorState, key: string): EditorState {
  return { ...state, items: [...state.items, newItem(key)] };
}

export function removeItem(state: EditorState, key: string): EditorState {
  return { ...state, items: state.items.filter((i) => i.key !== key) };
}

export function updateItem(
  state: EditorState,
  key: string,
  patch: Partial<Omit<EditorItem, 'key' | 'id'>>
): EditorState {
  return { ...state, items: state.items.map((i) => (i.key === key ? { ...i, ...patch } : i)) };
}

/** Move the item at `from` to index `to` (both clamped to the list). */
export function moveItem(state: EditorState, from: number, to: number): EditorState {
  const n = state.items.length;
  if (from < 0 || from >= n) return state;
  const target = Math.max(0, Math.min(n - 1, to));
  if (target === from) return state;
  const items = [...state.items];
  const [moved] = items.splice(from, 1);
  items.splice(target, 0, moved);
  return { ...state, items };
}

const blankToNull = (s: string): string | null => {
  const t = s.trim();
  return t === '' ? null : t;
};

/** What the save sends: trimmed, in display order, the order IS the item order. */
export function toSavePayload(state: EditorState): SavePayload {
  return {
    name: state.name.trim(),
    description: blankToNull(state.description),
    items: state.items.map((i) => ({
      ...(i.id ? { id: i.id } : {}),
      title: i.title.trim(),
      description: blankToNull(i.description),
      is_required: i.isRequired,
      expected_document_type: i.documentType === '' ? null : i.documentType,
    })),
  };
}

/** True when saving `current` would write something `initial` does not hold. Order counts. */
export function isDirty(initial: EditorState, current: EditorState): boolean {
  return JSON.stringify(toSavePayload(initial)) !== JSON.stringify(toSavePayload(current));
}

export interface PayloadErrors {
  name?: string;
  description?: string;
  /** About the list as a whole (count). */
  items?: string;
  /** Per item, by index in the payload. */
  item: Record<number, string>;
}

export function hasErrors(e: PayloadErrors): boolean {
  return Boolean(e.name || e.description || e.items || Object.keys(e.item).length > 0);
}

/**
 * Validate a payload. Accepts `unknown` because the server action receives
 * whatever the browser sent; a malformed shape is reported, never thrown.
 */
export function validateSavePayload(payload: unknown): PayloadErrors {
  const errors: PayloadErrors = { item: {} };
  const p = payload as Partial<SavePayload> | null;
  if (!p || typeof p !== 'object') {
    errors.name = 'The template could not be read.';
    return errors;
  }

  if (typeof p.name !== 'string' || p.name.trim() === '') {
    errors.name = 'Give the template a name.';
  } else if (p.name.trim().length > TEMPLATE_NAME_MAX) {
    errors.name = `Keep the name to ${TEMPLATE_NAME_MAX} characters.`;
  }

  if (p.description !== null && p.description !== undefined) {
    if (typeof p.description !== 'string') errors.description = 'The description could not be read.';
    else if (p.description.trim().length > DESCRIPTION_MAX) {
      errors.description = `Keep the description to ${DESCRIPTION_MAX} characters.`;
    }
  }

  if (!Array.isArray(p.items)) {
    errors.items = 'Add at least one item.';
    return errors;
  }
  if (p.items.length < ITEMS_MIN) errors.items = 'Add at least one item.';
  else if (p.items.length > ITEMS_MAX) errors.items = `A template holds at most ${ITEMS_MAX} items.`;

  p.items.forEach((raw, index) => {
    const item = raw as Partial<SaveItem> | null;
    if (!item || typeof item !== 'object') {
      errors.item[index] = 'This item could not be read.';
      return;
    }
    if (item.id !== undefined && (typeof item.id !== 'string' || item.id === '')) {
      errors.item[index] = 'This item could not be read.';
    } else if (typeof item.title !== 'string' || item.title.trim() === '') {
      errors.item[index] = 'Give the item a title.';
    } else if (item.title.trim().length > ITEM_TITLE_MAX) {
      errors.item[index] = `Keep the title to ${ITEM_TITLE_MAX} characters.`;
    } else if (
      item.description !== null &&
      item.description !== undefined &&
      (typeof item.description !== 'string' || item.description.trim().length > DESCRIPTION_MAX)
    ) {
      errors.item[index] = `Keep the description to ${DESCRIPTION_MAX} characters.`;
    } else if (typeof item.is_required !== 'boolean') {
      errors.item[index] = 'This item could not be read.';
    } else if (item.expected_document_type !== null && !isChecklistDocumentType(item.expected_document_type)) {
      errors.item[index] = 'Choose a document type from the list.';
    }
  });

  return errors;
}
