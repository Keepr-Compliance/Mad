import type { Page } from '@playwright/test';

/**
 * BACKLOG-3968 U2 — checklist link picker Texts tab, cells for the BUILT app (T1-T5).
 *
 * WRITTEN, NOT RUN: harness runs are blocked until BACKLOG-4054 and BACKLOG-4093 are
 * fixed (plan 759c64a1 §11). Each cell returns { id, ok, detail }; a runner asserts
 * every ok. The cells expect a seeded profile with one deal that has an open
 * checklist item and at least two linked texts, and (T4) a second deal that is
 * submitted (locked). Selectors are the testids the renderer ships.
 */

export interface CellResult {
  id: string;
  ok: boolean;
  detail: string;
  /** Set when the cell could not reach its precondition; the runner records SKIP with this reason. */
  skip?: string;
}

export interface ChecklistTextsSeed {
  /** testid suffix of the item whose Link… is pressed (`checklist-open-picker-<itemId>`). */
  itemId: string;
  /** A second item on the same deal, for T2 (two texts, one group). */
  secondItemId: string;
}

const PICKER = '[data-testid="checklist-link-picker"]';

async function openTextsTab(page: Page, itemId: string): Promise<void> {
  await page.getByTestId(`checklist-open-picker-${itemId}`).click();
  await page.locator(PICKER).waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByTestId('checklist-picker-tab-texts').click();
  await page.locator('[data-testid^="checklist-picker-text-"]').first().waitFor({ state: 'visible', timeout: 15_000 });
}

async function textRows(page: Page) {
  return page.locator('[data-testid^="checklist-picker-text-"]');
}

/** T1: link one text from the Texts tab; one new text chip appears on the item. */
export async function cellLinkOneText(page: Page, seed: ChecklistTextsSeed): Promise<CellResult> {
  const item = page.getByTestId(`checklist-item-${seed.itemId}`);
  const before = await item.locator('[data-testid^="checklist-link-"][data-stale]').count();
  await openTextsTab(page, seed.itemId);
  await (await textRows(page)).first().click();
  const label = await page.getByTestId('checklist-picker-link').textContent();
  await page.getByTestId('checklist-picker-link').click();
  await page.locator(PICKER).waitFor({ state: 'detached', timeout: 10_000 });
  const after = await item.locator('[data-testid^="checklist-link-"][data-stale]').count();
  return { id: 'T1', ok: label?.trim() === 'Link 1 text' && after === before + 1, detail: `button "${label}", chips ${before} -> ${after}` };
}

/** T2: two texts picked together become ONE group (one chip reading "2 texts"). */
export async function cellLinkTwoTexts(page: Page, seed: ChecklistTextsSeed): Promise<CellResult> {
  const item = page.getByTestId(`checklist-item-${seed.secondItemId}`);
  const before = await item.locator('[data-testid^="checklist-link-"][data-stale]').count();
  await openTextsTab(page, seed.secondItemId);
  const rows = await textRows(page);
  await rows.nth(0).click();
  await rows.nth(1).click();
  const label = await page.getByTestId('checklist-picker-link').textContent();
  await page.getByTestId('checklist-picker-link').click();
  await page.locator(PICKER).waitFor({ state: 'detached', timeout: 10_000 });
  const chips = item.locator('[data-testid^="checklist-link-"][data-stale]');
  const after = await chips.count();
  const last = after > 0 ? await chips.nth(after - 1).textContent() : '';
  return {
    id: 'T2',
    ok: label?.trim() === 'Link 2 texts' && after === before + 1 && /2 texts/.test(last ?? ''),
    detail: `button "${label}", chips ${before} -> ${after}, last chip "${last}"`,
  };
}

/** T3: the text chip — TXT mark, "Text · <name>", View opens the conversation. */
export async function cellTextChip(page: Page, seed: ChecklistTextsSeed): Promise<CellResult> {
  const item = page.getByTestId(`checklist-item-${seed.itemId}`);
  // `has` is resolved inside each candidate chip, so the inner locator is rooted at the page
  // (as the jest chip test uses within(chip)), not at the item.
  const chip = item
    .locator('[data-testid^="checklist-link-"][data-stale]')
    .filter({ has: page.getByTestId('checklist-link-text-icon') })
    .first();
  // Awaiting waits (no runner-only expect: the cells also run outside Playwright Test).
  await chip.waitFor({ state: 'visible', timeout: 10_000 });
  const iconText = (await chip.getByTestId('checklist-link-text-icon').textContent())?.trim();
  // The chip's text starts with the TXT mark, then the title "Text · <name>".
  const text = (await chip.textContent()) ?? '';
  await chip.getByTestId('checklist-link-view').click();
  const opened = await page
    .getByTestId('conversation-count')
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true, () => false);
  return {
    id: 'T3',
    ok: iconText === 'TXT' && /^TXT\s*Text · /.test(text) && opened,
    detail: `icon "${iconText}", chip "${text}", conversation opened ${opened}`,
  };
}

/**
 * T4: a locked deal refuses the link. The picker is not offered on a locked deal
 * (Link… is not rendered, ChecklistItemRow `!readOnly`); a lock arriving while the
 * picker is open is the jsdom control (ChecklistLinkPicker.texts-3968, "a locked deal").
 */
export async function cellLockedDealRefuses(page: Page, lockedItemId: string): Promise<CellResult> {
  // Absence alone would also pass on a page that never reached the deal: require the lock notice.
  const notice = await page.getByTestId('checklist-locked-notice').isVisible().catch(() => false);
  const button = page.getByTestId(`checklist-open-picker-${lockedItemId}`);
  const present = await button.count();
  const disabled = present > 0 ? await button.isDisabled() : true;
  return { id: 'T4', ok: notice && disabled, detail: `lock notice ${notice}, Link… present ${present}, disabled ${disabled}` };
}

/**
 * T5: Submit for review lists the text link with the short reason it is not sent.
 * Submit for Review is reached through Complete (`complete-button`) and opens only when the
 * license has an organization (useCompleteTransaction.ts:128-131). When it is not open, the
 * cell SKIPs with that reason; the pre-flight sentence itself is covered by jest
 * SubmitForReviewModal.textLinkGap-3968.
 */
export async function cellPreflightSentence(page: Page): Promise<CellResult> {
  const submit = page.locator('[data-testid^="submit-review-"]').first();
  const reachable = await submit.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false);
  if (!reachable) {
    return {
      id: 'T5',
      ok: false,
      skip: 'Submit for Review not reachable (Complete needs a license with an organization, useCompleteTransaction.ts:128-131); pre-flight sentence covered by jest SubmitForReviewModal.textLinkGap-3968.',
      detail: 'submit-review-* not visible',
    };
  }
  const line = page.getByTestId('submit-review-link-gap-not-included').filter({ hasText: 'Text · ' }).first();
  await line.waitFor({ state: 'visible', timeout: 20_000 });
  const text = (await line.textContent()) ?? '';
  return { id: 'T5', ok: text.endsWith('texts will be included after the next update.'), detail: text };
}
