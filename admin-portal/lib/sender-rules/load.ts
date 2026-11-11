/**
 * Sender rules — what the page reads before it renders (BACKLOG-4186).
 *
 * The state, then the released version's content (the base every diff and every edit starts
 * from). Any failure is a result, never a throw: the page then shows "could not be read" and NO
 * write control (control A18), because an editor without the released content would diff and
 * publish against nothing.
 *
 * Pure: the API is injected (the signed-in session client, never the service key).
 */

import { SenderRulesError, type SenderRulesApi } from './api';
import type { SenderRuleSet, SenderRulesAdminState } from './types';

export type SenderRulesLoad =
  | { ok: true; state: SenderRulesAdminState; released: SenderRuleSet }
  | { ok: false; message: string };

export async function loadSenderRules(api: Pick<SenderRulesApi, 'state' | 'content'>): Promise<SenderRulesLoad> {
  try {
    const state = await api.state();
    if (state.released_version === null) return { ok: false, message: 'No released version was found.' };
    const released = await api.content(state.released_version);
    if (released === null) return { ok: false, message: 'Version ' + state.released_version + ' could not be read.' };
    return { ok: true, state, released };
  } catch (e) {
    return { ok: false, message: e instanceof SenderRulesError ? e.message : 'The sender rules could not be read.' };
  }
}
