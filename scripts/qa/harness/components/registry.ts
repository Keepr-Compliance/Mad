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
  stubDbAsserter,
  stubDriver,
  stubExportAsserter,
  stubUpdateRunner,
} from './stubs';
import { outlookSeeder } from './outlookSeeder';

/** Pick the seeder for a source. Outlook has a real reference impl; others stub. */
export function selectSeeder(source: EmailSource): SeederComponent {
  switch (source) {
    case 'outlook':
      return outlookSeeder;
    case 'gmail':
    default:
      // H4 (BACKLOG-1851) adds the Gmail seeder.
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
    dbAsserter: stubDbAsserter,
    exportAsserter: stubExportAsserter,
    updateRunner: stubUpdateRunner,
  };
}
