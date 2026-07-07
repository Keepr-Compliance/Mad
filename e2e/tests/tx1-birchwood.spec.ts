import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, expect, test } from '../fixtures/electron.fixture';
import { resolveExecutable } from '../driver/paths';

/**
 * Full driver-step walkthrough for the TX1 Birchwood scenario. This exercises every
 * reusable step the H1 ceremony runner sequences and is the integration proof for
 * H4/H5. It requires a ready, logged-in app with the seeded corpus, so it is OPT-IN:
 *   KEEPR_E2E_FULL=1  (and ideally KEEPR_E2E_STRATEGY=electron against a QA build so the
 *   native folder dialog can be stubbed for the export step).
 */

const TX1_ADDRESS = '742 Birchwood Lane NE';

let hasPackagedApp = true;
try {
  resolveExecutable(REPO_ROOT, process.env.KEEPR_APP_PATH);
} catch {
  hasPackagedApp = false;
}

const runFull = process.env.KEEPR_E2E_FULL === '1' && hasPackagedApp;

test.describe('TX1 Birchwood driver walkthrough', () => {
  test.skip(!runFull, 'Opt-in: set KEEPR_E2E_FULL=1 with a ready, logged-in QA build (KEEPR_E2E_STRATEGY=electron).');

  test('onboarding-ready → navigate → toggle filter ON/OFF → export', async ({ driver }) => {
    await driver.completeOnboarding({ skip: true });
    expect(await driver.detectState()).toBe('ready');

    await driver.gotoTransaction(TX1_ADDRESS);

    // Toggle ON, verify, then OFF, verify. (Corpus-derived counts are asserted by H3/H5,
    // not here — this proves the CONTROL works deterministically.)
    await driver.setAddressFilter(true);
    expect(await driver.getAddressFilterState()).toBe(true);
    await driver.setAddressFilter(false);
    expect(await driver.getAddressFilterState()).toBe(false);

    // Export to a temp dir. Under the electron strategy the native picker is stubbed.
    const destDir = join(tmpdir(), `keepr-e2e-export-${Date.now()}`);
    const result = await driver.triggerExport({ format: 'folder', destDir });
    expect(result.triggered).toBe(true);
    if (driver.strategy === 'electron') {
      expect(result.nativeDialogStubbed, 'folder picker should be stubbed under electron strategy').toBe(true);
    }
    await driver.screenshot('tx1-export');
  });
});
