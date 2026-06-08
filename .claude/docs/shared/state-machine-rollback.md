# State Machine Rollback Procedure

This document describes how to rollback from the new state machine to legacy behavior if issues arise.

---

## Quick Rollback (Per User)

For individual users experiencing issues, they can disable the state machine via browser DevTools:

```javascript
// In DevTools Console (F12 > Console)
localStorage.setItem('useNewStateMachine', 'false');
location.reload();
```

This immediately returns the user to legacy hook behavior.

### Re-enabling After Fix

```javascript
// Remove the override to return to default (enabled)
localStorage.removeItem('useNewStateMachine');
location.reload();

// Or explicitly enable
localStorage.setItem('useNewStateMachine', 'true');
location.reload();
```

---

## Full Rollback (Code Change)

If widespread issues require a code-level rollback:

### Step 1: Change Default

Edit `src/appCore/state/machine/utils/featureFlags.ts`:

```typescript
// Change from:
return true;  // Phase 2 default

// To:
return false; // Rollback to legacy
```

Also update `getFeatureFlagStatus()`:

```typescript
// Change from:
return { source: "default", value: true };

// To:
return { source: "default", value: false };
```

### Step 2: Update Tests

Edit `src/appCore/state/machine/utils/featureFlags.test.ts`:

- Change `"returns true by default"` to `"returns false by default"`
- Update all assertions for default behavior

### Step 3: Deploy

1. Commit changes
2. Create PR targeting affected branch
3. Deploy after review

### Step 4: Verify

After deployment, verify legacy behavior is active:
- No state machine debug panel (if in dev mode)
- Legacy hooks operating independently
- User preferences in localStorage still respected

---

## URL Override (Testing)

For testing both modes without code changes, use URL parameters:

```
# Force enable (for testing new features)
https://app.example.com/?newStateMachine=true

# Force disable (for testing rollback)
https://app.example.com/?newStateMachine=false
```

URL parameters take precedence over localStorage and default settings.

---

## Monitoring for Issues

### Signs the State Machine May Need Rollback

Watch for these issues after enabling:

| Issue | Symptom | Root Cause |
|-------|---------|------------|
| Database errors | "Database not initialized" | Race condition (should be fixed by state machine) |
| Onboarding flicker | Returning users see onboarding briefly | State hydration delay |
| Navigation loops | Stuck redirecting between pages | Step derivation issue |
| Stale data | UI not updating after actions | Event not dispatched |

### Decision Matrix

| Issue Severity | User Impact | Action |
|----------------|-------------|--------|
| Low (cosmetic) | Few users | Monitor, collect logs |
| Medium (functional) | Many users | Consider rollback |
| High (blocking) | All users | Immediate rollback |

### Before Rolling Back

1. **Collect diagnostics**: Check browser console for errors
2. **Check flag status**: `getFeatureFlagStatus()` in console
3. **Verify state**: Check if state machine is actually active
4. **Document issue**: Record reproduction steps

---

## Phased Re-enablement

After fixing issues found during rollback:

### Phase 1: Internal Testing

```javascript
// Enable for specific testers
localStorage.setItem('useNewStateMachine', 'true');
```

### Phase 2: Gradual Rollout

Keep default `false`, enable via localStorage for beta users.

### Phase 3: Full Enable

After validation, change default back to `true` in code.

---

## Flag Behavior Reference

| localStorage | URL Param | Result |
|--------------|-----------|--------|
| Not set | Not set | ENABLED (default) |
| `'true'` | Not set | ENABLED |
| `'false'` | Not set | DISABLED |
| Any | `'true'` | ENABLED |
| Any | `'false'` | DISABLED |

URL parameters always take precedence for testing purposes.

---

## Related Files

- Feature flag utilities: `src/appCore/state/machine/utils/featureFlags.ts`
- Feature flag tests: `src/appCore/state/machine/utils/featureFlags.test.ts`
- Behavior tests: `src/appCore/state/machine/__tests__/featureFlag.test.ts`
- Feature flag components: `src/appCore/state/machine/FeatureFlag.tsx`

---

## Contact

For questions about the state machine migration, see:
- Sprint documentation: query Supabase `pm_sprints` for the SPRINT-021 state-migration sprint (legacy archive: `.claude/plans/sprints/SPRINT-021-state-migration.md`)
- Integration tests: `src/appCore/state/machine/__tests__/*.integration.test.ts`
