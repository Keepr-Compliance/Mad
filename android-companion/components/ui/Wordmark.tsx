import { StyleSheet, Text, TextStyle } from 'react-native';
import { colors } from '../../theme/colors';

/**
 * Keepr wordmark — "Keepr" + an accent dot.
 *
 * Matched pixel-for-pixel to the live landing site (keeprcompliance.com):
 *   .wordmark { color:#101322; letter-spacing:-.03em; font-weight:800 }
 * with the trailing dot colored #f5a524.
 *
 * The font is the system sans stack (Roboto on Android — React Native's
 * default), so no font files are bundled. RN `letterSpacing` is an absolute
 * pixel value (not em), so we derive it proportionally from `size`:
 *   -0.03em × fontSize  (e.g. 22px → ≈ -0.66px).
 *
 * BACKLOG-2246.
 */

/** Landing letter-spacing is -0.03em; RN needs absolute px. */
const LETTER_SPACING_EM = -0.03;

interface WordmarkProps {
  /** Font size in px (default 22, matching the landing wordmark). */
  size?: number;
  /**
   * `dark` (default): dark text on light backgrounds.
   * `light`: white text for dark/indigo backgrounds. The dot stays orange.
   */
  variant?: 'dark' | 'light';
  /** Optional style overrides applied to the outer Text. */
  style?: TextStyle;
}

export default function Wordmark({
  size = 22,
  variant = 'dark',
  style,
}: WordmarkProps): React.JSX.Element {
  const wordColor = variant === 'light' ? colors.white : colors.brand.wordmark;

  return (
    <Text
      style={[
        styles.wordmark,
        {
          fontSize: size,
          letterSpacing: size * LETTER_SPACING_EM,
          color: wordColor,
        },
        style,
      ]}
      accessibilityRole="header"
      accessibilityLabel="Keepr"
      allowFontScaling={false}
    >
      Keepr
      <Text style={styles.dot}>.</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  wordmark: {
    fontWeight: '800',
    // Ensure the dot and word share the same baseline/weight.
    includeFontPadding: false,
  } as TextStyle,
  dot: {
    color: colors.brand.dot,
    fontWeight: '800',
  },
});
