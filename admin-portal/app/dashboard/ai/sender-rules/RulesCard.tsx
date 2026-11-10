'use client';

/**
 * The rules (BACKLOG-4186): the owner edits a draft; everyone else sees the released rules
 * read-only. Structured editors, no JSON textarea; "View JSON" shows the content read-only.
 */

import { useState } from 'react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label } from '@keepr/ui';
import {
  BULK_KEYS,
  MEASURE_ONLY_SIGNALS,
  MODES,
  SIGNALS,
  SURFACES,
  THRESHOLD_KEYS,
  type LocalPartRule,
  type SenderRuleSet,
  type ThresholdKey,
} from '@/lib/sender-rules/types';
import { MODE_LABELS, SIGNAL_LABELS, SURFACE_LABELS, THRESHOLD_LABELS } from '@/lib/sender-rules/labels';
import { CAPS } from '@/lib/sender-rules/validate';
import {
  addLocalPart,
  addStringItems,
  getStringList,
  setAutoSubmittedCounts,
  setLocalParts,
  setMode,
  setStringList,
  STRING_LIST_KIND,
  toggleBulkKey,
  type StringListPath,
} from '@/lib/sender-rules/edit';
import { TIPS, type TipKey } from '@/lib/sender-rules/tips';
import { InfoTip } from './InfoTip';
import { ListEditor } from './ListEditor';

const BULK_KEY_LABELS: Record<(typeof BULK_KEYS)[number], string> = {
  list_unsubscribe: 'List-Unsubscribe',
  list_unsubscribe_post: 'List-Unsubscribe-Post',
  precedence: 'Precedence',
  auto_submitted: 'Auto-Submitted',
};

export interface RulesCardProps {
  content: SenderRuleSet;
  readOnly: boolean;
  /** The version the draft was loaded from (owner only). */
  baseVersion?: number;
  releasedVersion: number;
  onChange?: (next: SenderRuleSet) => void;
  thresholdText?: Record<ThresholdKey, string>;
  thresholdErrors?: Partial<Record<ThresholdKey, string>>;
  onThresholdText?: (key: ThresholdKey, text: string) => void;
}

export function RulesCard({
  content,
  readOnly,
  baseVersion,
  releasedVersion,
  onChange,
  thresholdText,
  thresholdErrors,
  onThresholdText,
}: RulesCardProps) {
  const [showJson, setShowJson] = useState(false);
  const [lpMatch, setLpMatch] = useState<LocalPartRule['match']>('exact');
  const change = (next: SenderRuleSet) => onChange?.(next);

  const list = (path: StringListPath, label: string, placeholder: string) => {
    const items = getStringList(content, path);
    return (
      <ListEditor
        id={path}
        label={label}
        items={items}
        cap={CAPS[path]}
        readOnly={readOnly}
        placeholder={placeholder}
        tip={TIPS[path]}
        onAdd={(input) => {
          const r = addStringItems(items, input, STRING_LIST_KIND[path], CAPS[path]);
          if (r.items.length !== items.length) change(setStringList(content, path, r.items));
          return r.error;
        }}
        onRemove={(i) => change(setStringList(content, path, items.filter((_, j) => j !== i)))}
      />
    );
  };

  const lps = content.suppress.localParts;

  const heading = (title: string, tip: TipKey) => (
    <div className="flex items-center gap-1.5">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      <InfoTip label={title} text={TIPS[tip]} />
    </div>
  );

  return (
    <Card data-testid="rules-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">{readOnly ? 'Rules' : 'Edit'}</CardTitle>
            <InfoTip label={readOnly ? 'Rules' : 'Edit'} text={TIPS.card} />
          </div>
          <CardDescription>
            {readOnly
              ? `The rules every org runs (v${releasedVersion}).`
              : baseVersion !== undefined && baseVersion !== releasedVersion
                ? `Editing from v${baseVersion}. Changes are compared with everyone's rules (v${releasedVersion}).`
                : `Editing from everyone's rules (v${releasedVersion}).`}
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowJson((v) => !v)}>
          {showJson ? 'Hide JSON' : 'View JSON'}
        </Button>
      </CardHeader>
      <CardContent className="space-y-6">
        {showJson && (
          <pre className="max-h-96 overflow-auto rounded-md bg-gray-50 p-3 text-xs text-gray-800" data-testid="rules-json">
            {JSON.stringify(content, null, 2)}
          </pre>
        )}

        <section className="space-y-4">
          {heading('Hide mail from', 'hide')}
          {list('suppress.exactAddresses', 'Addresses', 'name@example.com')}
          {list('suppress.hosts', 'Domains', 'example.com')}
          <ListEditor
            id="suppress.localParts"
            label="Sender names"
            items={lps.map((r) => r.value)}
            format={(_v, i) => lps[i].value + (lps[i].match === 'prefix' ? ' (starts with)' : ' (exact)')}
            cap={CAPS['suppress.localParts']}
            readOnly={readOnly}
            placeholder="noreply"
            tip={TIPS['suppress.localParts']}
            extra={
              <select
                aria-label="Sender name match"
                value={lpMatch}
                onChange={(e) => setLpMatch(e.target.value as LocalPartRule['match'])}
                className="h-8 rounded-md border border-gray-300 bg-white px-2 text-sm"
              >
                <option value="exact">Exact</option>
                <option value="prefix">Starts with</option>
              </select>
            }
            onAdd={(input) => {
              const r = addLocalPart(lps, input, lpMatch);
              if (r.items !== lps) change(setLocalParts(content, r.items));
              return r.error;
            }}
            onRemove={(i) => change(setLocalParts(content, lps.filter((_, j) => j !== i)))}
          />
          <div className="space-y-2" data-testid="bulk-headers">
            <div className="flex items-center gap-1.5">
              <h4 className="text-sm font-medium text-gray-900">Bulk headers</h4>
              <InfoTip label="Bulk headers" text={TIPS.bulkHeaders} />
            </div>
            <div className="flex flex-wrap gap-4">
              {BULK_KEYS.map((k) => {
                const on = content.suppress.bulkHeaders.anyKeyPresent.includes(k);
                return (
                  <div key={k} className="flex items-center gap-2">
                    <Checkbox
                      id={`bulk-${k}`}
                      checked={on}
                      disabled={readOnly}
                      onCheckedChange={(v) => change(toggleBulkKey(content, k, v === true))}
                    />
                    <Label htmlFor={`bulk-${k}`} className="text-sm font-normal">
                      {BULK_KEY_LABELS[k]}
                    </Label>
                  </div>
                );
              })}
            </div>
            {list('suppress.bulkHeaders.precedenceValues', 'Precedence values', 'bulk')}
            <div className="flex items-center gap-2">
              <Checkbox
                id="bulk-auto-submitted-counts"
                checked={content.suppress.bulkHeaders.autoSubmittedCounts}
                disabled={readOnly}
                onCheckedChange={(v) => change(setAutoSubmittedCounts(content, v === true))}
              />
              <Label htmlFor="bulk-auto-submitted-counts" className="text-sm font-normal">
                Count auto-submitted mail
              </Label>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          {heading('Always keep', 'keep')}
          {list('keep.platformHosts', 'Platform domains', 'example.com')}
          {list('keep.platformAddresses', 'Platform addresses', 'name@example.com')}
        </section>

        <section className="space-y-4">
          {list('freeMailDomains', 'Free-mail domains', 'example.com')}
        </section>

        <section className="space-y-2">
          {heading('Where each rule is live', 'modes')}
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="modes-grid">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1 pr-4 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      Rule
                      <InfoTip label="Rule" text={TIPS.rule} />
                    </span>
                  </th>
                  {SURFACES.map((f) => (
                    <th key={f} className="py-1 pr-4 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {SURFACE_LABELS[f]}
                        <InfoTip label={SURFACE_LABELS[f]} text={TIPS[f]} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SIGNALS.map((s) => (
                  <tr key={s} className="border-t border-gray-100">
                    <td className="py-1.5 pr-4 text-gray-900">{SIGNAL_LABELS[s]}</td>
                    {SURFACES.map((f) => (
                      <td key={f} className="py-1.5 pr-4">
                        {readOnly ? (
                          <span className="text-gray-700">{MODE_LABELS[content.modes[s][f]]}</span>
                        ) : (
                          <select
                            aria-label={`${SIGNAL_LABELS[s]} in ${SURFACE_LABELS[f]}`}
                            value={content.modes[s][f]}
                            onChange={(e) => change(setMode(content, s, f, e.target.value as (typeof MODES)[number]))}
                            className="h-8 rounded-md border border-gray-300 bg-white px-2 text-sm"
                          >
                            {MODES.filter((m) => m !== 'live' || !MEASURE_ONLY_SIGNALS.includes(s)).map((m) => (
                              <option key={m} value={m}>
                                {MODE_LABELS[m]}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-2">
          {heading('Thresholds', 'thresholds')}
          <div className="grid gap-4 sm:grid-cols-3">
            {THRESHOLD_KEYS.map((k) => (
              <div key={k} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Label htmlFor={`threshold-${k}`} className="text-sm">
                    {THRESHOLD_LABELS[k]}
                  </Label>
                  <InfoTip label={THRESHOLD_LABELS[k]} text={TIPS[k]} />
                </div>
                {readOnly ? (
                  <p id={`threshold-${k}`} className="text-sm text-gray-700">
                    {content.thresholds[k]}
                  </p>
                ) : (
                  <>
                    <Input
                      id={`threshold-${k}`}
                      inputMode="numeric"
                      value={thresholdText?.[k] ?? String(content.thresholds[k])}
                      onChange={(e) => onThresholdText?.(k, e.target.value)}
                      className="h-8"
                    />
                    {thresholdErrors?.[k] && (
                      <p className="text-xs text-red-600" role="alert">
                        {thresholdErrors[k]}
                      </p>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
