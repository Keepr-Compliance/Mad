import { useState, useCallback } from 'react';
import { StyleSheet, TouchableOpacity, Text } from 'react-native';
import { colors } from '../../theme/colors';
import { spacing } from '../../theme/spacing';
import HelpModal from './HelpModal';

/**
 * Floating "?" support button (BACKLOG-2255).
 *
 * Matches the desktop SupportWidget: a fixed blue circle pinned bottom-left,
 * white bold "?" glyph, shadow. Opens the companion's existing HelpModal
 * (support-ticket flow). Render once per screen; it owns its own modal state.
 */
export default function SupportButton(): React.JSX.Element {
  const [visible, setVisible] = useState(false);

  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);

  return (
    <>
      <TouchableOpacity
        style={styles.button}
        onPress={open}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Open support dialog"
      >
        <Text style={styles.glyph}>?</Text>
      </TouchableOpacity>
      <HelpModal visible={visible} onClose={close} screenshotBase64={null} />
    </>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    left: spacing[4],
    bottom: spacing[4],
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.support.button,
    alignItems: 'center',
    justifyContent: 'center',
    // shadow-lg
    shadowColor: colors.black,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
    zIndex: 70,
  },
  glyph: {
    color: colors.white,
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 20,
  },
});
