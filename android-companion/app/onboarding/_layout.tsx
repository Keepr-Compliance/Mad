import { Stack } from 'expo-router';

/**
 * Onboarding stack layout.
 * Four-step flow: disclosure -> permissions -> pair device -> first sync.
 *
 * BACKLOG-1473: Reordered so permissions are granted before pairing,
 * allowing auto-first-sync to run immediately after pairing succeeds.
 *
 * BACKLOG-2956: `disclosure` is first. Google Play requires the prominent data
 * disclosure to precede the runtime permission prompt. This declaration order is
 * not itself the guarantee — a deep link or a stale resume marker could still
 * land on `permissions` — so the binding enforcement is the consent guard inside
 * permissions.tsx, which refuses to request a permission without recorded
 * consent no matter how the screen was reached.
 */
export default function OnboardingLayout(): React.JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
      }}
    >
      <Stack.Screen name="disclosure" />
      <Stack.Screen name="permissions" />
      <Stack.Screen name="pair-device" />
      <Stack.Screen name="first-sync" />
    </Stack>
  );
}
