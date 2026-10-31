'use client';

/**
 * FreeTrialCard — the solo-agent free trial setting on the Plans page (BACKLOG-3860 PR-3).
 *
 * Every staff user who can see Plans sees the state (Off / On, N days) and the last change from
 * the audit log. Only a Super Admin (billing.pricebook, can_edit from admin_get_solo_trial_setting)
 * gets the Edit control; the server action and the database function check the capability again.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@keepr/ui';
import { auditActorLabel } from '@/lib/audit-actor';
import { formatDate } from '@/lib/format';
import { setSoloTrialAction } from '@/lib/actions/trialSetting';
import {
  TRIAL_DAYS_MAX,
  TRIAL_DAYS_MIN,
  TRIAL_NEW_ONLY_NOTE,
  checkTrialDays,
  trialChangeLabel,
  trialStateLabel,
  type SoloTrialAuditEntry,
  type SoloTrialSetting,
} from '@/lib/billing/trialSettingRules';

export interface FreeTrialCardProps {
  /** null when the setting could not be read. */
  setting: SoloTrialSetting | null;
  lastChange: SoloTrialAuditEntry | null;
  canEdit: boolean;
}

export function FreeTrialCard({ setting, lastChange, canEdit }: FreeTrialCardProps) {
  const [open, setOpen] = useState(false);
  const changeLabel = lastChange ? trialChangeLabel(lastChange.metadata) : null;

  return (
    <Card className="mt-6" data-testid="free-trial-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Free trial</CardTitle>
          <CardDescription>Solo agents who sign in to the desktop app for the first time.</CardDescription>
        </div>
        {canEdit && setting && (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="free-trial-edit">
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {setting ? (
          <p className="text-foreground" data-testid="free-trial-state">
            {trialStateLabel(setting)}
          </p>
        ) : (
          <p className="text-destructive" data-testid="free-trial-state">
            The free trial setting could not be loaded.
          </p>
        )}
        {lastChange ? (
          <p className="text-muted-foreground" data-testid="free-trial-last-change">
            Last changed by {auditActorLabel(lastChange)} on {formatDate(lastChange.created_at)}
            {changeLabel ? ` (${changeLabel})` : ''}
          </p>
        ) : (
          <p className="text-muted-foreground" data-testid="free-trial-last-change">
            No changes recorded.
          </p>
        )}
        <p className="text-muted-foreground" data-testid="free-trial-note">
          {TRIAL_NEW_ONLY_NOTE}
        </p>
      </CardContent>
      {canEdit && setting && open && (
        <FreeTrialDialog setting={setting} onClose={() => setOpen(false)} />
      )}
    </Card>
  );
}

function FreeTrialDialog({ setting, onClose }: { setting: SoloTrialSetting; onClose: () => void }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(setting.enabled);
  const [daysText, setDaysText] = useState(String(setting.days ?? 14));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checked = checkTrialDays(daysText);
  const target = checked.ok ? trialStateLabel({ enabled, days: checked.days }) : null;

  const review = () => {
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setError(null);
    setConfirming(true);
  };

  const save = async () => {
    if (!checked.ok) return;
    setSaving(true);
    setError(null);
    const result = await setSoloTrialAction(enabled, checked.days);
    setSaving(false);
    if (!result.ok) {
      setConfirming(false);
      setError(result.error);
      return;
    }
    onClose();
    router.refresh();
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Free trial</DialogTitle>
          <DialogDescription>{TRIAL_NEW_ONLY_NOTE}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="free-trial-enabled"
              checked={enabled}
              disabled={saving}
              onCheckedChange={(v) => { setEnabled(v === true); setConfirming(false); }}
            />
            <Label htmlFor="free-trial-enabled">Free trial on</Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="free-trial-days">Length in days ({TRIAL_DAYS_MIN} to {TRIAL_DAYS_MAX})</Label>
            <Input
              id="free-trial-days"
              inputMode="numeric"
              value={daysText}
              disabled={saving}
              onChange={(e) => { setDaysText(e.target.value); setConfirming(false); }}
              aria-invalid={!checked.ok}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="free-trial-error">
              {error}
            </p>
          )}
          {confirming && target && (
            <p className="text-sm text-foreground" data-testid="free-trial-confirm">
              Set the free trial to: {target}?
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {confirming ? (
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Confirm'}
            </Button>
          ) : (
            <Button onClick={review} disabled={saving}>
              Save
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
