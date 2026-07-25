import { useEffect, useState, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Alert,
  ActivityIndicator,
  ScrollView,
  TouchableOpacity,
  Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { stopBackgroundSync } from '../../services/backgroundSync';
import { signOut, getSession } from '../../services/authService';
import type { Session } from '@supabase/supabase-js';
import { colors } from '../../theme/colors';
import { spacing } from '../../theme/spacing';
import { Avatar } from '../../components/ui';

interface StoredPairing {
  ip: string;
  port: number;
  secret: string;
  deviceName: string;
  pairedAt: string;
}

const PAIRING_STORAGE_KEY = '@keepr/pairing';

/** Map Supabase provider identifiers to user-friendly display names. */
function formatProvider(provider: string | undefined): string {
  if (!provider) return 'Email';
  switch (provider) {
    case 'azure':
      return 'Microsoft';
    case 'google':
      return 'Google';
    case 'email':
      return 'Email';
    default:
      return provider;
  }
}

export default function AccountScreen(): React.JSX.Element {
  const router = useRouter();
  const [pairing, setPairing] = useState<StoredPairing | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(PAIRING_STORAGE_KEY), getSession()])
      .then(([stored, currentSession]) => {
        if (stored) {
          setPairing(JSON.parse(stored) as StoredPairing);
        }
        setSession(currentSession);
      })
      .catch((error) => {
        console.error('[Account] Failed to load data:', error);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const handleSignOut = useCallback((): void => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out? You will need to sign in again to use the app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            try {
              await stopBackgroundSync();
            } catch (error) {
              console.error('[Account] Failed to stop background sync:', error);
            }
            const result = await signOut();
            if (result.error) {
              Alert.alert('Sign Out Failed', result.error);
            }
            // Auth state change listener in _layout.tsx will redirect to login
          },
        },
      ],
    );
  }, []);

  const user = session?.user;
  const name =
    user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? '';
  const email = user?.email ?? '';
  const provider = formatProvider(user?.app_metadata?.provider);
  const userId = user?.id ?? '';

  // Gradient header bar — shared by loading and loaded states.
  const headerBar = (
    <LinearGradient
      colors={[colors.account.headerStart, colors.account.headerEnd]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={styles.headerBar}
    >
      <TouchableOpacity
        style={styles.backButton}
        onPress={() => router.back()}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Back"
      >
        <Text style={styles.backChevron}>{'‹'}</Text>
        <Text style={styles.backLabel}>Back</Text>
      </TouchableOpacity>
      <Text style={styles.headerTitle}>Account</Text>
    </LinearGradient>
  );

  if (loading) {
    return (
      <View style={styles.screen}>
        {headerBar}
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.account.headerStart} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {headerBar}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        style={styles.scrollView}
      >
        {/* Identity row */}
        <View style={styles.identityRow}>
          <Avatar name={name} email={email} size={64} />
          <View style={styles.identityText}>
            <Text style={styles.name} numberOfLines={1}>
              {name || email || 'Keepr User'}
            </Text>
            {email ? (
              <Text style={styles.email} numberOfLines={1}>
                {email}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Signed in with <provider> pill */}
        <View style={styles.pillRow}>
          <View style={styles.providerPill}>
            <Text style={styles.pillCheck}>{'✓'}</Text>
            <Text style={styles.pillText}>Signed in with {provider}</Text>
          </View>
        </View>

        {/* Connection chip — paired desktop (skip if unpaired) */}
        {pairing ? (
          <View style={styles.chipRow}>
            <View style={styles.pairedChip}>
              <Text style={styles.chipText} numberOfLines={1}>
                Paired with {pairing.deviceName}
              </Text>
            </View>
          </View>
        ) : null}

        {/* User ID row */}
        <View style={styles.idRow}>
          <Text style={styles.idLabel}>User ID</Text>
          <Text style={styles.idValue} numberOfLines={1} ellipsizeMode="middle">
            {userId || '--'}
          </Text>
        </View>

        {/* Settings button */}
        <TouchableOpacity
          style={styles.settingsButton}
          onPress={() => router.push('/(main)/settings')}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Text style={styles.buttonGlyph}>{'⚙️'}</Text>
          <Text style={styles.settingsButtonText}>Settings</Text>
        </TouchableOpacity>

        {/* Sign Out button */}
        <TouchableOpacity
          style={styles.signOutButton}
          onPress={handleSignOut}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Sign Out"
        >
          <Text style={styles.signOutButtonText}>Sign Out</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.white,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing[4],
    paddingTop: spacing[10],
    paddingBottom: spacing[4],
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 80,
  },
  backChevron: {
    color: colors.white,
    fontSize: 22,
    marginRight: spacing[1],
    lineHeight: 22,
  },
  backLabel: {
    color: colors.white,
    fontSize: 14,
    fontWeight: '500',
  },
  headerTitle: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '700',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing[4],
    paddingBottom: spacing[12],
  },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing[6],
  },
  identityText: {
    flex: 1,
    marginLeft: spacing[4],
  },
  name: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.account.name,
  },
  email: {
    fontSize: 14,
    color: colors.account.sub,
    marginTop: 2,
  },
  pillRow: {
    flexDirection: 'row',
    marginBottom: spacing[3],
  },
  providerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.account.pillBg,
    borderWidth: 1,
    borderColor: colors.account.pillBorder,
    borderRadius: 9999,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing['1.5'],
  },
  pillCheck: {
    fontSize: 14,
    color: colors.account.sub,
    marginRight: spacing[2],
  },
  pillText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.account.sub,
  },
  chipRow: {
    flexDirection: 'row',
    marginBottom: spacing[3],
  },
  pairedChip: {
    flexShrink: 1,
    backgroundColor: colors.account.chipBg,
    borderWidth: 1,
    borderColor: colors.account.chipBorder,
    borderRadius: 9999,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing['1.5'],
  },
  chipText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.account.chipText,
  },
  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: colors.account.rowBorder,
    marginBottom: spacing[6],
  },
  idLabel: {
    fontSize: 14,
    color: colors.account.sub,
    marginRight: spacing[3],
  },
  idValue: {
    flexShrink: 1,
    fontSize: 14,
    color: colors.account.name,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  settingsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    backgroundColor: colors.account.settingsBtn,
    borderRadius: 8,
    paddingVertical: 12,
    marginBottom: spacing[3],
  },
  buttonGlyph: {
    fontSize: 15,
    marginRight: spacing[2],
  },
  settingsButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
  signOutButton: {
    width: '100%',
    backgroundColor: colors.account.signOutBtn,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signOutButtonText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: '600',
  },
});
