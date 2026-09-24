/**
 * Expected document types and field limits: the portal, the database CHECKs,
 * the save function and the desktop schema agree — BACKLOG-3474.
 *
 * Reads the files as text; nothing is retyped here. A value the portal offers
 * that the CHECK refuses fails every save containing it; a CHECK value the
 * portal lacks can never be chosen.
 *
 * @jest-environment node
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { CHECKLIST_DOCUMENT_TYPES, CHECKLIST_DOCUMENT_TYPE_LABELS } from '@/lib/checklists/documentTypes';
import {
  DESCRIPTION_MAX,
  ITEMS_MAX,
  ITEMS_MIN,
  ITEM_TITLE_MAX,
  TEMPLATE_NAME_MAX,
} from '@/lib/checklists/editorState';

const REPO = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8').replace(/\r\n?/g, '\n');

function quoted(block: string): string[] {
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const MIGRATION = read('supabase/migrations/20260921101757_backlog_3473_transaction_checklists.sql');
const DESKTOP = read('electron/schemas/checklist.ts');
const SAVE_FN = read('supabase/migrations/20260924190429_backlog_3474_save_checklist_template.sql');

function checkValues(): string[] {
  const m = MIGRATION.match(
    /CONSTRAINT checklist_template_items_expected_document_type_check CHECK \(([\s\S]*?)\)\n\)/
  );
  if (!m) throw new Error('items document-type CHECK not found in the 3473 migration');
  return quoted(m[1]);
}

function desktopValues(): string[] {
  const m = DESKTOP.match(/ChecklistDocumentTypeSchema = z\.enum\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error('ChecklistDocumentTypeSchema not found in electron/schemas/checklist.ts');
  return quoted(m[1]);
}

describe('checklist document types', () => {
  it('portal list equals the database CHECK, same order', () => {
    expect(checkValues()).toHaveLength(10);
    expect([...CHECKLIST_DOCUMENT_TYPES]).toEqual(checkValues());
  });

  it('portal list equals the desktop schema, same order', () => {
    expect([...CHECKLIST_DOCUMENT_TYPES]).toEqual(desktopValues());
  });

  it('every value has a label', () => {
    expect(Object.keys(CHECKLIST_DOCUMENT_TYPE_LABELS).sort()).toEqual([...CHECKLIST_DOCUMENT_TYPES].sort());
  });
});

/** The one integer bound in `pattern`'s first match, or throw. */
function bound(text: string, pattern: RegExp, label: string): number {
  const m = text.match(pattern);
  if (!m) throw new Error(`${label} not found`);
  return Number(m[1]);
}

describe('checklist field limits', () => {
  it('template name: database, desktop and portal all 200', () => {
    expect(bound(MIGRATION, /checklist_templates_name_check CHECK \(char_length\(btrim\(name\)\) BETWEEN 1 AND (\d+)\)/, 'template name CHECK')).toBe(TEMPLATE_NAME_MAX);
    expect(bound(DESKTOP, /CloudChecklistTemplateSchema = z\.object\(\{[\s\S]*?name: z\.string\(\)\.min\(1\)\.max\((\d+)\)/, 'desktop name')).toBe(TEMPLATE_NAME_MAX);
  });

  it('item title: database, desktop and portal all 300', () => {
    expect(bound(MIGRATION, /checklist_template_items_title_check CHECK \(char_length\(btrim\(title\)\) BETWEEN 1 AND (\d+)\)/, 'item title CHECK')).toBe(ITEM_TITLE_MAX);
    expect(bound(DESKTOP, /title: z\.string\(\)\.min\(1\)\.max\((\d+)\)/, 'desktop title')).toBe(ITEM_TITLE_MAX);
  });

  it('descriptions: database 2000 for templates and items, portal 2000', () => {
    expect(bound(MIGRATION, /checklist_templates_description_check CHECK \(description IS NULL OR char_length\(description\) <= (\d+)\)/, 'template description CHECK')).toBe(DESCRIPTION_MAX);
    expect(bound(MIGRATION, /checklist_template_items_description_check CHECK \(description IS NULL OR char_length\(description\) <= (\d+)\)/, 'item description CHECK')).toBe(DESCRIPTION_MAX);
  });

  it('item count: save function and portal both 1..200', () => {
    const m = SAVE_FN.match(/jsonb_array_length\(p_items\) NOT BETWEEN (\d+) AND (\d+)/);
    expect(m).not.toBeNull();
    expect([Number(m![1]), Number(m![2])]).toEqual([ITEMS_MIN, ITEMS_MAX]);
  });
});
