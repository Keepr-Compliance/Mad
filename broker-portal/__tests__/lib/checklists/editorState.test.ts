/**
 * Checklist editor state — BACKLOG-3474.
 *
 * What the editor sends is what the save function writes, in that order, so:
 *   - isDirty counts ORDER (a reorder alone must arm Save) and ignores edits
 *     that cancel out;
 *   - the payload lists items in display order (the function writes
 *     sort_order = position * 10 from it);
 *   - validation boundaries are swept, not sampled: the same limits as the
 *     database CHECKs, counted in UTF-16 units of the trimmed string because
 *     the desktop's zod schema counts that way (see editorState.ts header).
 *
 * @jest-environment node
 */

import {
  DESCRIPTION_MAX,
  ITEMS_MAX,
  ITEM_TITLE_MAX,
  TEMPLATE_NAME_MAX,
  addItem,
  fromTemplate,
  hasErrors,
  isDirty,
  moveItem,
  removeItem,
  toSavePayload,
  updateItem,
  validateSavePayload,
  type EditorState,
  type SavePayload,
  type TemplateItemRow,
} from '@/lib/checklists/editorState';

// Shape of a checklist_template_items embed row as PostgREST returns it — the
// field set and order of the desktop's captured read
// (supabase/tests/backlog-3473/fixtures/postgrest-desktop-read.json).
const ROWS: TemplateItemRow[] = [
  { id: 'i-2', title: 'Second', sort_order: 20, description: null, is_required: false, expected_document_type: null },
  { id: 'i-1', title: 'First', sort_order: 10, description: 'the desktop tooltip', is_required: true, expected_document_type: 'contract' },
  { id: 'i-3', title: 'Third', sort_order: 30, description: null, is_required: true, expected_document_type: 'closing' },
];

const loaded = (): EditorState => fromTemplate({ name: 'Residential purchase', description: null }, ROWS);
const titles = (s: EditorState) => s.items.map((i) => i.title);
const payloadTitles = (p: SavePayload) => p.items.map((i) => i.title);

function payload(over: Partial<SavePayload> = {}): SavePayload {
  return {
    name: 'Template',
    description: null,
    items: [{ title: 'Item', description: null, is_required: false, expected_document_type: null }],
    ...over,
  };
}

describe('fromTemplate', () => {
  it('orders items by sort_order and maps NULLs to editor blanks', () => {
    const s = loaded();
    expect(titles(s)).toEqual(['First', 'Second', 'Third']);
    expect(s.items[0]).toMatchObject({ id: 'i-1', isRequired: true, documentType: 'contract', description: 'the desktop tooltip' });
    expect(s.items[1]).toMatchObject({ id: 'i-2', isRequired: false, documentType: '', description: '' });
    expect(s.description).toBe('');
  });
});

describe('isDirty', () => {
  it('is false for an untouched template', () => {
    expect(isDirty(loaded(), loaded())).toBe(false);
  });

  it('reorder alone arms Save', () => {
    const initial = loaded();
    expect(isDirty(initial, moveItem(initial, 0, 2))).toBe(true);
  });

  it('move up then back down is not dirty', () => {
    const initial = loaded();
    const s = moveItem(moveItem(initial, 1, 0), 0, 1);
    expect(titles(s)).toEqual(titles(initial));
    expect(isDirty(initial, s)).toBe(false);
  });

  it('removing an item and adding one with the same title is dirty (the stored row is replaced)', () => {
    const initial = loaded();
    const removed = removeItem(initial, 'i-3');
    const added = addItem(removed, 'k-new');
    const s = updateItem(added, 'k-new', { title: 'Third', isRequired: true, documentType: 'closing' });
    expect(isDirty(initial, s)).toBe(true);
  });

  it('a Required toggle and a document type change each arm Save', () => {
    const initial = loaded();
    expect(isDirty(initial, updateItem(initial, 'i-2', { isRequired: true }))).toBe(true);
    expect(isDirty(initial, updateItem(initial, 'i-2', { documentType: 'offer' }))).toBe(true);
  });

  it('whitespace that the save trims away does not arm Save', () => {
    const initial = loaded();
    expect(isDirty(initial, { ...initial, name: '  Residential purchase ' })).toBe(false);
  });
});

describe('toSavePayload', () => {
  it('lists items in displayed order after moves', () => {
    const s = moveItem(moveItem(loaded(), 2, 0), 2, 1);
    expect(titles(s)).toEqual(['Third', 'Second', 'First']);
    expect(payloadTitles(toSavePayload(s))).toEqual(['Third', 'Second', 'First']);
  });

  it('keeps ids of stored items, omits id for new ones, trims, and sends NULL for blanks', () => {
    const s = updateItem(addItem(loaded(), 'k-new'), 'k-new', { title: '  New one ', description: '   ' });
    const p = toSavePayload({ ...s, name: '  Name  ', description: '  ' });
    expect(p.name).toBe('Name');
    expect(p.description).toBeNull();
    expect(p.items[0]).toEqual({ id: 'i-1', title: 'First', description: 'the desktop tooltip', is_required: true, expected_document_type: 'contract' });
    expect(p.items[3]).toEqual({ title: 'New one', description: null, is_required: false, expected_document_type: null });
    expect('id' in p.items[3]).toBe(false);
  });
});

describe('moveItem', () => {
  it('clamps to the list and ignores an out-of-range source', () => {
    const s = loaded();
    expect(titles(moveItem(s, 0, -5))).toEqual(titles(s));
    expect(titles(moveItem(s, 2, 99))).toEqual(titles(s));
    expect(moveItem(s, 7, 0)).toBe(s);
  });
});

describe('validateSavePayload — boundaries swept', () => {
  const nameOf = (n: number) => 'n'.repeat(n);

  it.each([
    [0, true], [1, false], [TEMPLATE_NAME_MAX - 1, false], [TEMPLATE_NAME_MAX, false], [TEMPLATE_NAME_MAX + 1, true],
  ])('template name of %i characters -> error %s', (n, bad) => {
    expect(Boolean(validateSavePayload(payload({ name: nameOf(n) })).name)).toBe(bad);
  });

  it.each([
    [0, true], [1, false], [ITEM_TITLE_MAX - 1, false], [ITEM_TITLE_MAX, false], [ITEM_TITLE_MAX + 1, true],
  ])('item title of %i characters -> error %s', (n, bad) => {
    const p = payload({ items: [{ title: 't'.repeat(n), description: null, is_required: false, expected_document_type: null }] });
    expect(Boolean(validateSavePayload(p).item[0])).toBe(bad);
  });

  it.each([
    [DESCRIPTION_MAX, false], [DESCRIPTION_MAX + 1, true],
  ])('item description of %i characters -> error %s', (n, bad) => {
    const p = payload({ items: [{ title: 't', description: 'd'.repeat(n), is_required: false, expected_document_type: null }] });
    expect(Boolean(validateSavePayload(p).item[0])).toBe(bad);
  });

  it.each([
    [DESCRIPTION_MAX, false], [DESCRIPTION_MAX + 1, true],
  ])('template description of %i characters -> error %s', (n, bad) => {
    expect(Boolean(validateSavePayload(payload({ description: 'd'.repeat(n) })).description)).toBe(bad);
  });

  it('whitespace-only name and title are empty', () => {
    const p = payload({ name: '   ', items: [{ title: ' \t ', description: null, is_required: false, expected_document_type: null }] });
    const e = validateSavePayload(p);
    expect(e.name).toBeTruthy();
    expect(e.item[0]).toBeTruthy();
  });

  it('measures the TRIMMED length (surrounding spaces are not counted)', () => {
    const p = payload({ name: `  ${nameOf(TEMPLATE_NAME_MAX)}  ` });
    expect(validateSavePayload(p).name).toBeUndefined();
  });

  it.each([
    [0, true], [1, false], [ITEMS_MAX, false], [ITEMS_MAX + 1, true],
  ])('%i items -> list error %s', (n, bad) => {
    const items = Array.from({ length: n }, (_, k) => ({ title: `i${k}`, description: null, is_required: false, expected_document_type: null }));
    expect(Boolean(validateSavePayload(payload({ items })).items)).toBe(bad);
  });

  // The desktop's zod `.max(300)` counts UTF-16 units: 151 astral characters
  // are 151 code points (the database accepts them) but 302 UTF-16 units (the
  // desktop drops the item list). The editor must refuse it.
  it('counts UTF-16 units, the stricter of the database and the desktop', () => {
    const astral = '\u{1F3E0}';
    const ok = astral.repeat(150);
    const tooLong = astral.repeat(151);
    expect([...tooLong].length).toBe(151);
    expect(tooLong.length).toBe(302);
    const at = (title: string) =>
      validateSavePayload(payload({ items: [{ title, description: null, is_required: false, expected_document_type: null }] })).item[0];
    expect(at(ok)).toBeUndefined();
    expect(at(tooLong)).toBeTruthy();
  });

  it('refuses a document type outside the ten', () => {
    const p = payload({ items: [{ title: 't', description: null, is_required: false, expected_document_type: 'lease' as never }] });
    expect(validateSavePayload(p).item[0]).toBeTruthy();
  });

  it('reports malformed input instead of throwing', () => {
    expect(hasErrors(validateSavePayload(null))).toBe(true);
    expect(hasErrors(validateSavePayload({ name: 'x', items: 'nope' }))).toBe(true);
    expect(hasErrors(validateSavePayload({ name: 'x', items: [null] }))).toBe(true);
    expect(hasErrors(validateSavePayload({ name: 'x', items: [{ title: 't', is_required: 'yes', expected_document_type: null }] }))).toBe(true);
  });

  it('a valid payload has no errors', () => {
    expect(hasErrors(validateSavePayload(payload()))).toBe(false);
  });
});
