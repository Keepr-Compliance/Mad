/**
 * Component registry for the QA harness (BACKLOG-1848).
 *
 * Assembles the pluggable `CeremonyComponents` set for a scenario. As sibling
 * tasks merge, swap the stub for the real implementation here (one line each):
 *   driver         -> H2 (BACKLOG-1849)
 *   dbAsserter     -> H3 (BACKLOG-1850)
 *   seeder(gmail)  -> H4 (BACKLOG-1851)
 *   exportAsserter -> H5 (BACKLOG-1852)
 *   updateRunner   -> F  (later)
 */
import type {
  CeremonyComponents,
  EmailSource,
  SeederComponent,
} from '../types';
import {
  createStubSeeder,
  stubDriver,
  stubExportAsserter,
  stubUpdateRunner,
} from './stubs';
import { outlookSeeder } from './outlookSeeder';
import { gmailSeeder } from './gmailSeeder';
import { createDbSetDiffAsserter } from '../db-set-diff-asserter';

/** Pick the seeder for a source. Outlook + Gmail have real impls; others stub. */
export function selectSeeder(source: EmailSource): SeederComponent {
  switch (source) {
    case 'outlook':
      return outlookSeeder;
    case 'gmail':
      // H4 (BACKLOG-1851): real Gmail seeder. Self-guards to `gated` unless the
      // Google Workspace tenant/token exists (BACKLOG-1845); `stub` unless --live.
      return gmailSeeder;
    default:
      return createStubSeeder(source);
  }
}

/**
 * Build the default component set for a scenario source. Driver/asserters are
 * stubs until their owning tasks land; the seeder is real for Outlook (but
 * self-guards to a no-op unless the ceremony runs with `--live`).
 */
export function buildComponents(source: EmailSource): CeremonyComponents {
  return {
    seeder: selectSeeder(source),
    driver: stubDriver,
    // H3 (BACKLOG-1850) — real asserter; self-guards to `stub` unless --live.
    dbAsserter: createDbSetDiffAsserter(),
    exportAsserter: stubExportAsserter,
    updateRunner: stubUpdateRunner,
  };
}
