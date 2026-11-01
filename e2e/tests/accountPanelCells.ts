import type { ElectronApplication, Page } from '@playwright/test';

/**
 * BACKLOG-3964 slice 3a — account side panel cells for the BUILT app (H1-H8).
 *
 * Shared by e2e/tests/settings-stacking.spec.ts and the safeguarded walkthrough runner, so both
 * run the same checks. Each cell returns { id, ok, detail }; the spec asserts every ok.
 * jsdom cannot hit-test pixels; these cells do (document.elementFromPoint on the real window).
 */

export interface CellResult {
  id: string;
  ok: boolean;
  detail: string;
}

const HELP = '[data-support-widget]';
const PANEL = '[data-testid="account-panel"]';

/** True when the element matching `selector` is the topmost element at its own centre point. */
export async function isTopmostAtCentre(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  }, selector);
}

/** testid of the topmost element (or its nearest ancestor with one) at a point. */
async function testidAt(page: Page, x: number, y: number): Promise<string> {
  return page.evaluate(
    ([px, py]) => {
      let el = document.elementFromPoint(px, py) as HTMLElement | null;
      while (el && !el.dataset.testid && !el.hasAttribute('data-support-widget')) el = el.parentElement;
      if (!el) return 'none';
      return el.dataset.testid ?? 'support-widget';
    },
    [x, y] as [number, number],
  );
}

async function rect(page: Page, selector: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, selector);
}

async function openPanel(page: Page): Promise<void> {
  if (await page.locator(PANEL).isVisible().catch(() => false)) return;
  await page.getByTestId('nav-profile').click();
  await page.locator(PANEL).waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(300);
}

async function closeIfOpen(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await page.locator(PANEL).isVisible().catch(() => false)); i++) {
    await page.getByTestId('account-panel-close').click();
    await page.waitForTimeout(300);
  }
}

async function cell(id: string, fn: () => Promise<string | true>): Promise<CellResult> {
  try {
    const r = await fn();
    return r === true ? { id, ok: true, detail: 'ok' } : { id, ok: false, detail: r };
  } catch (e) {
    return { id, ok: false, detail: `threw: ${String((e as Error)?.message ?? e).slice(0, 300)}` };
  }
}

export interface PanelCellOptions {
  app: ElectronApplication;
  shot?: (name: string) => Promise<unknown>;
  /** Expected display name of the seeded user (H7 seeds a 60-character one). */
  longName?: string;
}

export async function runAccountPanelCells(page: Page, opts: PanelCellOptions): Promise<CellResult[]> {
  const out: CellResult[] = [];
  const shot = opts.shot ?? (async () => undefined);
  const vp = async () => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));

  out.push(
    await cell('H8 initials on the LEFT, clear of the macOS traffic lights', async () => {
      const b = await rect(page, '[data-testid="nav-profile"]');
      const { w } = await vp();
      await shot('h8-title-bar');
      if (!b) return 'no initials';
      if (b.x > w / 2) return `initials on the right half (x=${b.x}, width=${w})`;
      if (process.platform === 'darwin' && b.x < 72) return `left edge ${b.x}px sits under the traffic lights (< 72)`;
      return true;
    }),
  );

  out.push(
    await cell('H7 initials box stays 32x32 with a long display name', async () => {
      const b = await rect(page, '[data-testid="nav-profile"] [data-testid="account-avatar"]');
      const text = await page.getByTestId('nav-profile').innerText();
      if (!b) return 'no avatar';
      if (Math.round(b.w) !== 32 || Math.round(b.h) !== 32) return `avatar is ${b.w}x${b.h}`;
      if (text.trim().length !== 2) return `initials text "${text}" is not two letters`;
      if (opts.longName) {
        await openPanel(page);
        const pb = await rect(page, `${PANEL} [data-testid="account-avatar"]`);
        const panelText = await page.locator(PANEL).innerText();
        await shot('h7-long-name-panel');
        await closeIfOpen(page);
        if (!pb || Math.round(pb.w) !== 32 || Math.round(pb.h) !== 32) return `panel avatar ${JSON.stringify(pb)}`;
        if (!panelText.includes(opts.longName.slice(0, 20))) return 'panel does not show the seeded name';
      }
      return true;
    }),
  );

  out.push(
    await cell('H1 panel opens over the app; scrim covers the rest below the drag strip', async () => {
      await openPanel(page);
      const p = await rect(page, PANEL);
      const { w, h } = await vp();
      await shot('h1-panel-open');
      if (!p) return 'no panel';
      if (Math.abs(p.w - 256) > 2) return `panel width ${p.w} (want 256)`;
      if (Math.abs(p.y - 36) > 1) return `panel top ${p.y} (want 36, below the drag strip)`;
      const inPanel = await testidAt(page, p.x + p.w / 2, p.y + p.h / 2);
      const onScrim = await testidAt(page, Math.min(w - 20, p.w + 200), Math.min(h - 20, 50));
      if (!['account-panel', 'nav-settings'].includes(inPanel) && !inPanel.startsWith('account-panel')) return `panel centre hit ${inPanel}`;
      if (onScrim !== 'account-panel-scrim') return `point right of the panel at y=50 hit ${onScrim}`;
      return true;
    }),
  );

  out.push(
    await cell('H2 "?" visible and clickable with the panel open; form above; Esc order', async () => {
      await openPanel(page);
      if (!(await page.locator(HELP).isVisible())) return '"?" not visible';
      if (!(await isTopmostAtCentre(page, HELP))) return '"?" covered at its centre';
      if (!(await isTopmostAtCentre(page, '[data-testid="account-panel-signout"]'))) return 'Sign out covered at its centre (by the "?")';
      const hb = await rect(page, HELP);
      const pb = await rect(page, PANEL);
      if (!hb || !pb || hb.x < pb.x + pb.w) return `"?" left ${hb?.x} is not past the panel edge ${pb ? pb.x + pb.w : '?'}`;
      await shot('h2-panel-and-help');
      await page.locator(HELP).click();
      const form = page.getByTestId('support-ticket-dialog');
      await form.waitFor({ state: 'visible', timeout: 15_000 });
      if (!(await isTopmostAtCentre(page, '[data-testid="support-ticket-dialog"]'))) return 'support form covered';
      const field = form.locator('input:not([type=hidden]):not([disabled]), textarea:not([disabled])').first();
      await field.click();
      await page.keyboard.type('panel check');
      const typed = await field.inputValue().catch(() => '');
      if (!typed.includes('panel check')) return `typing into the form gave "${typed}" (focus trap held focus?)`;
      await shot('h2-support-form-over-panel');
      await page.keyboard.press('Escape');
      await form.waitFor({ state: 'hidden', timeout: 5_000 });
      if (!(await page.locator(PANEL).isVisible())) return 'first Esc closed the panel too';
      await page.keyboard.press('Escape');
      await page.locator(PANEL).waitFor({ state: 'hidden', timeout: 5_000 });
      return true;
    }),
  );

  out.push(
    await cell('H3 Esc closes the panel; focus is back on the initials', async () => {
      await openPanel(page);
      const focused0 = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? '');
      await page.keyboard.press('Escape');
      await page.locator(PANEL).waitFor({ state: 'hidden', timeout: 5_000 });
      const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? '');
      if (focused0 !== 'account-panel-close') return `focus on open was ${focused0}`;
      if (focused !== 'nav-profile') return `focus after Esc on ${focused}`;
      return true;
    }),
  );

  out.push(
    await cell('H4 a click on the scrim closes the panel', async () => {
      await openPanel(page);
      const { w, h } = await vp();
      await page.mouse.click(w - 40, Math.round(h / 2));
      await page.locator(PANEL).waitFor({ state: 'hidden', timeout: 5_000 });
      return true;
    }),
  );

  out.push(
    await cell('H5 Security row opens Settings at Security', async () => {
      await openPanel(page);
      await page.getByTestId('account-panel-row-settings-security').click();
      await page.getByTestId('settings-page').waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(1200);
      const consent = page.getByText('AI Features - Data Processing Consent');
      if (await consent.isVisible().catch(() => false)) await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
      const selected = await page.getByTestId('settings-tab-security').getAttribute('aria-selected');
      const inView = await page.evaluate(() => {
        const s = document.getElementById('settings-security');
        if (!s) return false;
        const r = s.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      });
      const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testid ?? '');
      await shot('h5-settings-security');
      await page.getByTestId('settings-close').click();
      await page.getByTestId('settings-page').waitFor({ state: 'hidden', timeout: 5_000 });
      if (selected !== 'true') return `Security tab aria-selected=${selected}`;
      if (!inView) return 'Security section not in view';
      if (focused !== 'settings-close') return `focus after the row on ${focused}`;
      return true;
    }),
  );

  out.push(
    await cell('H6 phone width: 82% drawer + scrim, "?" beside it, X clickable', async () => {
      const before = await opts.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const b = win.getBounds();
        win.setSize(400, 800);
        return b;
      });
      await page.waitForTimeout(800);
      try {
        await openPanel(page);
        const { w } = await vp();
        const p = await rect(page, PANEL);
        const hb = await rect(page, HELP);
        const scrimVisible = await page.getByTestId('account-panel-scrim').isVisible();
        const xTop = await isTopmostAtCentre(page, '[data-testid="account-panel-close"]');
        await shot('h6-phone-width');
        if (!p) return 'no panel';
        if (Math.abs(p.w - 0.82 * w) > 2) return `panel ${p.w}px at window ${w}px (want ${0.82 * w})`;
        if (!scrimVisible) return 'no scrim';
        if (!hb || Math.abs(hb.x - (0.82 * w + 10)) > 2) return `"?" left ${hb?.x} (want ${0.82 * w + 10})`;
        if (!xTop) return 'X not topmost at its centre';
        await page.getByTestId('account-panel-close').click();
        await page.locator(PANEL).waitFor({ state: 'hidden', timeout: 5_000 });
        return true;
      } finally {
        await opts.app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), before);
        await page.waitForTimeout(500);
      }
    }),
  );

  return out;
}
