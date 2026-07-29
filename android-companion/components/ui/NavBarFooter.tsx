import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../theme/colors';

/**
 * Solid footer surface behind the Android navigation bar (BACKLOG-2255).
 *
 * An absolutely-positioned strip pinned to the bottom of the screen, its height
 * = the bottom safe-area inset, filled with the screen's background color and
 * capped by a hairline top border. It sits ABOVE the scrolling content
 * (zIndex), so content scrolls behind it and visibly clips at its top edge
 * instead of bleeding under the transparent (edge-to-edge) nav bar.
 *
 * Render it as the LAST child of the screen container, after the ScrollView.
 * Pad the ScrollView's content by `insets.bottom` so the last control clears
 * the strip. The floating "?" SupportButton is offset by the same inset and
 * therefore floats above this strip.
 */

interface NavBarFooterProps {
  /** Strip fill color. Defaults to the home/settings screen background. */
  backgroundColor?: string;
}

export default function NavBarFooter({
  backgroundColor = colors.gray[50],
}: NavBarFooterProps): React.JSX.Element | null {
  const insets = useSafeAreaInsets();

  // Nothing to cover on devices with no bottom inset (gesture nav / no bar).
  if (insets.bottom <= 0) return null;

  return (
    <View
      pointerEvents="none"
      style={[styles.strip, { height: insets.bottom, backgroundColor }]}
    />
  );
}

const styles = StyleSheet.create({
  strip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.login.cardBorder, // #E7E8F0
    zIndex: 50,
  },
});
