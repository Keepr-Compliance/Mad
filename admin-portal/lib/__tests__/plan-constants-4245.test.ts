/**
 * BACKLOG-4245: the plan editor never offers `beta_updates` (granted per
 * organization only).
 */
import { describe, it, expect } from 'vitest';
import {
  PLAN_EDITOR_HIDDEN_FEATURE_KEYS,
  withoutPlanEditorHiddenFeatures,
  withoutPlanEditorHiddenPlanFeatures,
} from '../plan-constants';

describe('plan editor hidden keys', () => {
  it('hides beta_updates and keeps account_suspended hidden', () => {
    expect(PLAN_EDITOR_HIDDEN_FEATURE_KEYS).toEqual(expect.arrayContaining(['account_suspended', 'beta_updates']));
  });

  it('drops beta_updates from definitions and plan rows, keeps others', () => {
    const defs = [{ key: 'beta_updates' }, { key: 'text_export' }];
    expect(withoutPlanEditorHiddenFeatures(defs).map((d) => d.key)).toEqual(['text_export']);
    const rows = [
      { feature_definitions: { key: 'beta_updates' } },
      { feature_definitions: { key: 'text_export' } },
    ];
    expect(withoutPlanEditorHiddenPlanFeatures(rows).map((r) => r.feature_definitions.key)).toEqual(['text_export']);
  });
});
