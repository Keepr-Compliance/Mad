import { StyleSheet, View, Text } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors } from '../../theme/colors';

/**
 * Circular gradient avatar with a single initial (BACKLOG-2254).
 *
 * Diagonal blue-400 → purple-500 gradient, white bold initial derived from the
 * display name (fallback: email, then "?"). Used at 32px in the home header and
 * 64px on the Account screen.
 */

interface AvatarProps {
  /** Display name; first letter becomes the initial. */
  name?: string | null;
  /** Fallback used for the initial when name is empty. */
  email?: string | null;
  /** Diameter in px. Default 32. */
  size?: number;
}

/** First letter of name, else email, else "?" — always uppercase. */
export function initialFor(name?: string | null, email?: string | null): string {
  const source = (name?.trim() || email?.trim() || '').trim();
  const first = source.charAt(0);
  return first ? first.toUpperCase() : '?';
}

export default function Avatar({
  name,
  email,
  size = 32,
}: AvatarProps): React.JSX.Element {
  const initial = initialFor(name, email);
  // Scale the glyph with the circle (14px at 32 → ~0.44 ratio; 24px at 64).
  const fontSize = Math.round(size * 0.44);

  return (
    <LinearGradient
      colors={[colors.account.avatarStart, colors.account.avatarEnd]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[
        styles.circle,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <View style={styles.center}>
        <Text style={[styles.initial, { fontSize }]} allowFontScaling={false}>
          {initial}
        </Text>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    // subtle shadow
    shadowColor: colors.black,
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: {
    color: colors.white,
    fontWeight: '700',
  },
});
